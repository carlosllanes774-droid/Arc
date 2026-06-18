/**
 * Kroger provider adapter — delegates to krogerService.
 */
(function (global) {
  'use strict';

  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Service = function () { return global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.kroger; };
  var ID = 'kroger';

  var RESPONSIBILITIES = [
    'grocery_pricing',
    'availability',
    'substitutions'
  ];

  function getPricing(input) {
    var S = Service();
    input = input || {};
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'grocery_pricing'));

    var items = Array.isArray(input.items) ? input.items : [];
    var ingredients = items.map(function (it) {
      return { key: it.key, name: it.term || it.name };
    });

    return S.estimateGroceryCost({
      zipCode: input.zipCode,
      ingredients: ingredients,
      budgetConstraints: input.budgetConstraints
    });
  }

  function checkAvailability(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'availability'));
    return S.checkAvailability(input);
  }

  function findSubstitutions(input) {
    var S = Service();
    if (!S) return Promise.resolve(Base().notImplemented(ID, 'substitutions'));
    return S.findSubstitutions(input);
  }

  var api = {
    id: ID,
    RESPONSIBILITIES: RESPONSIBILITIES,
    getPricing: getPricing,
    checkAvailability: checkAvailability,
    findSubstitutions: findSubstitutions
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Providers = global.ArcApi.Providers || {};
  global.ArcApi.Providers.kroger = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
