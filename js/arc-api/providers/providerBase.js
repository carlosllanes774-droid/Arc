/**
 * Shared helpers for Arc API providers (information layer only).
 */
(function (global) {
  'use strict';

  /**
   * @param {string} providerId
   * @param {string} responsibility
   * @param {string} status
   * @param {object|null} [data]
   * @param {string|null} [error]
   * @returns {object}
   */
  function result(providerId, responsibility, status, data, error) {
    return {
      provider: providerId,
      responsibility: responsibility,
      status: status,
      data: data != null ? data : null,
      error: error || null,
      arcOwned: false
    };
  }

  function notConfigured(providerId, responsibility) {
    return result(providerId, responsibility, 'not_configured', null, 'Provider credentials or proxy not configured');
  }

  function notImplemented(providerId, responsibility) {
    return result(providerId, responsibility, 'not_implemented', null, 'Provider adapter pending — Arc intelligence unchanged');
  }

  function ok(providerId, responsibility, data) {
    return result(providerId, responsibility, 'ok', data, null);
  }

  function fail(providerId, responsibility, error) {
    return result(providerId, responsibility, 'error', null, error || 'Request failed');
  }

  /**
   * Resolve API base URL for server-side proxies.
   * @returns {string}
   */
  function apiBaseUrl() {
    var cfg = global.ARC_API || {};
    var base = (cfg.baseUrl || '').trim();
    if (base) return base.replace(/\/$/, '');
    if (typeof location !== 'undefined' && location.origin) return location.origin;
    return '';
  }

  /**
   * POST JSON to Arc backend proxy.
   * @param {string} path
   * @param {object} body
   * @returns {Promise<object>}
   */
  function postJson(path, body) {
    var url = apiBaseUrl() + path;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (resp) {
      return resp.json().then(function (json) {
        return { ok: resp.ok, status: resp.status, json: json };
      });
    });
  }

  var api = {
    result: result,
    notConfigured: notConfigured,
    notImplemented: notImplemented,
    ok: ok,
    fail: fail,
    apiBaseUrl: apiBaseUrl,
    postJson: postJson
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Base = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
