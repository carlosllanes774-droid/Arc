/**
 * USDA FoodData Central — nutrition source of truth for Arc.
 */
(function (global) {
  'use strict';

  var ID = 'usda';
  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Cache = function () { return global.ArcApi && global.ArcApi.Cache; };
  var RateLimit = function () { return global.ArcApi && global.ArcApi.RateLimit; };

  /**
   * @param {object} raw
   * @returns {object}
   */
  function normalizeNutrition(raw) {
    raw = raw || {};
    return {
      protein: raw.protein != null ? raw.protein : null,
      fat: raw.fat != null ? raw.fat : null,
      carbs: raw.carbs != null ? raw.carbs : null,
      calories: raw.calories != null ? raw.calories : null,
      servingWeight: raw.servingWeight != null ? raw.servingWeight : raw.servingWeightGrams || null,
      fdcId: raw.fdcId || null,
      description: raw.description || null
    };
  }

  function proxyGet(path, cacheKey) {
    var b = Base();
    var url = (b.apiBaseUrl() || '') + path;
    var c = Cache();
    if (c && cacheKey) {
      var hit = c.get('ingredientValidation', cacheKey);
      if (hit) return Promise.resolve(hit);
    }
    var rl = RateLimit();
    var call = function () {
      return fetch(url, { method: 'GET', headers: { Accept: 'application/json' } }).then(function (resp) {
        return resp.json().then(function (json) {
          return { ok: resp.ok, status: resp.status, json: json };
        });
      });
    };
    var p = rl ? rl.withRetry(call) : call();
    return p.then(function (res) {
      if (c && cacheKey && res.ok) c.set('ingredientValidation', cacheKey, res);
      return res;
    });
  }

  /**
   * @param {{ query: string, pageSize?: number }} input
   * @returns {Promise<object>}
   */
  function searchIngredient(input) {
    var b = Base();
    input = input || {};
    var q = String(input.query || '').trim();
    if (!q) return Promise.resolve(b.fail(ID, 'source_of_truth', 'query required'));

    var cacheKey = 'search:' + q.toLowerCase();
    return proxyGet('/api/usda/search?q=' + encodeURIComponent(q) + '&pageSize=' + (input.pageSize || 5), cacheKey)
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) return b.notConfigured(ID, 'source_of_truth');
          return b.fail(ID, 'source_of_truth', (res.json && res.json.error) || 'USDA search failed');
        }
        return b.ok(ID, 'source_of_truth', {
          foods: (res.json && res.json.foods) || [],
          query: q
        });
      }).catch(function (err) {
        return b.fail(ID, 'source_of_truth', err && err.message ? err.message : 'Network error');
      });
  }

  /**
   * @param {{ fdcId: string|number }} input
   * @returns {Promise<object>}
   */
  function getFoodNutrition(input) {
    var b = Base();
    input = input || {};
    if (!input.fdcId) return Promise.resolve(b.fail(ID, 'nutrition_verification', 'fdcId required'));

    var cacheKey = 'fdc:' + input.fdcId;
    return proxyGet('/api/usda/food/' + encodeURIComponent(input.fdcId), cacheKey).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) return b.notConfigured(ID, 'nutrition_verification');
        return b.fail(ID, 'nutrition_verification', (res.json && res.json.error) || 'USDA food lookup failed');
      }
      return b.ok(ID, 'nutrition_verification', {
        normalized: normalizeNutrition(res.json && res.json.normalized),
        raw: res.json
      });
    }).catch(function (err) {
      return b.fail(ID, 'nutrition_verification', err && err.message ? err.message : 'Network error');
    });
  }

  /**
   * @param {{ description?: string, fdcId?: string, reported: object }} input
   * @returns {Promise<object>}
   */
  function verifyIngredientNutrition(input) {
    var b = Base();
    input = input || {};
    var reported = input.reported || {};
    var lookup = input.fdcId
      ? getFoodNutrition({ fdcId: input.fdcId })
      : searchIngredient({ query: input.description || input.query, pageSize: 1 }).then(function (sr) {
        if (sr.status !== 'ok' || !sr.data.foods.length) return sr;
        return getFoodNutrition({ fdcId: sr.data.foods[0].fdcId });
      });

    return lookup.then(function (usda) {
      if (usda.status !== 'ok') return usda;
      var truth = usda.data.normalized || {};
      var deltas = {};
      ['calories', 'protein', 'fat', 'carbs'].forEach(function (k) {
        var r = Number(reported[k]);
        var u = Number(truth[k]);
        if (!isFinite(r) || !isFinite(u) || u <= 0) deltas[k] = null;
        else deltas[k] = Math.round(Math.abs(r - u) / u * 1000) / 10;
      });
      return b.ok(ID, 'nutrition_verification', {
        usda: truth,
        reported: reported,
        deltaPercent: deltas,
        trusted: 'usda'
      });
    });
  }

  /**
   * @param {{ calories: number, protein: number, carbs: number, fat: number, ingredients?: Array<object> }} recipe
   * @returns {Promise<object>}
   */
  function validateRecipeNutrition(recipe) {
    return validateMacrosLocal(recipe).then(function (macroCheck) {
      if (Array.isArray(recipe.ingredients) && recipe.ingredients.length) {
        var first = recipe.ingredients[0];
        var name = first.name || first.description || first.original;
        if (name) {
          return searchIngredient({ query: name, pageSize: 1 }).then(function (sr) {
            return Base().ok(ID, 'macro_validation', {
              macroCheck: macroCheck.data,
              ingredientSample: sr.status === 'ok' ? sr.data.foods[0] : null,
              source: 'usda'
            });
          });
        }
      }
      return macroCheck;
    });
  }

  /**
   * Local heuristic + optional USDA lookup.
   * @param {{ calories: number, protein: number, carbs: number, fat: number, tolerance?: number }} input
   * @returns {Promise<object>}
   */
  function validateMacrosLocal(input) {
    var b = Base();
    input = input || {};
    var cals = Number(input.calories);
    var p = Number(input.protein) || 0;
    var c = Number(input.carbs) || 0;
    var f = Number(input.fat) || 0;
    if (!isFinite(cals) || cals <= 0) {
      return Promise.resolve(b.fail(ID, 'macro_validation', 'calories required'));
    }

    var computed = p * 4 + c * 4 + f * 9;
    var tolerance = Number(input.tolerance) || 0.12;
    var delta = Math.abs(computed - cals) / cals;
    var valid = delta <= tolerance;

    return Promise.resolve(b.ok(ID, 'macro_validation', {
      valid: valid,
      computedCalories: Math.round(computed),
      reportedCalories: Math.round(cals),
      deltaPercent: Math.round(delta * 1000) / 10,
      tolerancePercent: tolerance * 100,
      source: 'usda_rules'
    }));
  }

  var api = {
    id: ID,
    normalizeNutrition: normalizeNutrition,
    searchIngredient: searchIngredient,
    getFoodNutrition: getFoodNutrition,
    verifyIngredientNutrition: verifyIngredientNutrition,
    validateRecipeNutrition: validateRecipeNutrition,
    validateMacros: validateMacrosLocal
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.usda = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
