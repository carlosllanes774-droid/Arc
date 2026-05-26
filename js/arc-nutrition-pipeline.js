/**
 * Recipe nutrition pipeline — Edamam → USDA verify → Arc Validation → display.
 * OpenAI proposes meal structure; verified macros replace AI estimates before display.
 */
(function (global) {
  'use strict';

  function apiUrl(path) {
    if (global.ArcRuntime && global.ArcRuntime.apiUrl) return global.ArcRuntime.apiUrl(path);
    return path;
  }

  function ingredientLines(recipe) {
    var lines = [];
    if (Array.isArray(recipe.ing)) {
      recipe.ing.forEach(function (name) {
        var line = String(name || '').trim();
        if (!line) return;
        if (recipe.ingQty && recipe.ingQty[name]) {
          line = recipe.ingQty[name] + ' ' + line;
        }
        lines.push(line);
      });
    }
    return lines.filter(Boolean);
  }

  function postJson(path, body) {
    var Trace = global.ArcApi && global.ArcApi.Trace;
    var providerId = Trace ? Trace.pathToProvider(path) : null;
    var operation = Trace ? Trace.pathOperation(path) : path;
    var startedAt = Trace ? Trace.nowIso() : null;
    var t0 = Trace ? Trace.timeStart() : 0;

    return fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (resp) {
      return resp.json().then(function (json) {
        var res = { ok: resp.ok, status: resp.status, json: json };
        if (Trace && providerId) Trace.logProxy(providerId, operation, res, startedAt, t0);
        return res;
      });
    }).catch(function (err) {
      if (Trace && providerId) {
        Trace.logProvider({
          providerId: providerId,
          outcome: 'failed',
          message: 'failed',
          success: false,
          status: 'error',
          startedAt: startedAt,
          completedAt: Trace.nowIso(),
          durationMs: Trace.msSince(t0),
          fallback: false,
          includeZeroMs: true
        });
      }
      throw err;
    });
  }

  /**
   * @param {{ cal?: number, p?: number, c?: number, f?: number }} recipe
   * @returns {{ calories: number, protein: number, carbs: number, fat: number }}
   */
  function reportedFromRecipe(recipe) {
    return {
      calories: Math.round(Number(recipe.cal) || 0),
      protein: Math.round(Number(recipe.p) || 0),
      carbs: Math.round(Number(recipe.c) || 0),
      fat: Math.round(Number(recipe.f) || 0)
    };
  }

  /**
   * Run Edamam → USDA → Validation for one recipe.
   * @param {object} recipe
   * @param {object} [opts]
   * @returns {Promise<{ recipe: object, verified: boolean, source: string|null, validation: object|null }>}
   */
  function verifyRecipe(recipe, opts) {
    opts = opts || {};
    recipe = recipe || {};
    var ingr = ingredientLines(recipe);
    var reported = reportedFromRecipe(recipe);
    var fallback = opts.fallbackTargets || null;

    if (!ingr.length) {
      return Promise.resolve({
        recipe: recipe,
        verified: false,
        source: null,
        validation: { safe: false, reason: 'no_ingredients' }
      });
    }

    var Trace = global.ArcApi && global.ArcApi.Trace;
    if (Trace) Trace.logOrchestrator('recipe verify started');

    return postJson('/api/nutrition/pipeline', {
      title: recipe.name || 'Recipe',
      ingr: ingr,
      reported: reported
    }).then(function (res) {
      if (!res.ok || !res.json) {
        if (Trace) Trace.logFallback('category_targets', 'pipeline_unavailable');
        return applyFallback(recipe, fallback, 'pipeline_unavailable');
      }

      var data = res.json;
      if (!data.verified || !data.macros) {
        if (Trace && (data.reason === 'validation_failed' || !data.verified)) {
          Trace.logMessage('USDA validation failed');
        }
        if (Trace) Trace.logFallback('category_targets', data.reason || 'validation_failed');
        return applyFallback(recipe, fallback, data.reason || 'validation_failed');
      }

      var V = global.ArcApi && global.ArcApi.Validation;
      if (V && typeof V.detectImpossibleNutrition === 'function') {
        var check = V.detectImpossibleNutrition(Object.assign({}, data.macros, { context: 'meal' }));
        if (!check.safe) {
          if (Trace) Trace.logMessage('USDA validation failed');
          if (Trace) Trace.logFallback('category_targets', 'impossible_nutrition');
          return applyFallback(recipe, fallback, 'impossible_nutrition');
        }
      }

      if (Trace) Trace.logMessage('Final meal generation complete');

      recipe.cal = Math.round(data.macros.calories);
      recipe.p = Math.round(data.macros.protein);
      recipe.c = Math.round(data.macros.carbs);
      recipe.f = Math.round(data.macros.fat);
      recipe.nutritionSource = data.source || 'verified';
      recipe.nutritionVerified = true;

      return {
        recipe: recipe,
        verified: true,
        source: data.source,
        validation: data.validation || null
      };
    }).catch(function () {
      var TraceErr = global.ArcApi && global.ArcApi.Trace;
      if (TraceErr) TraceErr.logFallback('category_targets', 'network_error');
      return applyFallback(recipe, fallback, 'network_error');
    });
  }

  function applyFallback(recipe, fallback, reason) {
    if (fallback && isFinite(fallback.cal)) {
      recipe.cal = Math.round(fallback.cal);
      recipe.p = Math.round(fallback.p || 0);
      recipe.c = Math.round(fallback.c || 0);
      recipe.f = Math.round(fallback.f || 0);
    }
    recipe.nutritionVerified = false;
    recipe.nutritionSource = reason || 'unverified';
    return Promise.resolve({
      recipe: recipe,
      verified: false,
      source: null,
      validation: { safe: false, reason: reason }
    });
  }

  /**
   * @param {Array<object>} recipes
   * @param {object} mealTargets from computeMealNutritionTargets
   * @param {number} [concurrency]
   * @returns {Promise<Array<object>>}
   */
  function verifyRecipes(recipes, mealTargets, concurrency) {
    recipes = recipes || [];
    concurrency = concurrency || 3;
    var idx = 0;
    var out = recipes.slice();

    function categoryFallback(recipe) {
      var cat = recipe.cat || 'Lunch';
      if (mealTargets && mealTargets[cat]) return mealTargets[cat];
      if (mealTargets && mealTargets.perSlot) return mealTargets.perSlot;
      return null;
    }

    function worker() {
      var i = idx++;
      if (i >= out.length) return Promise.resolve();
      var catFb = categoryFallback(out[i]);
      return verifyRecipe(out[i], { fallbackTargets: catFb }).then(function (result) {
        out[i] = result.recipe;
        return worker();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.min(concurrency, out.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return out; });
  }

  global.ArcNutritionPipeline = {
    verifyRecipe: verifyRecipe,
    verifyRecipes: verifyRecipes,
    ingredientLines: ingredientLines
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
