/**
 * Arc API configuration — environment variables only (no hardcoded keys).
 * Node: reads process.env · Browser: flags from GET /api/config/status (no secrets).
 */
(function (global) {
  'use strict';

  var ENV_KEYS = {
    spoonacular: ['SPOONACULAR_API_KEY'],
    edamam: ['EDAMAM_APP_ID', 'EDAMAM_API_KEY', 'EDAMAM_APP_KEY'],
    usda: ['USDA_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    kroger: ['KROGER_CLIENT_ID', 'KROGER_SECRET', 'KROGER_CLIENT_SECRET'],
    supabase: ['SUPABASE_URL', 'SUPABASE_ANON_KEY']
  };

  var REQUIRED_PAIRS = {
    edamam: { all: ['EDAMAM_APP_ID'], oneOf: [['EDAMAM_API_KEY', 'EDAMAM_APP_KEY']] },
    kroger: { all: ['KROGER_CLIENT_ID'], oneOf: [['KROGER_SECRET', 'KROGER_CLIENT_SECRET']] }
  };

  /**
   * @param {object} env
   * @returns {string}
   */
  function pickFirst(env, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = env[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  /**
   * @param {object} [source]
   * @returns {object}
   */
  function loadFromEnv(source) {
    var env = source || {};
    if (!Object.keys(env).length && typeof process !== 'undefined' && process.env) {
      env = process.env;
    }

    return {
      spoonacularApiKey: pickFirst(env, ['SPOONACULAR_API_KEY']),
      usdaApiKey: pickFirst(env, ['USDA_API_KEY']),
      openaiApiKey: pickFirst(env, ['OPENAI_API_KEY']),
      edamamAppId: pickFirst(env, ['EDAMAM_APP_ID']),
      edamamApiKey: pickFirst(env, ['EDAMAM_API_KEY', 'EDAMAM_APP_KEY']),
      krogerClientId: pickFirst(env, ['KROGER_CLIENT_ID']),
      krogerSecret: pickFirst(env, ['KROGER_SECRET', 'KROGER_CLIENT_SECRET']),
      supabaseUrl: pickFirst(env, ['SUPABASE_URL']),
      supabaseAnonKey: pickFirst(env, ['SUPABASE_ANON_KEY']),
      nodeEnv: pickFirst(env, ['NODE_ENV']) || 'development',
      isProduction: pickFirst(env, ['NODE_ENV']) === 'production'
    };
  }

  /**
   * @param {object} cfg loadFromEnv() result
   * @returns {{ valid: boolean, missing: string[], warnings: string[], providers: object }}
   */
  function validate(cfg) {
    cfg = cfg || loadFromEnv();
    var missing = [];
    var warnings = [];
    var providers = {};

    function setProvider(id, ok, detail) {
      providers[id] = { configured: ok, detail: detail || null };
    }

    if (!cfg.spoonacularApiKey) missing.push('SPOONACULAR_API_KEY');
    setProvider('spoonacular', !!cfg.spoonacularApiKey, cfg.spoonacularApiKey ? 'ok' : 'missing key');

    if (!cfg.edamamAppId || !cfg.edamamApiKey) {
      if (!cfg.edamamAppId) missing.push('EDAMAM_APP_ID');
      if (!cfg.edamamApiKey) missing.push('EDAMAM_API_KEY (or EDAMAM_APP_KEY)');
    }
    setProvider('edamam', !!(cfg.edamamAppId && cfg.edamamApiKey));

    if (!cfg.usdaApiKey) missing.push('USDA_API_KEY');
    setProvider('usda', !!cfg.usdaApiKey);

    if (!cfg.openaiApiKey) missing.push('OPENAI_API_KEY');
    setProvider('openai', !!cfg.openaiApiKey);

    if (!cfg.krogerClientId || !cfg.krogerSecret) {
      if (!cfg.krogerClientId) missing.push('KROGER_CLIENT_ID');
      if (!cfg.krogerSecret) missing.push('KROGER_SECRET (or KROGER_CLIENT_SECRET)');
    }
    setProvider('kroger', !!(cfg.krogerClientId && cfg.krogerSecret));

    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
      warnings.push('SUPABASE_URL / SUPABASE_ANON_KEY optional for local-only mode');
    }
    setProvider('supabase', !!(cfg.supabaseUrl && cfg.supabaseAnonKey));

    if (cfg.isProduction && missing.length) {
      warnings.push('Production boot with incomplete API credentials — graceful degradation active');
    }

    return {
      valid: missing.length === 0,
      missing: missing,
      warnings: warnings,
      providers: providers,
      environment: cfg.isProduction ? 'production' : 'development'
    };
  }

  /**
   * Public provider flags for browser (no secrets).
   * @param {object} status from /api/config/status
   * @returns {object}
   */
  function mergePublicStatus(status) {
    status = status || {};
    return {
      environment: status.environment || 'unknown',
      providers: status.providers || {},
      renderReady: !!status.renderReady,
      arcProxyBase: status.arcProxyBase || null
    };
  }

  var api = {
    ENV_KEYS: ENV_KEYS,
    loadFromEnv: loadFromEnv,
    validate: validate,
    mergePublicStatus: mergePublicStatus
  };

  global.ArcConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
