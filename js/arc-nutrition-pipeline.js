/**
 * Recipe nutrition pipeline — Spoonacular (when spoonacularId) or Edamam → USDA → Arc Validation.
 * OpenAI proposes meal structure; verified macros replace AI estimates before display.
 */
(function (global) {
  'use strict';

  function apiUrl(path) {
    if (global.ArcRuntime && global.ArcRuntime.apiUrl) return global.ArcRuntime.apiUrl(path);
    return path;
  }

  function normalizeLine(s) {
    var E = global.ArcApi && global.ArcApi.Edamam;
    if (E && E.normalizeIngredientLine) return E.normalizeIngredientLine(s);
    return String(s || '').trim();
  }

  /**
   * Join qty + name without duplicating when qty already contains the food name.
   * @param {string} qty
   * @param {string} name
   * @returns {string}
   */
  function joinQtyAndName(qty, name) {
    var q = normalizeLine(qty);
    var n = normalizeLine(name);
    if (!n) return q;
    if (!q) return n;
    var ql = q.toLowerCase();
    var nl = n.toLowerCase();
    if (ql === nl || ql.endsWith(' ' + nl) || ql.indexOf(nl) !== -1) return q;
    return normalizeLine(q + ' ' + n);
  }

  function ingredientLines(recipe) {
    recipe = recipe || {};
    var lines = [];

    if (Array.isArray(recipe.ingEdamam) && recipe.ingEdamam.length) {
      recipe.ingEdamam.forEach(function (line) {
        var n = normalizeLine(line);
        if (n) lines.push(n);
      });
    } else if (Array.isArray(recipe.ing)) {
      var keys = Array.isArray(recipe.ingKeys) ? recipe.ingKeys : [];
      recipe.ing.forEach(function (name, idx) {
        var line = normalizeLine(name);
        if (!line) return;
        var qtyKey = keys[idx];
        var qty = (qtyKey && recipe.ingQty && recipe.ingQty[qtyKey]) ||
          (recipe.ingQty && recipe.ingQty[name]);
        if (qty) line = joinQtyAndName(qty, line);
        lines.push(line);
      });
    }

    var E = global.ArcApi && global.ArcApi.Edamam;
    if (E && E.normalizeIngredientLines) return E.normalizeIngredientLines(lines);
    return lines.filter(Boolean);
  }

  function logEdamamDiagnostic(message, detail) {
    if (detail && typeof detail === 'object') {
      console.log('[ARC EDAMAM] ' + message, detail);
      return;
    }
    console.log('[ARC EDAMAM] ' + message);
  }

  /**
   * True only when a Spoonacular catalog id is stored (never local recipe.id).
   * @param {object} recipe
   * @returns {boolean}
   */
  function hasSpoonacularSourceId(recipe) {
    recipe = recipe || {};
    return recipe.spoonacularId != null && recipe.spoonacularId !== '';
  }

  /** @deprecated Use hasSpoonacularSourceId for routing; returns Spoonacular id only. */
  function spoonacularRecipeIdFor(recipe) {
    if (hasSpoonacularSourceId(recipe)) return recipe.spoonacularId;
    return null;
  }

  function logSpoonacularNutritionPath(message, detail) {
    detail = detail || {};
    console.log('[ARC NUTRITION]', Object.assign({
      path: 'spoonacular',
      skipEdamam: true,
      skipUsda: true,
      reason: detail.reason || 'spoonacular_id_present'
    }, detail));
  }

  function postJson(path, body) {
    var Trace = global.ArcApi && global.ArcApi.Trace;
    var providerId = Trace ? Trace.pathToProvider(path) : null;
    var operation = Trace ? Trace.pathOperation(path) : path;
    var startedAt = Trace ? Trace.nowIso() : null;
    var t0 = Trace ? Trace.timeStart() : 0;
    var baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };

    var doFetch = function (headers) {
      return fetch(apiUrl(path), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body || {})
      });
    };
    var req = (global.ArcApiBase && global.ArcApiBase.withAuthHeaders)
      ? global.ArcApiBase.withAuthHeaders(baseHeaders).then(doFetch)
      : doFetch(baseHeaders);

    return req.then(function (resp) {
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

  function macrosFromRecipeFields(recipe) {
    return {
      calories: Math.round(Number(recipe.cal) || 0),
      protein: Math.round(Number(recipe.p) || 0),
      carbs: Math.round(Number(recipe.c) || 0),
      fat: Math.round(Number(recipe.f) || 0)
    };
  }

  function hasUsableMacros(macros) {
    return !!(macros && isFinite(Number(macros.calories)) && Number(macros.calories) > 0);
  }

  function hasFullRecipeMacros(recipe) {
    return (
      Number(recipe.cal) > 0 &&
      Number(recipe.p) > 0 &&
      Number(recipe.c) > 0 &&
      Number(recipe.f) > 0
    );
  }

  /**
   * @param {{ source?: string, verified?: boolean, confidence?: string, fallbackUsed?: boolean, path?: string }} meta
   */
  function logNutritionOutcome(meta) {
    meta = meta || {};
    console.log('[ARC NUTRITION]', {
      path: meta.path != null ? meta.path : null,
      source: meta.source != null ? meta.source : null,
      verified: !!meta.verified,
      confidence: meta.confidence != null ? meta.confidence : null,
      fallbackUsed: !!meta.fallbackUsed,
      skipEdamam: meta.skipEdamam === true,
      skipUsda: meta.skipUsda === true,
      skipReason: meta.skipReason || null
    });
  }

  /**
   * Write pipeline macros onto recipe; does not choose fallback tier.
   * @param {object} recipe
   * @param {object} data — pipeline JSON (macros, source, nutritionConfidence, …)
   * @param {boolean} verified
   */
  function applyPipelineMacros(recipe, data, verified) {
    var macros = data.macros;
    recipe.cal = Math.round(macros.calories);
    recipe.p = Math.round(macros.protein);
    recipe.c = Math.round(macros.carbs);
    recipe.f = Math.round(macros.fat);
    recipe.nutritionSource = data.source || (verified ? 'verified' : 'unverified');
    recipe.nutritionVerified = !!verified;
    recipe.nutritionConfidence = data.nutritionConfidence || (verified ? 'high' : 'medium');
    if (Array.isArray(data.nutritionTags)) recipe.nutritionTags = data.nutritionTags;
    if (Array.isArray(data.validatedTags)) recipe.validatedTags = data.validatedTags;
  }

  /**
   * Category slot targets — only when no provider macros are available.
   */
  function applyCategorySlotFallback(recipe, fallback, reason) {
    if (fallback && isFinite(fallback.cal)) {
      recipe.cal = Math.round(fallback.cal);
      recipe.p = Math.round(fallback.p || 0);
      recipe.c = Math.round(fallback.c || 0);
      recipe.f = Math.round(fallback.f || 0);
    }
    recipe.nutritionVerified = false;
    recipe.nutritionSource = 'category_targets';
    recipe.nutritionConfidence = 'low';
    logNutritionOutcome({
      source: 'category_targets',
      verified: false,
      confidence: 'low',
      fallbackUsed: true
    });
    return Promise.resolve({
      recipe: recipe,
      verified: false,
      source: 'category_targets',
      validation: { safe: false, reason: reason }
    });
  }

  /**
   * Server returned macros but did not verify — keep provider analysis on the recipe.
   */
  function applyUnverifiedPipelineMacros(recipe, data, reason) {
    applyPipelineMacros(recipe, data, false);
    logNutritionOutcome({
      source: data.source || 'unverified',
      verified: false,
      confidence: recipe.nutritionConfidence,
      fallbackUsed: !!data.fallback,
      path: data.source === 'spoonacular' ? 'spoonacular' : 'edamam',
      skipEdamam: data.source === 'spoonacular',
      skipUsda: data.source === 'spoonacular',
      skipReason: data.skipReason
    });
    return Promise.resolve({
      recipe: recipe,
      verified: false,
      source: data.source || null,
      validation: data.validation || { safe: false, reason: reason || 'validation_failed' }
    });
  }

  function runClientArcValidation(macros) {
    var V = global.ArcApi && global.ArcApi.Validation;
    if (!V) return { safe: true };
    if (typeof V.runNutritionSanityChecks === 'function') {
      var sanity = V.runNutritionSanityChecks(macros);
      if (!sanity.valid) return { safe: false, reason: 'sanity_check_failed', sanity: sanity };
    }
    if (typeof V.detectImpossibleNutrition === 'function') {
      var check = V.detectImpossibleNutrition(Object.assign({}, macros, { context: 'meal' }));
      if (!check.safe) return { safe: false, reason: 'impossible_nutrition', check: check };
    }
    return { safe: true };
  }

  /**
   * Apply Spoonacular macros already on the recipe (bulk week path) with local Arc checks only.
   */
  function verifyRecipeFromLocalSpoonacularMacros(recipe, opts) {
    opts = opts || {};
    var fallback = opts.fallbackTargets || null;
    var macros = macrosFromRecipeFields(recipe);
    var spId = spoonacularRecipeIdFor(recipe);

    logSpoonacularNutritionPath('local Spoonacular macros — skipping Edamam/USDA HTTP', {
      recipe: recipe.name || 'Recipe',
      spoonacularId: spId,
      localId: recipe.id != null ? recipe.id : null,
      reason: 'spoonacular_macros_already_mapped'
    });

    if (!hasUsableMacros(macros)) {
      return applyCategorySlotFallback(recipe, fallback, 'missing_spoonacular_macros');
    }

    var validation = runClientArcValidation(macros);
    if (!validation.safe) {
      recipe.nutritionSource = 'spoonacular';
      recipe.nutritionVerified = false;
      recipe.nutritionConfidence = 'medium';
      logNutritionOutcome({
        path: 'spoonacular',
        source: 'spoonacular',
        verified: false,
        confidence: 'medium',
        fallbackUsed: false,
        skipEdamam: true,
        skipUsda: true,
        skipReason: 'spoonacular_macros_already_mapped'
      });
      return Promise.resolve({
        recipe: recipe,
        verified: false,
        source: 'spoonacular',
        validation: { safe: false, reason: validation.reason }
      });
    }

    applyPipelineMacros(recipe, {
      macros: macros,
      source: 'spoonacular',
      nutritionConfidence: 'high',
      skipReason: 'spoonacular_macros_already_mapped'
    }, true);

    logNutritionOutcome({
      path: 'spoonacular',
      source: 'spoonacular',
      verified: true,
      confidence: 'high',
      fallbackUsed: false,
      skipEdamam: true,
      skipUsda: true,
      skipReason: 'spoonacular_macros_already_mapped'
    });

    return Promise.resolve({
      recipe: recipe,
      verified: true,
      source: 'spoonacular',
      validation: { safe: true }
    });
  }

  /**
   * POST /api/nutrition/spoonacular-verify — Spoonacular fetch + Arc validation only.
   */
  function verifyRecipeWithSpoonacular(recipe, opts) {
    opts = opts || {};
    recipe = recipe || {};
    var fallback = opts.fallbackTargets || null;
    var spId = spoonacularRecipeIdFor(recipe);
    var reported = reportedFromRecipe(recipe);
    var localMacros = macrosFromRecipeFields(recipe);

    logSpoonacularNutritionPath('Spoonacular verify request — skipping Edamam/USDA', {
      recipe: recipe.name || 'Recipe',
      spoonacularId: spId,
      localId: recipe.id != null ? recipe.id : null,
      reason: 'spoonacular_id_present'
    });

    var Trace = global.ArcApi && global.ArcApi.Trace;
    if (Trace) Trace.logOrchestrator('spoonacular recipe verify started');

    return postJson('/api/nutrition/spoonacular-verify', {
      spoonacularRecipeId: spId,
      reported: reported,
      macros: hasFullRecipeMacros(recipe) ? localMacros : undefined,
      tags: recipe.tags || [],
      fiber: recipe.fiber
    }).then(function (res) {
      if (!res.ok || !res.json) {
        if (hasFullRecipeMacros(recipe) && String(recipe.nutritionSource || '') === 'spoonacular') {
          return verifyRecipeFromLocalSpoonacularMacros(recipe, opts);
        }
        if (Trace) Trace.logFallback('category_targets', 'spoonacular_verify_unavailable');
        return applyCategorySlotFallback(recipe, fallback, 'spoonacular_verify_unavailable');
      }

      var data = res.json;

      if (!data.verified) {
        if (hasUsableMacros(data.macros)) {
          return applyUnverifiedPipelineMacros(recipe, {
            macros: data.macros,
            source: 'spoonacular',
            nutritionConfidence: data.nutritionConfidence || 'medium',
            fallback: false,
            skipReason: data.skipReason || 'spoonacular_id_present',
            validation: data.validation
          }, data.reason || 'validation_failed');
        }
        if (Trace) Trace.logFallback('category_targets', data.reason || 'spoonacular_failed');
        return applyCategorySlotFallback(recipe, fallback, data.reason || 'spoonacular_failed');
      }

      if (!hasUsableMacros(data.macros)) {
        if (Trace) Trace.logFallback('category_targets', 'missing_calories');
        return applyCategorySlotFallback(recipe, fallback, 'missing_calories');
      }

      applyPipelineMacros(recipe, data, true);
      logNutritionOutcome({
        path: 'spoonacular',
        source: 'spoonacular',
        verified: true,
        confidence: recipe.nutritionConfidence,
        fallbackUsed: false,
        skipEdamam: true,
        skipUsda: true,
        skipReason: data.skipReason || 'spoonacular_id_present'
      });

      if (Trace) Trace.logMessage('Spoonacular nutrition verified — Edamam/USDA skipped');

      return {
        recipe: recipe,
        verified: true,
        source: 'spoonacular',
        validation: data.validation || null
      };
    }).catch(function () {
      if (hasFullRecipeMacros(recipe) && String(recipe.nutritionSource || '') === 'spoonacular') {
        return verifyRecipeFromLocalSpoonacularMacros(recipe, opts);
      }
      var TraceErr = global.ArcApi && global.ArcApi.Trace;
      if (TraceErr) TraceErr.logFallback('category_targets', 'network_error');
      return applyCategorySlotFallback(recipe, fallback, 'network_error');
    });
  }

  /**
   * Batch-finalize Spoonacular week recipes (local validation, no Edamam/USDA).
   * @param {Array<object>} recipes
   * @returns {Promise<Array<object>>}
   */
  function finalizeSpoonacularWeekRecipes(recipes) {
    recipes = recipes || [];
    var tasks = recipes.map(function (r) {
      if (!hasSpoonacularSourceId(r)) return Promise.resolve(r);
      if (hasFullRecipeMacros(r) && String(r.nutritionSource || '') === 'spoonacular') {
        return verifyRecipeFromLocalSpoonacularMacros(r, {}).then(function (result) {
          return result.recipe;
        });
      }
      return verifyRecipeWithSpoonacular(r, {}).then(function (result) {
        return result.recipe;
      });
    });
    return Promise.all(tasks);
  }

  /**
   * Edamam → USDA → Validation when no spoonacularId; Spoonacular path otherwise.
   * @param {object} recipe
   * @param {object} [opts]
   * @returns {Promise<{ recipe: object, verified: boolean, source: string|null, validation: object|null }>}
   */
  function verifyRecipe(recipe, opts) {
    opts = opts || {};
    recipe = recipe || {};
    var fallback = opts.fallbackTargets || null;
    var spId = spoonacularRecipeIdFor(recipe);

    if (hasSpoonacularSourceId(recipe)) {
      if (
        hasFullRecipeMacros(recipe) &&
        String(recipe.nutritionSource || '') === 'spoonacular' &&
        opts.preferLocalSpoonacularMacros
      ) {
        return verifyRecipeFromLocalSpoonacularMacros(recipe, opts);
      }
      return verifyRecipeWithSpoonacular(recipe, opts);
    }

    var ingr = ingredientLines(recipe);
    var reported = reportedFromRecipe(recipe);

    logEdamamDiagnostic('ingredient lines sent (Edamam/USDA path)', {
      recipe: recipe.name || 'Recipe',
      localId: recipe.id != null ? recipe.id : null,
      spoonacularId: spId,
      lineCount: ingr.length,
      lines: ingr.slice(0, 12)
    });

    if (!ingr.length) {
      logNutritionOutcome({
        path: 'edamam',
        source: 'openai',
        verified: false,
        confidence: recipe.nutritionConfidence || 'medium',
        fallbackUsed: false
      });
      return Promise.resolve({
        recipe: recipe,
        verified: false,
        source: null,
        validation: { safe: false, reason: 'no_ingredients' }
      });
    }

    var Trace = global.ArcApi && global.ArcApi.Trace;
    if (Trace) Trace.logOrchestrator('recipe verify started (Edamam/USDA)');

    return postJson('/api/nutrition/pipeline', {
      title: recipe.name || 'Recipe',
      ingr: ingr,
      reported: reported,
      spoonacularRecipeId: spId
    }).then(function (res) {
      if (!res.ok || !res.json) {
        if (Trace) Trace.logFallback('category_targets', 'pipeline_unavailable');
        return applyCategorySlotFallback(recipe, fallback, 'pipeline_unavailable');
      }

      var data = res.json;

      if (data.fallback && hasUsableMacros(data.macros)) {
        applyPipelineMacros(recipe, data, false);
        if (Trace) Trace.logFallback(data.source || 'usda', 'edamam_failed');
        logNutritionOutcome({
          path: 'edamam',
          source: data.source || 'fallback',
          verified: false,
          confidence: recipe.nutritionConfidence,
          fallbackUsed: true
        });
        return {
          recipe: recipe,
          verified: false,
          source: data.source,
          validation: data.validation || { safe: false, reason: 'edamam_fallback' }
        };
      }

      if (!data.verified) {
        if (hasUsableMacros(data.macros)) {
          if (Trace && data.reason === 'validation_failed') {
            Trace.logMessage('USDA validation failed');
          }
          return applyUnverifiedPipelineMacros(recipe, data, data.reason || 'validation_failed');
        }
        if (Trace && data.reason === 'validation_failed') {
          Trace.logMessage('USDA validation failed');
        }
        if (Trace) Trace.logFallback('category_targets', data.reason || 'validation_failed');
        return applyCategorySlotFallback(recipe, fallback, data.reason || 'validation_failed');
      }

      if (!hasUsableMacros(data.macros)) {
        if (Trace) Trace.logFallback('category_targets', data.reason || 'missing_calories');
        return applyCategorySlotFallback(recipe, fallback, data.reason || 'missing_calories');
      }

      var V = global.ArcApi && global.ArcApi.Validation;
      if (V && typeof V.detectImpossibleNutrition === 'function') {
        var check = V.detectImpossibleNutrition(Object.assign({}, data.macros, { context: 'meal' }));
        if (!check.safe) {
          if (Trace) Trace.logMessage('USDA validation failed');
          if (Trace) Trace.logFallback('category_targets', 'impossible_nutrition');
          return applyUnverifiedPipelineMacros(recipe, data, 'impossible_nutrition');
        }
      }

      if (Trace) Trace.logMessage('Final meal generation complete');

      applyPipelineMacros(recipe, data, true);
      logNutritionOutcome({
        path: 'edamam',
        source: data.source || 'verified',
        verified: true,
        confidence: recipe.nutritionConfidence,
        fallbackUsed: !!data.fallback
      });

      return {
        recipe: recipe,
        verified: true,
        source: data.source,
        validation: data.validation || null
      };
    }).catch(function () {
      var TraceErr = global.ArcApi && global.ArcApi.Trace;
      if (TraceErr) TraceErr.logFallback('category_targets', 'network_error');
      return applyCategorySlotFallback(recipe, fallback, 'network_error');
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
      var preferLocal =
        hasSpoonacularSourceId(out[i]) &&
        hasFullRecipeMacros(out[i]) &&
        String(out[i].nutritionSource || '') === 'spoonacular';
      return verifyRecipe(out[i], {
        fallbackTargets: catFb,
        preferLocalSpoonacularMacros: preferLocal
      }).then(function (result) {
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
    finalizeSpoonacularWeekRecipes: finalizeSpoonacularWeekRecipes,
    verifyRecipeWithSpoonacular: verifyRecipeWithSpoonacular,
    verifyRecipeFromLocalSpoonacularMacros: verifyRecipeFromLocalSpoonacularMacros,
    hasSpoonacularSourceId: hasSpoonacularSourceId,
    ingredientLines: ingredientLines,
    joinQtyAndName: joinQtyAndName,
    spoonacularRecipeIdFor: spoonacularRecipeIdFor,
    hasUsableMacros: hasUsableMacros,
    logNutritionOutcome: logNutritionOutcome
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
