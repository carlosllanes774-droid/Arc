/**
 * Spoonacular provider adapter — delegates to spoonacularService.
 */
(function (global) {
  'use strict';

  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Service = function () { return global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.spoonacular; };
  var ID = 'spoonacular';

  var RESPONSIBILITIES = [
    'recipe_retrieval',
    'recipe_metadata',
    'meal_discovery'
  ];

  function retrieveRecipe(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notConfigured(ID, 'recipe_retrieval'));
    input = input || {};
    return S.getRecipeBulk({ ids: [input.recipeId], includeNutrition: !!input.includeNutrition });
  }

  function getRecipeMetadata(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notConfigured(ID, 'recipe_metadata'));
    return S.getRecipeInstructions(input);
  }

  function discoverMeals(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'meal_discovery'));
    input = input || {};
    return S.searchRecipes({
      query: input.query,
      diet: input.diet,
      maxCalories: input.maxCalories,
      minProtein: input.minProtein,
      maxReadyTime: input.maxReadyTime,
      maxPrice: input.maxPrice,
      number: input.number
    });
  }

  function searchRecipes(input) {
    return discoverMeals(input);
  }

  var api = {
    id: ID,
    RESPONSIBILITIES: RESPONSIBILITIES,
    retrieveRecipe: retrieveRecipe,
    getRecipeMetadata: getRecipeMetadata,
    discoverMeals: discoverMeals,
    searchRecipes: searchRecipes
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Providers = global.ArcApi.Providers || {};
  global.ArcApi.Providers.spoonacular = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
