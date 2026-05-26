/**
 * USDA provider adapter — delegates to usdaService.
 */
(function (global) {
  'use strict';

  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Service = function () { return global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.usda; };
  var ID = 'usda';

  var RESPONSIBILITIES = [
    'nutrition_verification',
    'macro_validation',
    'source_of_truth'
  ];

  function verifyNutrition(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'nutrition_verification'));
    return S.verifyIngredientNutrition(input);
  }

  function validateMacros(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'macro_validation'));
    return S.validateMacros(input);
  }

  function resolveSourceOfTruth(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'source_of_truth'));
    if (input && input.fdcId) return S.getFoodNutrition({ fdcId: input.fdcId });
    return S.searchIngredient({ query: input.query });
  }

  var api = {
    id: ID,
    RESPONSIBILITIES: RESPONSIBILITIES,
    verifyNutrition: verifyNutrition,
    validateMacros: validateMacros,
    resolveSourceOfTruth: resolveSourceOfTruth
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Providers = global.ArcApi.Providers || {};
  global.ArcApi.Providers.usda = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
