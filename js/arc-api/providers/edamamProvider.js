/**
 * Edamam provider adapter — delegates to edamamService.
 */
(function (global) {
  'use strict';

  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Service = function () { return global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.edamam; };
  var ID = 'edamam';

  var RESPONSIBILITIES = [
    'ingredient_parsing',
    'food_understanding',
    'recipe_nutrition_analysis',
    'diet_labels',
    'food_intelligence'
  ];

  function parseIngredients(input) {
    var S = Service();
    input = input || {};
    var lines = Array.isArray(input.ingredients) ? input.ingredients.filter(Boolean) : [];
    if (!lines.length) return Promise.resolve(Base().fail(ID, 'ingredient_parsing', 'ingredients array required'));
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'ingredient_parsing'));
    return S.parseFoodInput({ text: lines.join('\n') });
  }

  function parseFoodInput(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'ingredient_parsing'));
    return S.parseFoodInput(input);
  }

  function understandFood(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'food_understanding'));
    return S.understandIngredients(input);
  }

  function analyzeRecipeNutrition(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'recipe_nutrition_analysis'));
    return S.analyzeRecipeNutrition(input);
  }

  function getDietLabels(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'diet_labels'));
    return S.dietLabels(input);
  }

  function getFoodIntelligence(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'food_intelligence'));
    return analyzeRecipeNutrition(input).then(function (nutritionResult) {
      return Base().ok(ID, 'food_intelligence', {
        nutrition: nutritionResult,
        labels: nutritionResult.data ? nutritionResult.data.dietLabels : null,
        parse: null
      });
    });
  }

  var api = {
    id: ID,
    RESPONSIBILITIES: RESPONSIBILITIES,
    parseIngredients: parseIngredients,
    parseFoodInput: parseFoodInput,
    understandFood: understandFood,
    analyzeRecipeNutrition: analyzeRecipeNutrition,
    getDietLabels: getDietLabels,
    getFoodIntelligence: getFoodIntelligence
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Providers = global.ArcApi.Providers || {};
  global.ArcApi.Providers.edamam = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
