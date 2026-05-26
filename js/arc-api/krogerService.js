/**
 * Kroger — pricing, availability, substitutions (Arc Budget engine fallback when unavailable).
 */
(function (global) {
  'use strict';

  var ID = 'kroger';
  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Cache = function () { return global.ArcApi && global.ArcApi.Cache; };

  /**
   * Arc grocery estimation when Kroger is unavailable.
   * @param {Array<object>} ingredients
   * @param {object} budgetConstraints
   * @returns {object}
   */
  function arcGroceryFallback(ingredients, budgetConstraints) {
    budgetConstraints = budgetConstraints || {};
    var maxPer = Number(budgetConstraints.maxCostPerServing) || 7;
    var count = Array.isArray(ingredients) ? ingredients.length : 0;
    var perItem = Math.min(maxPer * 0.35, 4.5);
    return {
      estimatedCost: Math.round(perItem * Math.max(count, 3) * 100) / 100,
      availability: 'estimated',
      substitutions: [],
      source: 'arc_budget_engine',
      note: 'Kroger unavailable — Arc budget tier estimate'
    };
  }

  /**
   * @param {{ zipCode: string, ingredients: Array<{key?:string, term?:string, name?:string}> }} input
   * @returns {Promise<object>}
   */
  function estimateGroceryCost(input) {
    var b = Base();
    input = input || {};
    var ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
    if (!ingredients.length) {
      return Promise.resolve(b.fail(ID, 'grocery_pricing', 'ingredients required'));
    }

    if (!input.zipCode) {
      var Trace = global.ArcApi && global.ArcApi.Trace;
      if (Trace) {
        Trace.logMessage('Kroger unavailable');
        Trace.logFallback('arc_budget_engine', 'no_zip');
      }
      return Promise.resolve(b.ok(ID, 'grocery_pricing', arcGroceryFallback(ingredients, input.budgetConstraints)));
    }

    var items = ingredients.map(function (ing, i) {
      return {
        key: ing.key || 'item_' + i,
        term: ing.term || ing.name || String(ing)
      };
    });

    var cacheKey = 'price:' + input.zipCode + ':' + items.map(function (x) { return x.term; }).join(',');
    var c = Cache();
    if (c) {
      var hit = c.get('pricing', cacheKey);
      if (hit) return Promise.resolve(hit);
    }

    return b.postJson('/api/kroger/prices', {
      zipCode: input.zipCode,
      items: items
    }).then(function (res) {
      var Trace = global.ArcApi && global.ArcApi.Trace;
      if (!res.ok) {
        if (res.status === 503) {
          if (Trace) {
            Trace.logMessage('Kroger unavailable');
            Trace.logFallback('arc_budget_engine', 'not_configured');
          }
          var fb = arcGroceryFallback(ingredients, input.budgetConstraints);
          return b.ok(ID, 'grocery_pricing', fb);
        }
        if (Trace) Trace.logFallback('arc_budget_engine', 'request_failed');
        var degraded = arcGroceryFallback(ingredients, input.budgetConstraints);
        degraded.warning = (res.json && res.json.error) || 'Kroger request failed';
        return b.ok(ID, 'grocery_pricing', degraded);
      }

      var results = (res.json && res.json.results) || {};
      var total = 0;
      var matched = 0;
      Object.keys(results).forEach(function (k) {
        var row = results[k];
        if (row && row.priceEffective) {
          total += row.priceEffective;
          matched += 1;
        }
      });

      var out = b.ok(ID, 'grocery_pricing', {
        estimatedCost: Math.round(total * 100) / 100,
        availability: matched > 0 ? 'live' : 'partial',
        results: results,
        locationId: res.json.locationId || null,
        substitutions: [],
        source: 'kroger'
      });
      if (c) c.set('pricing', cacheKey, out);
      return out;
    }).catch(function () {
      var TraceCatch = global.ArcApi && global.ArcApi.Trace;
      if (TraceCatch) TraceCatch.logFallback('arc_budget_engine', 'network_error');
      return b.ok(ID, 'grocery_pricing', arcGroceryFallback(ingredients, input.budgetConstraints));
    });
  }

  /**
   * @param {{ zipCode: string, productIds?: string[] }} input
   * @returns {Promise<object>}
   */
  function checkAvailability(input) {
    var b = Base();
    input = input || {};
    if (!input.zipCode) return Promise.resolve(b.fail(ID, 'availability', 'zipCode required'));

    return fetch((b.apiBaseUrl() || '') + '/api/kroger/location?zipCode=' + encodeURIComponent(input.zipCode))
      .then(function (resp) { return resp.json().then(function (json) { return { ok: resp.ok, json: json }; }); })
      .then(function (res) {
        if (!res.ok) return b.fail(ID, 'availability', (res.json && res.json.error) || 'Location lookup failed');
        return b.ok(ID, 'availability', {
          store: res.json,
          productIds: input.productIds || [],
          available: true
        });
      }).catch(function (err) {
        return b.fail(ID, 'availability', err && err.message ? err.message : 'Network error');
      });
  }

  /**
   * @param {{ term: string, zipCode?: string, dietary?: object }} input
   * @returns {Promise<object>}
   */
  function findSubstitutions(input) {
    var b = Base();
    input = input || {};
    var term = String(input.term || '').trim();
    if (!term) return Promise.resolve(b.fail(ID, 'substitutions', 'term required'));

    if (!input.zipCode) {
      return Promise.resolve(b.ok(ID, 'substitutions', {
        term: term,
        substitutions: [],
        source: 'arc_placeholder',
        note: 'Provide zipCode for Kroger substitution search'
      }));
    }

    return estimateGroceryCost({
      zipCode: input.zipCode,
      ingredients: [{ key: 'sub', term: term }]
    }).then(function (pr) {
      var alt = (pr.data && pr.data.results && pr.data.results.sub) || null;
      return b.ok(ID, 'substitutions', {
        term: term,
        substitutions: alt ? [alt] : [],
        source: pr.data && pr.data.source
      });
    });
  }

  var api = {
    id: ID,
    estimateGroceryCost: estimateGroceryCost,
    checkAvailability: checkAvailability,
    findSubstitutions: findSubstitutions,
    arcGroceryFallback: arcGroceryFallback
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.kroger = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
