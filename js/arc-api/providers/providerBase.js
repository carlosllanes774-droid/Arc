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
    if (global.ArcApiBase && global.ArcApiBase.apiBaseUrl) return global.ArcApiBase.apiBaseUrl();
    if (typeof location !== 'undefined' && location.origin) return String(location.origin).replace(/\/$/, '');
    var cfg = global.ARC_API || {};
    return String(cfg.baseUrl || '').trim().replace(/\/$/, '');
  }

  /**
   * POST JSON to Arc backend proxy.
   * @param {string} path
   * @param {object} body
   * @returns {Promise<object>}
   */
  function postJson(path, body) {
    var url = apiBaseUrl() + path;
    var Trace = global.ArcApi && global.ArcApi.Trace;
    var providerId = Trace ? Trace.pathToProvider(path) : null;
    var operation = Trace ? Trace.pathOperation(path) : path;
    var startedAt = Trace ? Trace.nowIso() : null;
    var t0 = Trace ? Trace.timeStart() : 0;

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (resp) {
      return resp.json().then(function (json) {
        var res = { ok: resp.ok, status: resp.status, json: json };
        if (Trace && providerId) {
          Trace.logProxy(providerId, operation, res, startedAt, t0);
        }
        return res;
      });
    }).catch(function (err) {
      if (Trace && providerId) {
        Trace.logProvider({
          providerId: providerId,
          outcome: 'failed',
          message: operation + ' failed',
          success: false,
          status: 'error',
          startedAt: startedAt,
          completedAt: Trace.nowIso(),
          durationMs: Trace.msSince(t0),
          fallback: false,
          includeZeroMs: true
        });
      }
      throw err;
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
