/**
 * Arc API retry / backoff — free-tier protection and graceful degradation.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    maxRetries: 3,
    baseDelayMs: 400,
    maxDelayMs: 8000,
    retryStatuses: [429, 502, 503, 504]
  };

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function jitter(ms) {
    return ms + Math.floor(Math.random() * 120);
  }

  /**
   * @param {function(): Promise<{ok:boolean,status:number,json?:object}>} fn
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  function withRetry(fn, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var attempt = 0;

    function run() {
      return Promise.resolve().then(fn).then(function (res) {
        var retryable = res && opts.retryStatuses.indexOf(res.status) !== -1;
        if (!retryable || attempt >= opts.maxRetries) return res;
        attempt += 1;
        var delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt - 1));
        return sleep(jitter(delay)).then(run);
      }).catch(function (err) {
        if (attempt >= opts.maxRetries) throw err;
        attempt += 1;
        var delay = Math.min(opts.maxDelayMs, opts.baseDelayMs * Math.pow(2, attempt - 1));
        return sleep(jitter(delay)).then(run);
      });
    }

    return run();
  }

  /**
   * Wrap provider call — never throws; returns degraded flag.
   * @param {function(): Promise<object>} fn
   * @param {object} fallbackResult
   * @returns {Promise<object>}
   */
  function withGracefulFallback(fn, fallbackResult) {
    return withRetry(fn).catch(function () {
      return Object.assign({}, fallbackResult, {
        status: fallbackResult.status || 'degraded',
        degraded: true
      });
    });
  }

  var api = {
    DEFAULTS: DEFAULTS,
    withRetry: withRetry,
    withGracefulFallback: withGracefulFallback,
    sleep: sleep
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.RateLimit = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
