/**
 * Spoonacular — recipe retrieval, discovery, metadata (no macro truth).
 */
(function (global) {
  'use strict';

  var ID = 'spoonacular';
  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Cache = function () { return global.ArcApi && global.ArcApi.Cache; };
  var RateLimit = function () { return global.ArcApi && global.ArcApi.RateLimit; };

  /**
   * @param {object} raw
   * @returns {object}
   */
  function normalizeRecipe(raw) {
    raw = raw || {};
    var ing = [];
    if (Array.isArray(raw.extendedIngredients)) {
      ing = raw.extendedIngredients.map(function (x) {
        return {
          name: x.name || x.original || '',
          amount: x.amount,
          unit: x.unit,
          original: x.original
        };
      });
    } else if (Array.isArray(raw.ingredients)) {
      ing = raw.ingredients;
    }

    return {
      recipeId: raw.id || raw.recipeId,
      title: raw.title || '',
      ingredients: ing,
      servings: raw.servings || 1,
      prepTime: raw.readyInMinutes != null ? raw.readyInMinutes : raw.prepTime,
      image: raw.image || null,
      tags: [].concat(
        raw.diets || [],
        raw.cuisines || [],
        raw.dishTypes || [],
        raw.occasions || []
      ).filter(Boolean)
    };
  }

  function proxyPost(path, body, cacheNs, cacheKey) {
    var b = Base();
    var c = Cache();
    if (c && cacheKey) {
      var hit = c.get(cacheNs, cacheKey);
      if (hit) return Promise.resolve(hit);
    }
    var rl = RateLimit();
    var call = function () {
      return b.postJson(path, body);
    };
    var wrapped = rl ? rl.withRetry(call) : call();
    return wrapped.then(function (res) {
      if (c && cacheKey && res.ok) c.set(cacheNs, cacheKey, res);
      return res;
    });
  }

  /**
   * @param {{ query?: string, minProtein?: number, maxCalories?: number, diet?: string, maxReadyTime?: number, maxPrice?: number, number?: number }} filters
   * @returns {Promise<object>}
   */
  function searchRecipes(filters) {
    var b = Base();
    filters = filters || {};
    var cacheKey = 'search:' + JSON.stringify(filters);
    return proxyPost('/api/spoonacular/search', filters, 'recipes', cacheKey).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) return b.notConfigured(ID, 'meal_discovery');
        return b.fail(ID, 'meal_discovery', (res.json && res.json.error) || 'Spoonacular search failed');
      }
      var list = (res.json && res.json.results) || [];
      return b.ok(ID, 'meal_discovery', {
        recipes: list.map(normalizeRecipe),
        total: res.json.total || list.length
      });
    }).catch(function (err) {
      return b.fail(ID, 'meal_discovery', err && err.message ? err.message : 'Network error');
    });
  }

  function filterRecipes(recipes, filters) {
    filters = filters || {};
    var list = Array.isArray(recipes) ? recipes.slice() : [];
    if (filters.maxCalories) {
      list = list.filter(function (r) {
        return !r.nutrition || r.nutrition.calories <= filters.maxCalories;
      });
    }
    if (filters.diet) {
      var d = String(filters.diet).toLowerCase();
      list = list.filter(function (r) {
        return (r.tags || []).some(function (t) { return String(t).toLowerCase().indexOf(d) !== -1; });
      });
    }
    if (filters.maxReadyTime) {
      list = list.filter(function (r) { return !r.prepTime || r.prepTime <= filters.maxReadyTime; });
    }
    return list;
  }

  /**
   * @param {{ recipeId: string|number }} input
   * @returns {Promise<object>}
   */
  function getRecipeIngredients(input) {
    return getRecipeBulk({ ids: [input.recipeId], includeNutrition: false }).then(function (r) {
      if (r.status !== 'ok' || !r.data.recipes.length) return r;
      var recipe = r.data.recipes[0];
      return Base().ok(ID, 'recipe_retrieval', { recipeId: recipe.recipeId, ingredients: recipe.ingredients });
    });
  }

  /**
   * @param {{ recipeId: string|number }} input
   * @returns {Promise<object>}
   */
  function getRecipeInstructions(input) {
    return getRecipeBulk({ ids: [input.recipeId] }).then(function (r) {
      if (r.status !== 'ok' || !r.data.recipes.length) return r;
      var recipe = r.data.recipes[0];
      return Base().ok(ID, 'recipe_metadata', {
        recipeId: recipe.recipeId,
        instructions: recipe.instructions || [],
        prepTime: recipe.prepTime
      });
    });
  }

  /**
   * @param {{ ids: Array<string|number>, includeNutrition?: boolean }} input
   * @returns {Promise<object>}
   */
  function getRecipeBulk(input) {
    var b = Base();
    input = input || {};
    var ids = Array.isArray(input.ids) ? input.ids.filter(Boolean) : [];
    if (!ids.length && input.recipeId) ids = [input.recipeId];
    if (!ids.length) return Promise.resolve(b.fail(ID, 'recipe_retrieval', 'recipe id(s) required'));

    var cacheKey = 'bulk:' + ids.join(',');
    return proxyPost('/api/spoonacular/bulk', { ids: ids, includeNutrition: !!input.includeNutrition }, 'recipes', cacheKey)
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 503) return b.notConfigured(ID, 'recipe_retrieval');
          return b.fail(ID, 'recipe_retrieval', (res.json && res.json.error) || 'Spoonacular bulk failed');
        }
        var recipes = ((res.json && res.json.recipes) || []).map(normalizeRecipe);
        recipes.forEach(function (r) {
          if (res.json.instructions && res.json.instructions[r.recipeId]) {
            r.instructions = res.json.instructions[r.recipeId];
          }
        });
        return b.ok(ID, 'recipe_retrieval', { recipes: recipes });
      }).catch(function (err) {
        return b.fail(ID, 'recipe_retrieval', err && err.message ? err.message : 'Network error');
      });
  }

  var api = {
    id: ID,
    normalizeRecipe: normalizeRecipe,
    searchRecipes: searchRecipes,
    filterRecipes: filterRecipes,
    getRecipeIngredients: getRecipeIngredients,
    getRecipeInstructions: getRecipeInstructions,
    getRecipeBulk: getRecipeBulk
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.spoonacular = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
