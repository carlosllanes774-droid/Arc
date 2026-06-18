/**
 * Edamam — food understanding, parsing, recipe nutrition analysis, diet labels.
 */
(function (global) {
  'use strict';

  var ID = 'edamam';
  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Cache = function () { return global.ArcApi && global.ArcApi.Cache; };
  var RateLimit = function () { return global.ArcApi && global.ArcApi.RateLimit; };
  var Edamam = function () { return global.ArcApi && global.ArcApi.Edamam; };
  var Trace = function () { return global.ArcApi && global.ArcApi.Trace; };

  function normalizeFoodData(item) {
    item = item || {};
    return {
      foodId: item.foodId || item.food_id || null,
      label: item.label || item.text || '',
      quantity: item.quantity != null ? item.quantity : null,
      measure: item.measure || item.unit || null,
      nutrients: item.nutrients || null,
      category: item.category || null,
      brand: item.brand || null
    };
  }

  function normalizeNutrients(totalNutrients) {
    if (!totalNutrients) return { calories: null, protein: null, fat: null, carbs: null };
    return {
      calories: totalNutrients.calories != null ? totalNutrients.calories : null,
      protein: totalNutrients.protein != null ? totalNutrients.protein : null,
      fat: totalNutrients.fat != null ? totalNutrients.fat : null,
      carbs: totalNutrients.carbs != null ? totalNutrients.carbs : null
    };
  }

  function cachedProxy(path, body, cacheNs, cacheKey) {
    var b = Base();
    var c = Cache();
    if (c && cacheKey) {
      var hit = c.get(cacheNs, cacheKey);
      if (hit) return Promise.resolve(hit);
    }
    var rl = RateLimit();
    var call = function () { return b.postJson(path, body); };
    var p = rl ? rl.withRetry(call) : call();
    return p.then(function (res) {
      if (c && cacheKey && res.ok) c.set(cacheNs, cacheKey, res);
      return res;
    });
  }

  /**
   * Natural language / ingredient line parsing.
   * @param {{ text: string }} input
   * @returns {Promise<object>}
   */
  function parseFoodInput(input) {
    var b = Base();
    input = input || {};
    var text = String(input.text || '').trim();
    if (!text) return Promise.resolve(b.fail(ID, 'ingredient_parsing', 'text required'));

    var cacheKey = 'parse:' + text.toLowerCase();
    return cachedProxy('/api/edamam/parse', { text: text }, 'parsedFoods', cacheKey).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) return b.notConfigured(ID, 'ingredient_parsing');
        return b.fail(ID, 'ingredient_parsing', (res.json && res.json.error) || 'Edamam parse failed');
      }
      var foods = (res.json && res.json.foods) || [];
      return b.ok(ID, 'ingredient_parsing', {
        foods: foods.map(normalizeFoodData),
        ingr: res.json.ingr || []
      });
    }).catch(function (err) {
      return b.fail(ID, 'ingredient_parsing', err && err.message ? err.message : 'Network error');
    });
  }

  /**
   * @param {{ title?: string, ingr: string[] }} input
   * @returns {Promise<object>}
   */
  function normalizeIngr(input) {
    var E = Edamam();
    if (E && E.normalizeIngredientLines) {
      var raw = Array.isArray(input.ingr) ? input.ingr : input.ingredients;
      return E.normalizeIngredientLines(Array.isArray(raw) ? raw : []);
    }
    var ingr = Array.isArray(input.ingr) ? input.ingr : input.ingredients;
    return Array.isArray(ingr) ? ingr.map(function (s) { return String(s || '').trim(); }).filter(Boolean) : [];
  }

  function logEdamamClientFailure(res) {
    var E = Edamam();
    var T = Trace();
    if (!E || !T) return;
    var kind = 'other';
    if (res && res.json && res.json.failureKind) {
      kind = res.json.failureKind;
    } else if (res && res.status === 401) {
      kind = 'auth';
    } else if (res && res.status === 400) {
      kind = 'payload';
    } else if (res && res.status >= 400 && res.status < 500) {
      kind = 'endpoint';
    }
    E.logEdamamFailure(T, kind, {
      httpStatus: res && res.status,
      endpoint: E.EDAMAM_NUTRITION_ENDPOINT,
      operation: 'recipe_nutrition_analysis',
      bodyPreview: res && res.json && res.json.detail ? E.sanitizeEdamamBody(res.json.detail, 200) : null
    });
  }

  function nutritionFromUsdaFallback(ingr) {
    var b = Base();
    var usda = global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.usda;
    if (!usda || !ingr.length) return Promise.resolve(null);
    var T = Trace();
    var line = ingr[0];
    return usda.searchIngredient({ query: line, pageSize: 1 }).then(function (sr) {
      if (sr.status !== 'ok' || !sr.data.foods.length) return null;
      return usda.getFoodNutrition({ fdcId: sr.data.foods[0].fdcId }).then(function (fn) {
        if (fn.status !== 'ok') return null;
        if (T) T.logFallback('usda', 'edamam_failed');
        return {
          normalized: fn.data.normalized,
          source: 'usda',
          nutritionConfidence: 'low',
          fallback: true
        };
      });
    }).catch(function () {
      return null;
    });
  }

  function nutritionFromSpoonacularFallback(input) {
    var spoon = global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.spoonacular;
    var recipeId = input.spoonacularRecipeId || input.recipeId;
    if (!spoon || !recipeId) return Promise.resolve(null);
    var T = Trace();
    return spoon.getRecipeBulk({ ids: [recipeId], includeNutrition: true }).then(function (r) {
      if (r.status !== 'ok' || !r.data.recipes.length) return null;
      var rec = r.data.recipes[0];
      var macros = rec.nutrition || (rec.calories != null
        ? { calories: rec.calories, protein: rec.protein, carbs: rec.carbs, fat: rec.fat }
        : null);
      if (!macros || !macros.calories) return null;
      if (T) T.logFallback('spoonacular', 'edamam_failed');
      return {
        normalized: macros,
        source: 'spoonacular',
        nutritionConfidence: 'low',
        fallback: true
      };
    }).catch(function () {
      return null;
    });
  }

  function analyzeRecipeNutrition(input) {
    var b = Base();
    input = input || {};
    var ingr = normalizeIngr(input);
    if (!ingr.length) return Promise.resolve(b.fail(ID, 'recipe_nutrition_analysis', 'ingr must be a non-empty array'));

    var body = {
      title: input.title || 'Recipe',
      ingr: ingr,
      spoonacularRecipeId: input.spoonacularRecipeId || input.recipeId || null
    };
    var cacheKey = 'nutrition:' + body.title + ':' + ingr.join('|');
    return cachedProxy('/api/nutrition', body, 'parsedFoods', cacheKey)
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) return b.notConfigured(ID, 'recipe_nutrition_analysis');
          logEdamamClientFailure(res);
          return nutritionFromSpoonacularFallback(input).then(function (fb) {
            if (fb) {
              return b.ok(ID, 'recipe_nutrition_analysis', {
                totalNutrients: fb.normalized,
                normalized: fb.normalized,
                source: fb.source,
                nutritionConfidence: fb.nutritionConfidence,
                fallback: true,
                dietLabels: [],
                healthLabels: []
              });
            }
            return nutritionFromUsdaFallback(ingr).then(function (usdaFb) {
              if (usdaFb) {
                return b.ok(ID, 'recipe_nutrition_analysis', {
                  totalNutrients: usdaFb.normalized,
                  normalized: usdaFb.normalized,
                  source: usdaFb.source,
                  nutritionConfidence: usdaFb.nutritionConfidence,
                  fallback: true,
                  dietLabels: [],
                  healthLabels: []
                });
              }
              return b.fail(ID, 'recipe_nutrition_analysis', (res.json && res.json.error) || 'Edamam nutrition failed');
            });
          });
        }
        var isFallback = !!(res.json && res.json.fallback);
        return b.ok(ID, 'recipe_nutrition_analysis', {
          totalNutrients: res.json.totalNutrients || null,
          notModified: !!res.json.notModified,
          source: (res.json && res.json.source) || 'edamam',
          normalized: normalizeNutrients(res.json.totalNutrients),
          dietLabels: res.json.dietLabels || [],
          healthLabels: res.json.healthLabels || [],
          nutritionConfidence: isFallback ? 'low' : ((res.json && res.json.nutritionConfidence) || 'high'),
          fallback: isFallback
        });
      }).catch(function (err) {
        return nutritionFromSpoonacularFallback(input).then(function (fb) {
          if (fb) {
            return b.ok(ID, 'recipe_nutrition_analysis', {
              totalNutrients: fb.normalized,
              normalized: fb.normalized,
              source: fb.source,
              nutritionConfidence: fb.nutritionConfidence,
              fallback: true,
              dietLabels: [],
              healthLabels: []
            });
          }
          return nutritionFromUsdaFallback(ingr).then(function (usdaFb) {
            if (usdaFb) {
              return b.ok(ID, 'recipe_nutrition_analysis', {
                totalNutrients: usdaFb.normalized,
                normalized: usdaFb.normalized,
                source: usdaFb.source,
                nutritionConfidence: usdaFb.nutritionConfidence,
                fallback: true,
                dietLabels: [],
                healthLabels: []
              });
            }
            return b.fail(ID, 'recipe_nutrition_analysis', err && err.message ? err.message : 'Network error');
          });
        });
      });
  }

  /**
   * @param {{ text: string, context?: object }} input
   * @returns {Promise<object>}
   */
  function understandIngredients(input) {
    return parseFoodInput(input).then(function (r) {
      if (r.status !== 'ok') return r;
      return Base().ok(ID, 'food_understanding', {
        understood: r.data.foods,
        ingrLines: r.data.ingr,
        context: input.context || null
      });
    });
  }

  /**
   * @param {{ ingr?: string[], title?: string }} input
   * @returns {Promise<object>}
   */
  function dietLabels(input) {
    return analyzeRecipeNutrition(input).then(function (r) {
      if (r.status !== 'ok') return r;
      return Base().ok(ID, 'diet_labels', {
        dietLabels: r.data.dietLabels || [],
        healthLabels: r.data.healthLabels || []
      });
    });
  }

  /**
   * @param {object} item
   * @returns {object}
   */
  function normalizeFoodDataExport(item) {
    return normalizeFoodData(item);
  }

  var api = {
    id: ID,
    parseFoodInput: parseFoodInput,
    analyzeRecipeNutrition: analyzeRecipeNutrition,
    understandIngredients: understandIngredients,
    dietLabels: dietLabels,
    normalizeFoodData: normalizeFoodDataExport
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.edamam = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
