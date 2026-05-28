/**
 * Same-origin API base URL — browser uses window.location.origin (localhost + production).
 * Optional ARC_API.baseUrl only when location is unavailable (tests, non-browser).
 */
(function (global) {
  'use strict';

  function normalizeBase(base) {
    return String(base || '').trim().replace(/\/$/, '');
  }

  function pageOrigin() {
    if (typeof location !== 'undefined' && location.origin) {
      return normalizeBase(location.origin);
    }
    return '';
  }

  /**
   * @returns {string}
   */
  function apiBaseUrl() {
    var origin = pageOrigin();
    if (origin) return origin;

    var cfg = global.ARC_API || {};
    return normalizeBase(cfg.baseUrl);
  }

  /**
   * @param {string} path
   * @returns {string}
   */
  function apiUrl(path) {
    var p = path && String(path).charAt(0) === '/' ? String(path) : '/' + String(path || '');
    return apiBaseUrl() + p;
  }

  global.ArcApiBase = {
    apiBaseUrl: apiBaseUrl,
    apiUrl: apiUrl
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
