/**
 * Edamam request helpers — ingredient normalization, payload validation, failure classification.
 * Safe for browser (IIFE) and server (vm load). Never logs credentials.
 */
(function (global) {
  'use strict';

  var EDAMAM_NUTRITION_ENDPOINT = 'https://api.edamam.com/api/nutrition-details';

  function normalizeIngredientLine(s) {
    return String(s || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/^\s*[-*•·]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * @param {string[]|*} ingr
   * @returns {string[]}
   */
  function normalizeIngredientLines(ingr) {
    if (!Array.isArray(ingr)) return [];
    var seen = {};
    var out = [];
    ingr.forEach(function (line) {
      var n = normalizeIngredientLine(line);
      if (!n) return;
      var key = n.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(n);
    });
    return out;
  }

  /**
   * @param {{ title?: string, ingr?: string[] }} payload
   * @returns {{ valid: boolean, reason?: string }}
   */
  function validateEdamamPayload(payload) {
    payload = payload || {};
    var ingr = payload.ingr;
    if (!Array.isArray(ingr)) {
      return { valid: false, reason: 'ingr must be an array' };
    }
    if (!ingr.length) {
      return { valid: false, reason: 'ingr must be a non-empty array of strings' };
    }
    var i;
    for (i = 0; i < ingr.length; i++) {
      if (typeof ingr[i] !== 'string' || !normalizeIngredientLine(ingr[i])) {
        return { valid: false, reason: 'each ingr entry must be a non-empty string' };
      }
    }
    return { valid: true };
  }

  /**
   * @param {number} httpStatus
   * @param {string} bodyText
   * @returns {'auth'|'payload'|'endpoint'|'other'}
   */
  function classifyEdamamFailure(httpStatus, bodyText) {
    var text = String(bodyText || '').toLowerCase();
    if (httpStatus === 401 || httpStatus === 403) return 'auth';
    if (
      text.indexOf('invalid app') !== -1 ||
      text.indexOf('unauthorized') !== -1 ||
      (text.indexOf('app_id') !== -1 && text.indexOf('invalid') !== -1) ||
      (text.indexOf('app_key') !== -1 && (text.indexOf('invalid') !== -1 || text.indexOf('not valid') !== -1))
    ) {
      return 'auth';
    }
    if (httpStatus === 400 || httpStatus === 422) return 'payload';
    if (text.indexOf('ingr') !== -1 && (text.indexOf('required') !== -1 || text.indexOf('invalid') !== -1)) {
      return 'payload';
    }
    if (httpStatus >= 400 && httpStatus < 500) return 'endpoint';
    return 'other';
  }

  function failureLogMessage(kind) {
    if (kind === 'auth') return 'Edamam auth failed';
    if (kind === 'payload') return 'Edamam payload invalid';
    if (kind === 'endpoint') return 'Edamam endpoint rejected request';
    return 'Edamam nutrition analysis failed';
  }

  /**
   * @param {string} text
   * @param {number} [maxLen]
   * @returns {string}
   */
  function sanitizeEdamamBody(text, maxLen) {
    maxLen = maxLen || 400;
    return String(text || '')
      .replace(/app_key=[^&\s"']+/gi, 'app_key=[REDACTED]')
      .replace(/app_id=[^&\s"']+/gi, 'app_id=[REDACTED]')
      .replace(/"app_key"\s*:\s*"[^"]+"/gi, '"app_key":"[REDACTED]"')
      .replace(/"app_id"\s*:\s*"[^"]+"/gi, '"app_id":"[REDACTED]"')
      .slice(0, maxLen);
  }

  /**
   * @param {object} Trace ArcApi.Trace or server ArcTrace
   * @param {'auth'|'payload'|'endpoint'|'other'} kind
   * @param {object} detail status, endpoint, payloadValid, bodyPreview, operation
   */
  function logEdamamFailure(Trace, kind, detail) {
    detail = detail || {};
    if (Trace && typeof Trace.logMessage === 'function') {
      Trace.logMessage(failureLogMessage(kind));
    }
    var verbose =
      (typeof global !== 'undefined' && global.ARC_PIPELINE_TRACE_VERBOSE) ||
      (typeof process !== 'undefined' && process.env && process.env.ARC_PIPELINE_TRACE_VERBOSE);
    if (verbose && typeof console !== 'undefined' && console.error) {
      console.error('[ARC PIPELINE] Edamam diagnostic', {
        failureKind: kind,
        httpStatus: detail.httpStatus != null ? detail.httpStatus : null,
        endpoint: detail.endpoint || EDAMAM_NUTRITION_ENDPOINT,
        operation: detail.operation || null,
        payloadValid: detail.payloadValid != null ? detail.payloadValid : null,
        payloadReason: detail.payloadReason || null,
        ingredientCount: detail.ingredientCount != null ? detail.ingredientCount : null,
        bodyPreview: detail.bodyPreview || null
      });
    }
  }

  var api = {
    EDAMAM_NUTRITION_ENDPOINT: EDAMAM_NUTRITION_ENDPOINT,
    normalizeIngredientLine: normalizeIngredientLine,
    normalizeIngredientLines: normalizeIngredientLines,
    validateEdamamPayload: validateEdamamPayload,
    classifyEdamamFailure: classifyEdamamFailure,
    failureLogMessage: failureLogMessage,
    sanitizeEdamamBody: sanitizeEdamamBody,
    logEdamamFailure: logEdamamFailure
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Edamam = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
