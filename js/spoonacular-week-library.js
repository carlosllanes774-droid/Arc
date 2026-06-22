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

  /**
   * Supabase access_token for BFF Authorization header (when signed in).
   * @returns {Promise<string|null>}
   */
  function getAccessToken() {
    var Backend = global.ArcBackend;
    if (!Backend || typeof Backend.getSession !== 'function') {
      return Promise.resolve(null);
    }
    return Backend.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      return session && session.access_token ? session.access_token : null;
    }).catch(function () {
      return null;
    });
  }

  /**
   * Merge Authorization: Bearer when a Supabase session exists.
   * @param {object} [headers]
   * @returns {Promise<object>}
   */
  function withAuthHeaders(headers) {
    headers = headers || {};
    return getAccessToken().then(function (token) {
      var h = Object.assign({}, headers);
      if (token) h.Authorization = 'Bearer ' + token;
      return h;
    });
  }

  /**
   * fetch() with Supabase JWT attached for protected BFF routes.
   * @param {string} url
   * @param {object} [options]
   * @returns {Promise<Response>}
   */
  function authFetch(url, options) {
    options = options || {};
    return withAuthHeaders(options.headers).then(function (headers) {
      options.headers = headers;
      return fetch(url, options);
    });
  }

  global.ArcApiBase = {
    apiBaseUrl: apiBaseUrl,
    apiUrl: apiUrl,
    getAccessToken: getAccessToken,
    withAuthHeaders: withAuthHeaders,
    authFetch: authFetch
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
