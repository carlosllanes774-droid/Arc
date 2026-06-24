/**
 * OpenAI week-library ingredient quantity audit and repair helpers.
 * Validation + merge only — repair AI calls live in index.html (callAIWithRetry).
 */
(function (global) {
  'use strict';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function trimName(name) {
    return String(name == null ? '' : name).trim();
  }

  function nonEmptyQty(v) {
    return String(v == null ? '' : v).trim();
  }

  /**
   * @param {object} recipe
   * @returns {{ ingCount: number, ingQtyCount: number, matchedCount: number, missing: string[], complete: boolean, needsQuantityRepair: boolean }}
   */
  function auditRecipeIngredientQuantities(recipe) {
    recipe = recipe || {};
    var ings = Array.isArray(recipe.ing) ? recipe.ing : [];
    var iq = isPlainObject(recipe.ingQty) ? recipe.ingQty : {};
    var names = [];
    var missing = [];
    var matchedCount = 0;

    for (var i = 0; i < ings.length; i++) {
      var name = trimName(ings[i]);
      if (!name) continue;
      names.push(name);
      var qty = Object.prototype.hasOwnProperty.call(iq, name) ? nonEmptyQty(iq[name]) : '';
      if (qty) matchedCount++;
      else missing.push(name);
    }

    var ingQtyCount = 0;
    Object.keys(iq).forEach(function (k) {
      if (nonEmptyQty(iq[k])) ingQtyCount++;
    });

    var ingCount = names.length;
    var complete = ingCount > 0 &&
      matchedCount === ingCount &&
      ingQtyCount === ingCount &&
      missing.length === 0;

    return {
      ingCount: ingCount,
      ingQtyCount: ingQtyCount,
      matchedCount: matchedCount,
      missing: missing,
      complete: complete,
      needsQuantityRepair: ingCount > 0 && !complete
    };
  }

  /**
   * True when week library did not come from Spoonacular (quantities built in mapper).
   * @param {object} [meta]
   * @returns {boolean}
   */
  function isOpenAiWeekLibraryMeta(meta) {
    if (!meta) return true;
    var src = String(meta.source || '').toLowerCase();
    if (src === 'spoonacular') return false;
    return true;
  }

  /**
   * @param {object[]} recipes
   * @returns {{ index: number, recipe: object, audit: object }[]}
   */
  function recipesNeedingQuantityRepair(recipes) {
    var out = [];
    recipes = Array.isArray(recipes) ? recipes : [];
    for (var i = 0; i < recipes.length; i++) {
      var audit = auditRecipeIngredientQuantities(recipes[i]);
      if (audit.needsQuantityRepair) {
        out.push({ index: i, recipe: recipes[i], audit: audit });
      }
    }
    return out;
  }

  /**
   * Align patch keys to canonical ing names (case-insensitive).
   * @param {object} patch
   * @param {string[]} targetNames
   * @returns {object}
   */
  function normalizePatchToIngredientNames(patch, targetNames) {
    patch = isPlainObject(patch) ? patch : {};
    targetNames = Array.isArray(targetNames) ? targetNames : [];
    var lowerMap = {};
    for (var i = 0; i < targetNames.length; i++) {
      var n = trimName(targetNames[i]);
      if (n) lowerMap[n.toLowerCase()] = n;
    }
    var out = {};
    Object.keys(patch).forEach(function (k) {
      var v = nonEmptyQty(patch[k]);
      if (!v) return;
      var canon = lowerMap[k.toLowerCase()];
      if (canon) out[canon] = v;
    });
    return out;
  }

  /**
   * Merge repaired ingQty entries into recipe (preserves existing keys).
   * @param {object} recipe
   * @param {object} patch
   * @param {string[]} [allowedNames] — if set, only these keys are merged
   * @returns {object}
   */
  function mergeRepairedIngredientQty(recipe, patch, allowedNames) {
    if (!recipe) return recipe;
    patch = normalizePatchToIngredientNames(patch, allowedNames || (recipe.ing || []));
    if (!isPlainObject(recipe.ingQty)) recipe.ingQty = {};
    Object.keys(patch).forEach(function (k) {
      if (Array.isArray(allowedNames) && allowedNames.indexOf(k) === -1) return;
      recipe.ingQty[k] = patch[k];
    });
    return recipe;
  }

  /**
   * @param {object} recipe
   * @param {string[]} missingIngredients
   * @returns {{ sysMsg: string, userMsg: string }}
   */
  function buildIngredientQtyRepairPrompt(recipe, missingIngredients) {
    recipe = recipe || {};
    missingIngredients = Array.isArray(missingIngredients) ? missingIngredients.filter(function (n) {
      return trimName(n);
    }) : [];
    var sysMsg = 'You are an expert recipe quantity estimator. Respond with ONLY valid JSON. No markdown. Start with { end with }. ' +
      'Return a single object: {"ingQty":{...}} with realistic cooking amounts for EVERY ingredient listed. ' +
      'Keys in ingQty MUST exactly match the ingredient strings provided (same spelling and capitalization). ' +
      'Values must be practical amounts with units (e.g. "6 oz", "1/2 cup", "3 large").';
    var servings = Math.max(1, parseInt(recipe.servings, 10) || 1);
    var userMsg = 'Recipe: "' + (trimName(recipe.name) || 'Recipe') + '"\n';
    userMsg += 'Servings: ' + servings + '\n';
    userMsg += 'Ingredients needing amounts:\n';
    for (var i = 0; i < missingIngredients.length; i++) {
      userMsg += '- ' + missingIngredients[i] + '\n';
    }
    userMsg += '\nReturn ONLY: {"ingQty":{"Ingredient":"amount",...}}\n';
    userMsg += 'Include exactly ' + missingIngredients.length + ' entries — one per ingredient listed above.';
    return { sysMsg: sysMsg, userMsg: userMsg };
  }

  /**
   * @param {*} raw
   * @param {function} [parseJSONFn]
   * @returns {object|null}
   */
  function parseIngredientQtyRepairPatch(raw, parseJSONFn) {
    if (raw == null) return null;
    var parsed = null;
    if (isPlainObject(raw)) parsed = raw;
    else if (typeof parseJSONFn === 'function') parsed = parseJSONFn(String(raw));
    else {
      try {
        parsed = JSON.parse(String(raw));
      } catch (e) {
        parsed = null;
      }
    }
    if (!parsed) return null;
    if (isPlainObject(parsed.ingQty)) return parsed.ingQty;
    if (isPlainObject(parsed) && !parsed.recipes && !parsed.ing) {
      var keys = Object.keys(parsed);
      var hasQty = keys.some(function (k) { return nonEmptyQty(parsed[k]); });
      if (hasQty) return parsed;
    }
    return null;
  }

  global.ArcIngredientQtyRepair = {
    auditRecipeIngredientQuantities: auditRecipeIngredientQuantities,
    isOpenAiWeekLibraryMeta: isOpenAiWeekLibraryMeta,
    recipesNeedingQuantityRepair: recipesNeedingQuantityRepair,
    mergeRepairedIngredientQty: mergeRepairedIngredientQty,
    buildIngredientQtyRepairPrompt: buildIngredientQtyRepairPrompt,
    parseIngredientQtyRepairPatch: parseIngredientQtyRepairPatch,
    normalizePatchToIngredientNames: normalizePatchToIngredientNames
  };
})(typeof window !== 'undefined' ? window : globalThis);
