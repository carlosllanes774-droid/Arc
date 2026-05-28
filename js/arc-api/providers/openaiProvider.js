/**
 * OpenAI provider adapter — delegates to openaiService (reasoning only).
 */
(function (global) {
  'use strict';

  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Service = function () { return global.ArcApi && global.ArcApi.Services && global.ArcApi.Services.openai; };
  var ID = 'openai';

  var RESPONSIBILITIES = [
    'adaptation',
    'optimization',
    'reasoning'
  ];

  function extractAiText(json) {
    if (!json) return '';
    if (json.content && Array.isArray(json.content)) {
      var part = json.content.find(function (p) { return p && p.type === 'text'; });
      if (part && part.text) return String(part.text);
    }
    if (typeof json.text === 'string') return json.text;
    return '';
  }

  function adapt(input) {
    var b = Base();
    input = input || {};
    var messages = input.messages;
    if (!Array.isArray(messages) || !messages.length) {
      return Promise.resolve(b.fail(ID, 'adaptation', 'messages array required'));
    }

    return b.postJson('/api/ai', {
      messages: messages,
      userMsg: input.userMsg,
      taskType: input.taskType || 'optimization',
      max_tokens: input.max_tokens || 220,
      timeout_ms: 8000
    }).then(function (res) {
      if (!res.ok) {
        var err = (res.json && res.json.error) ? res.json.error : 'OpenAI proxy request failed';
        if (res.status === 503) return b.notConfigured(ID, 'adaptation');
        return b.fail(ID, 'adaptation', err);
      }
      return b.ok(ID, 'adaptation', { content: extractAiText(res.json), raw: res.json });
    }).catch(function (err) {
      return b.fail(ID, 'adaptation', err && err.message ? err.message : 'Network error');
    });
  }

  function optimize(input) {
    var S = Service();
    if (S && input && input.arcContext) {
      return S.optimizeNutritionStrategy({
        arcContext: input.arcContext,
        userNote: input.prompt
      });
    }
    if (!input || !input.prompt) return Promise.resolve(Base().fail(ID, 'optimization', 'prompt required'));
    return adapt({
      messages: [
        { role: 'system', content: 'You assist Arc nutrition OS. Provide concise optimization ideas; Arc engine owns final targets.' },
        { role: 'user', content: input.prompt }
      ],
      userMsg: input.prompt,
      taskType: 'optimization',
      max_tokens: 220
    }).then(function (r) {
      if (r.status !== 'ok') return r;
      return Base().ok(ID, 'optimization', { suggestion: r.data.content, arcContext: input.arcContext || null });
    });
  }

  function reason(input) {
    return adapt(input).then(function (r) {
      if (r.responsibility === 'adaptation' && r.status === 'ok') {
        return Base().ok(ID, 'reasoning', r.data);
      }
      return Object.assign({}, r, { responsibility: 'reasoning' });
    });
  }

  var api = {
    id: ID,
    RESPONSIBILITIES: RESPONSIBILITIES,
    adapt: adapt,
    optimize: optimize,
    reason: reason
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Providers = global.ArcApi.Providers || {};
  global.ArcApi.Providers.openai = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
