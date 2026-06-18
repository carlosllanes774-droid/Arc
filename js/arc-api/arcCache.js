/**
 * Arc API response cache — reduces cost and latency.
 */
(function (global) {
  'use strict';

  var DEFAULT_TTL = {
    recipes: 6 * 60 * 60 * 1000,
    parsedFoods: 12 * 60 * 60 * 1000,
    ingredientValidation: 24 * 60 * 60 * 1000,
    pricing: 12 * 60 * 60 * 1000,
    openai: 30 * 60 * 1000
  };

  var stores = {};

  function ns(name) {
    if (!stores[name]) stores[name] = new Map();
    return stores[name];
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @returns {*|null}
   */
  function get(namespace, key) {
    var entry = ns(namespace).get(String(key));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      ns(namespace).delete(String(key));
      return null;
    }
    return entry.value;
  }

  /**
   * @param {string} namespace
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs]
   */
  function set(namespace, key, value, ttlMs) {
    var ttl = ttlMs != null ? ttlMs : (DEFAULT_TTL[namespace] || 60 * 60 * 1000);
    ns(namespace).set(String(key), {
      value: value,
      expiresAt: Date.now() + ttl
    });
  }

  function clear(namespace) {
    if (namespace) ns(namespace).clear();
    else Object.keys(stores).forEach(function (k) { stores[k].clear(); });
  }

  var api = {
    DEFAULT_TTL: DEFAULT_TTL,
    get: get,
    set: set,
    clear: clear
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Cache = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
