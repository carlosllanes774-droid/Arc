/**
 * Production-safe API tracing for the Arc nutrition pipeline.
 * Logs provider timing and status only — no API keys, no user PII.
 */
(function (global) {
  'use strict';

  var PREFIX = '[ARC PIPELINE]';

  var PROVIDER_NAMES = {
    spoonacular: 'Spoonacular',
    edamam: 'Edamam',
    usda: 'USDA',
    openai: 'OpenAI',
    kroger: 'Kroger',
    orchestrator: 'Pipeline orchestrator',
    arc_budget_engine: 'Arc budget engine',
    category_targets: 'category targets'
  };

  var PATH_ROUTES = [
    ['/api/spoonacular', 'spoonacular'],
    ['/api/nutrition/spoonacular-verify', 'spoonacular'],
    ['/api/edamam', 'edamam'],
    ['/api/nutrition/pipeline', 'edamam'],
    ['/api/nutrition', 'edamam'],
    ['/api/usda', 'usda'],
    ['/api/ai', 'openai'],
    ['/api/kroger', 'kroger'],
    ['/api/grocery', 'kroger']
  ];

  function label(providerId) {
    return PROVIDER_NAMES[providerId] || (providerId ? String(providerId) : 'Unknown');
  }

  function pathToProvider(path) {
    var p = String(path || '').split('?')[0];
    var i;
    for (i = 0; i < PATH_ROUTES.length; i++) {
      if (p === PATH_ROUTES[i][0] || p.indexOf(PATH_ROUTES[i][0] + '/') === 0) {
        return PATH_ROUTES[i][1];
      }
    }
    return null;
  }

  function pathOperation(path) {
    var p = String(path || '').split('?')[0];
    var parts = p.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(1).join('/');
    return p || 'request';
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function timeStart() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function msSince(t0) {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return Math.round(performance.now() - t0);
    }
    return Math.max(0, Date.now() - t0);
  }

  function emit(line, detail) {
    if (detail && global.ARC_PIPELINE_TRACE_VERBOSE) {
      console.log(PREFIX + ' ' + line, detail);
    } else {
      console.log(PREFIX + ' ' + line);
    }
  }

  /**
   * Human-readable provider line: "Spoonacular success 842ms"
   * @param {object} opts
   */
  function logProvider(opts) {
    opts = opts || {};
    var name = label(opts.providerId || opts.provider);
    var outcome = opts.outcome || (opts.success ? 'success' : 'failed');
    if (opts.message) outcome = opts.message;
    var ms = opts.durationMs != null ? opts.durationMs : 0;
    var line = name + ' ' + outcome + (ms > 0 || opts.includeZeroMs ? ' ' + ms + 'ms' : '');
    emit(line, {
      provider: opts.providerId || opts.provider,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt || nowIso(),
      success: !!opts.success,
      durationMs: ms,
      status: opts.status || null,
      httpStatus: opts.httpStatus != null ? opts.httpStatus : null,
      fallback: !!opts.fallback
    });
  }

  function logOrchestrator(message) {
    emit('Pipeline orchestrator ' + message);
  }

  function logMessage(message) {
    emit(String(message || ''));
  }

  function logFallback(toProviderId, reason) {
    emit('Falling back to ' + label(toProviderId) + (reason ? ' (' + reason + ')' : ''));
  }

  function envelopeSuccess(result) {
    if (!result) return false;
    return result.status === 'ok';
  }

  function envelopeStatus(result) {
    if (!result || !result.status) return null;
    return result.status;
  }

  /**
   * Log Arc API provider envelope (dispatch / service layer).
   */
  function logEnvelope(providerId, operation, result, startedAt, t0, extra) {
    extra = extra || {};
    var success = envelopeSuccess(result);
    var status = envelopeStatus(result);
    var outcome = success ? 'success' : (status === 'not_configured' ? 'unavailable' : 'failed');
    if (extra.outcome) outcome = extra.outcome;

    logProvider({
      providerId: providerId,
      outcome: outcome,
      success: success,
      status: status,
      httpStatus: extra.httpStatus != null ? extra.httpStatus : null,
      startedAt: startedAt,
      completedAt: nowIso(),
      durationMs: msSince(t0),
      fallback: !!extra.fallback,
      includeZeroMs: true
    });
  }

  /**
   * Log HTTP proxy round-trip (ArcApi.Base.postJson / GET proxy).
   */
  function logProxy(providerId, operation, res, startedAt, t0, extra) {
    extra = extra || {};
    var httpStatus = res && typeof res.status === 'number' ? res.status : null;
    var ok = !!(res && res.ok);
    var providerStatus = ok ? 'ok' : (httpStatus === 503 ? 'not_configured' : 'error');
    if (res && res.json && res.json.error && ok) providerStatus = 'error';

    logProvider({
      providerId: providerId,
      outcome: ok ? 'success' : (httpStatus === 503 ? 'unavailable' : 'failed'),
      success: ok,
      status: providerStatus,
      httpStatus: httpStatus,
      startedAt: startedAt,
      completedAt: nowIso(),
      durationMs: msSince(t0),
      fallback: !!extra.fallback,
      includeZeroMs: true
    });
  }

  /**
   * Log upstream provider call from Express (server.js).
   */
  function logUpstream(opts) {
    opts = opts || {};
    var success = !!opts.success;
    var outcome = opts.message || (success ? 'success' : (opts.httpStatus === 503 ? 'unavailable' : 'failed'));
    logProvider({
      providerId: opts.providerId,
      outcome: outcome,
      success: success,
      status: opts.providerStatus || (success ? 'ok' : 'error'),
      httpStatus: opts.httpStatus,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt || nowIso(),
      durationMs: opts.durationMs != null ? opts.durationMs : 0,
      fallback: !!opts.fallback,
      includeZeroMs: true
    });
  }

  /**
   * Wrap a promise-returning provider call with tracing.
   */
  function traceEnvelope(providerId, operation, promise) {
    var startedAt = nowIso();
    var t0 = timeStart();
    return Promise.resolve(promise).then(function (result) {
      logEnvelope(providerId, operation, result, startedAt, t0);
      return result;
    }).catch(function (err) {
      logProvider({
        providerId: providerId,
        outcome: 'failed',
        message: (operation || 'call') + ' failed',
        success: false,
        status: 'error',
        startedAt: startedAt,
        completedAt: nowIso(),
        durationMs: msSince(t0),
        fallback: false,
        includeZeroMs: true
      });
      throw err;
    });
  }

  var api = {
    PREFIX: PREFIX,
    label: label,
    pathToProvider: pathToProvider,
    pathOperation: pathOperation,
    nowIso: nowIso,
    timeStart: timeStart,
    msSince: msSince,
    logProvider: logProvider,
    logOrchestrator: logOrchestrator,
    logMessage: logMessage,
    logFallback: logFallback,
    logEnvelope: logEnvelope,
    logProxy: logProxy,
    logUpstream: logUpstream,
    traceEnvelope: traceEnvelope
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Trace = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
