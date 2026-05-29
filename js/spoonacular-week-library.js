/**
 * Spoonacular week recipe library — search, bulk map, validate before applyLibrary.
 */
(function (global) {
  'use strict';

  var LOG_PREFIX = '[ARC SPOONACULAR VALIDATION]';
  var MIN_RECIPES = 4;
  var VALID_CATS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  var VALID_CAT_SET = { Breakfast: true, Lunch: true, Dinner: true, Snack: true };

  var CATEGORY_QUERIES = {
    Breakfast: 'breakfast high protein',
    Lunch: 'lunch',
    Dinner: 'dinner',
    Snack: 'healthy snack'
  };

  function apiUrl(path) {
    if (global.ArcRuntime && global.ArcRuntime.apiUrl) return global.ArcRuntime.apiUrl(path);
    if (typeof global.arcApiPath === 'function') return global.arcApiPath(path);
    return path;
  }

  function postJson(path, body) {
    return fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (resp) {
      return resp.json().then(function (json) {
        return { ok: resp.ok, status: resp.status, json: json };
      });
    });
  }

  /**
   * @param {string[]} [restrictions]
   * @returns {string|undefined}
   */
  /**
   * Canonical Edamam line — prefer Spoonacular original NLP text.
   * @param {object} x extendedIngredients entry
   * @returns {string}
   */
  function edamamLineFromIngredient(x) {
    x = x || {};
    var original = String(x.original || '').trim();
    if (original) return original;
    var name = String(x.name || '').trim();
    var qtyParts = [x.amount, x.unit].filter(function (v) {
      return v != null && v !== '';
    });
    if (qtyParts.length && name) return qtyParts.join(' ').trim() + ' ' + name;
    if (qtyParts.length) return qtyParts.join(' ').trim();
    return name;
  }

  /**
   * Stable key for ingQty when duplicate display names exist.
   * @param {number|string} spId
   * @param {number} index
   * @param {object} x
   * @returns {string}
   */
  function ingredientStableKey(spId, index, x) {
    if (x && x.id != null && x.id !== '') return 'sp_' + spId + '_' + x.id;
    return 'sp_' + spId + '_' + index;
  }

  function mapRestrictionsToSpoonacularDiet(restrictions) {
    if (!Array.isArray(restrictions)) return undefined;
    var lower = restrictions.map(function (r) { return String(r || '').toLowerCase(); });
    if (lower.indexOf('vegan') >= 0) return 'vegan';
    if (lower.indexOf('vegetarian') >= 0) return 'vegetarian';
    if (lower.indexOf('gluten-free') >= 0 || lower.indexOf('gluten free') >= 0) return 'gluten free';
    if (lower.indexOf('ketogenic') >= 0 || lower.indexOf('keto') >= 0) return 'ketogenic';
    if (lower.indexOf('paleo') >= 0) return 'paleo';
    return undefined;
  }

  function safeRound(v) {
    var n = Number(v);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function categoryTargetsFor(cat, mt) {
    mt = mt || {};
    if (cat === 'Breakfast') return mt.Breakfast || mt.perSlot || {};
    if (cat === 'Dinner') return mt.Dinner || mt.perSlot || {};
    if (cat === 'Snack') return mt.Snack || mt.perSlot || {};
    return mt.Lunch || mt.perSlot || {};
  }

  function macrosFromSpoonacularBulkItem(sp) {
    sp = sp || {};
    if (sp.nutrition && typeof sp.nutrition === 'object') {
      return {
        cal: sp.nutrition.calories,
        p: sp.nutrition.protein,
        c: sp.nutrition.carbs,
        f: sp.nutrition.fat
      };
    }
    return {
      cal: sp.calories,
      p: sp.protein,
      c: sp.carbs,
      f: sp.fat
    };
  }

  function hasPositiveMacros(cal, p, c, f) {
    return Number(cal) > 0 && Number(p) > 0 && Number(c) > 0 && Number(f) > 0;
  }

  /**
   * @param {object} recipe — week-library recipe (mutated)
   * @param {object} sp — bulk recipe row
   * @param {object} [mealTargets] — built.mt from week generation
   */
  function applyNutritionToWeekLibraryRecipe(recipe, sp, mealTargets) {
    var raw = macrosFromSpoonacularBulkItem(sp);
    var cal = safeRound(raw.cal);
    var p = safeRound(raw.p);
    var c = safeRound(raw.c);
    var f = safeRound(raw.f);

    if (hasPositiveMacros(cal, p, c, f)) {
      recipe.cal = cal;
      recipe.p = p;
      recipe.c = c;
      recipe.f = f;
      recipe.nutritionSource = 'spoonacular';
      recipe.nutritionVerified = false;
      recipe.nutritionConfidence = 'low';
      console.log('[ARC SPOONACULAR] nutrition mapped', {
        name: recipe.name,
        spoonacularId: recipe.spoonacularId,
        cal: cal,
        p: p
      });
      return;
    }

    var t = categoryTargetsFor(recipe.cat, mealTargets);
    recipe.cal = safeRound(t.cal);
    recipe.p = safeRound(t.p);
    recipe.c = safeRound(t.c);
    recipe.f = safeRound(t.f);
    recipe.nutritionSource = 'category_targets';
    recipe.nutritionVerified = false;
    recipe.nutritionConfidence = 'low';
    console.log('[ARC SPOONACULAR] category target nutrition fallback', {
      name: recipe.name,
      cat: recipe.cat,
      spoonacularId: recipe.spoonacularId,
      cal: recipe.cal,
      p: recipe.p
    });
  }

  /**
   * @param {object} bulk — BFF /api/spoonacular/bulk response
   * @param {object} categoryBySpoonacularId — spoonacular id → meal category
   * @param {object} [mealTargets] — built.mt for category fallback when nutrition missing
   * @returns {{ recipes: object[] }}
   */
  function mapSpoonacularBulkToWeekLibrary(bulk, categoryBySpoonacularId, mealTargets) {
    categoryBySpoonacularId = categoryBySpoonacularId || {};
    var list = bulk && Array.isArray(bulk.recipes) ? bulk.recipes : [];
    var recipes = [];
    var localId = 0;

    for (var i = 0; i < list.length; i++) {
      var sp = list[i] || {};
      var spId = sp.recipeId != null ? sp.recipeId : sp.id;
      var catKey = spId != null ? String(spId) : '';
      var cat = categoryBySpoonacularId[catKey] || categoryBySpoonacularId[spId] || '';

      var ingRaw = sp.extendedIngredients || sp.ingredients || [];
      var ingNames = [];
      var ingKeys = [];
      var ingQty = {};
      var ingEdamam = [];
      for (var j = 0; j < ingRaw.length; j++) {
        var x = ingRaw[j] || {};
        var name = String(x.name || x.original || '').trim();
        if (!name) continue;
        var ingKey = ingredientStableKey(spId, j, x);
        var qtyParts = [x.amount, x.unit].filter(function (v) {
          return v != null && v !== '';
        });
        var qtyDisplay = qtyParts.length ? qtyParts.join(' ').trim() : '';
        var edamamLine = edamamLineFromIngredient(x);

        ingNames.push(name);
        ingKeys.push(ingKey);
        ingEdamam.push(edamamLine);
        ingQty[ingKey] = qtyDisplay;
        if (!Object.prototype.hasOwnProperty.call(ingQty, name)) {
          ingQty[name] = qtyDisplay || String(x.original || '').trim();
        }
      }

      var steps = (sp.instructions || []).map(function (txt) {
        return { phase: 'Cook', instruction: String(txt) };
      });

      localId += 1;
      console.log('[ARC SPOONACULAR] recipeId mapping', { localId: localId, spoonacularId: spId });
      var recipe = {
        id: localId,
        spoonacularId: spId,
        name: String(sp.title || sp.name || '').trim(),
        cat: cat,
        ing: ingNames,
        ingKeys: ingKeys,
        ingEdamam: ingEdamam,
        ingQty: ingQty,
        steps: steps,
        instructionSource: steps.length > 0 ? 'spoonacular' : undefined,
        servings: sp.servings || 2,
        time: String(sp.readyInMinutes != null ? sp.readyInMinutes : (sp.prepTime || 25)) + ' min',
        image: sp.image || null,
        tags: Array.isArray(sp.tags) ? sp.tags.slice() : [],
        price: 6.0
      };
      applyNutritionToWeekLibraryRecipe(recipe, sp, mealTargets);
      recipes.push(recipe);
    }

    return { recipes: recipes };
  }

  /**
   * @param {object[]} recipes
   * @returns {{ ok: boolean, errors: string[], recipes: object[] }}
   */
  function validateSpoonacularWeekLibrary(recipes) {
    var errors = [];
    recipes = Array.isArray(recipes) ? recipes : [];

    if (recipes.length < MIN_RECIPES) {
      errors.push('recipe_count_below_minimum:' + recipes.length);
    }

    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i] || {};
      var label = 'recipe[' + i + ']';

      if (!r.cat || !VALID_CAT_SET[r.cat]) {
        errors.push(label + ':invalid_or_missing_cat');
      }
      if (!r.name || !String(r.name).trim()) {
        errors.push(label + ':missing_name');
      }
      if (!Array.isArray(r.ing) || !r.ing.length) {
        errors.push(label + ':missing_ing');
      }
      if (r.spoonacularId == null || r.spoonacularId === '') {
        errors.push(label + ':missing_spoonacularId');
      }
    }

    var ok = errors.length === 0;
    console.log(LOG_PREFIX, {
      ok: ok,
      recipeCount: recipes.length,
      errors: errors
    });

    return { ok: ok, errors: errors, recipes: recipes };
  }

  function mergeCategoryMaps(groups) {
    var categoryBySpoonacularId = {};
    var ids = [];
    var seen = {};

    (groups || []).forEach(function (group) {
      var map = group.categoryBySpoonacularId || {};
      Object.keys(map).forEach(function (id) {
        if (!seen[id]) {
          seen[id] = true;
          ids.push(Number(id) || id);
          categoryBySpoonacularId[id] = map[id];
        }
      });
    });

    return { ids: ids, categoryBySpoonacularId: categoryBySpoonacularId };
  }

  function searchCategory(cat, count, built) {
    var mt = built && built.mt ? built.mt : {};
    var perSlot = mt.perSlot || { cal: 600 };
    var diet = mapRestrictionsToSpoonacularDiet(built && built.restrictions);
    var number = Math.max(parseInt(count, 10) || 2, 2);

    return postJson('/api/spoonacular/search', {
      query: CATEGORY_QUERIES[cat] || String(cat).toLowerCase(),
      diet: diet,
      maxCalories: Math.round((Number(perSlot.cal) || 600) * 1.15),
      number: number + 1
    }).then(function (res) {
      var categoryBySpoonacularId = {};
      var ids = [];
      if (!res.ok) {
        return { cat: cat, ids: ids, categoryBySpoonacularId: categoryBySpoonacularId, status: res.status };
      }
      var results = (res.json && res.json.results) || [];
      results.forEach(function (x) {
        var id = x.recipeId != null ? x.recipeId : x.id;
        if (id == null) return;
        var key = String(id);
        ids.push(id);
        categoryBySpoonacularId[key] = cat;
      });
      return { cat: cat, ids: ids, categoryBySpoonacularId: categoryBySpoonacularId };
    });
  }

  /**
   * Fetch Spoonacular library; validate before callback. Invalid libraries never reach applyLibrary.
   * @param {object} built — from buildWeekRecipeLibraryPrompt (+ restrictions)
   * @param {function(err: *, payload: {recipes: object[]}|null, meta: object)} callback
   */
  function fetchSpoonacularWeekLibrary(built, callback) {
    built = built || {};
    callback = typeof callback === 'function' ? callback : function () {};

    var perCat = built.libraryTargets && built.libraryTargets.perCat
      ? built.libraryTargets.perCat
      : { Lunch: 2 };
    var categories = Object.keys(perCat);

    if (!categories.length) {
      callback({
        type: 'validation_failed',
        validation: validateSpoonacularWeekLibrary([])
      }, null, { source: 'spoonacular' });
      return;
    }

    Promise.all(categories.map(function (cat) {
      return searchCategory(cat, perCat[cat], built);
    }))
      .then(function (groups) {
        var merged = mergeCategoryMaps(groups);
        if (!merged.ids.length) {
          throw new Error('Spoonacular search returned no recipe ids');
        }
        return postJson('/api/spoonacular/bulk', {
          ids: merged.ids,
          includeNutrition: true
        }).then(function (bulkRes) {
          if (!bulkRes.ok) {
            throw new Error('Spoonacular bulk failed: ' + bulkRes.status);
          }
          var mapped = mapSpoonacularBulkToWeekLibrary(
            bulkRes.json,
            merged.categoryBySpoonacularId,
            built.mt
          );
          var validation = validateSpoonacularWeekLibrary(mapped.recipes);
          if (!validation.ok) {
            callback({
              type: 'validation_failed',
              validation: validation
            }, null, { source: 'spoonacular', validationErrors: validation.errors });
            return;
          }
          callback(null, { recipes: mapped.recipes }, { source: 'spoonacular' });
        });
      })
      .catch(function (err) {
        callback(err || new Error('Spoonacular week library fetch failed'), null, { source: 'spoonacular' });
      });
  }

  global.ArcSpoonacularWeekLibrary = {
    MIN_RECIPES: MIN_RECIPES,
    VALID_CATS: VALID_CATS.slice(),
    edamamLineFromIngredient: edamamLineFromIngredient,
    ingredientStableKey: ingredientStableKey,
    mapSpoonacularBulkToWeekLibrary: mapSpoonacularBulkToWeekLibrary,
    applyNutritionToWeekLibraryRecipe: applyNutritionToWeekLibraryRecipe,
    macrosFromSpoonacularBulkItem: macrosFromSpoonacularBulkItem,
    validateSpoonacularWeekLibrary: validateSpoonacularWeekLibrary,
    mapRestrictionsToSpoonacularDiet: mapRestrictionsToSpoonacularDiet,
    fetchSpoonacularWeekLibrary: fetchSpoonacularWeekLibrary
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
