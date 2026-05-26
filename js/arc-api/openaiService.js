/**
 * OpenAI — optimization reasoning only. Arc validates and executes.
 * NEVER creates meals or owns macro truth.
 */
(function (global) {
  'use strict';

  var ID = 'openai';
  var Base = function () { return global.ArcApi && global.ArcApi.Base; };
  var Cache = function () { return global.ArcApi && global.ArcApi.Cache; };

  var SCENARIO_PROMPTS = {
    athlete_offseason: 'Athlete offseason: preserve lean mass, moderate surplus on training days, maintenance on rest.',
    sick_week: 'Illness recovery week: easy digestion, hydration, lower volume, maintain protein, reduce training load.',
    travel: 'Travel week: portable proteins, minimal prep, convenience without abandoning targets.',
    budget: 'Budget shift: prioritize cost-effective proteins, batch-friendly staples, limit premium cuts.',
    off_plan: 'Off-plan eating logged: damage control for remainder of day without guilt-based restriction.',
    performance: 'High output training: intra-workout fuel, elevated carbs around sessions, recovery emphasis.'
  };

  function systemPrompt() {
    return [
      'You assist Arc, an adaptive nutrition operating system.',
      'You propose optimization and adaptation strategies only.',
      'You NEVER invent final meals, calorie targets, or macro totals.',
      'Arc Engine owns targets, validation, portion scaling, and execution.',
      'Respond with concise JSON-friendly bullets: adjustments, meal timing, food categories, cautions.'
    ].join(' ');
  }

  function extractAiText(json) {
    if (!json) return '';
    if (json.content && Array.isArray(json.content)) {
      var part = json.content.find(function (p) { return p && p.type === 'text'; });
      if (part && part.text) return String(part.text);
    }
    if (typeof json.text === 'string') return json.text;
    if (typeof json.suggestion === 'string') return json.suggestion;
    return '';
  }

  /**
   * @param {{ scenario: string, arcContext: object, userNote?: string }} input
   * @returns {Promise<object>}
   */
  function callAdaptation(input) {
    var b = Base();
    var scenario = input.scenario || 'general';
    var cacheKey = 'openai:' + scenario + ':' + JSON.stringify(input.arcContext || {}).slice(0, 200);
    var c = Cache();
    if (c) {
      var hit = c.get('openai', cacheKey);
      if (hit) return Promise.resolve(hit);
    }

    var hint = SCENARIO_PROMPTS[scenario] || SCENARIO_PROMPTS.performance;
    var userContent = [
      'Scenario: ' + scenario,
      'Guidance: ' + hint,
      'Arc context (read-only): ' + JSON.stringify(input.arcContext || {}),
      input.userNote ? 'User note: ' + input.userNote : ''
    ].join('\n');

    return b.postJson('/api/ai', {
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userContent }
      ]
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) return b.notConfigured(ID, 'adaptation');
        return b.fail(ID, 'adaptation', (res.json && res.json.error) || 'OpenAI proxy failed');
      }
      var text = extractAiText(res.json);
      var out = b.ok(ID, 'adaptation', {
        scenario: scenario,
        proposal: text,
        arcOwned: ['targets', 'validation', 'portion_scaling', 'execution']
      });
      if (c) c.set('openai', cacheKey, out);
      return out;
    }).catch(function (err) {
      return b.fail(ID, 'adaptation', err && err.message ? err.message : 'Network error');
    });
  }

  function optimizeNutritionStrategy(input) {
    return callAdaptation(Object.assign({ scenario: 'performance' }, input));
  }

  function adaptForAthlete(input) {
    return callAdaptation(Object.assign({ scenario: 'athlete_offseason' }, input));
  }

  function adaptForIllness(input) {
    return callAdaptation(Object.assign({ scenario: 'sick_week' }, input));
  }

  function adaptForBudget(input) {
    return callAdaptation(Object.assign({ scenario: 'budget' }, input));
  }

  function adaptForTravel(input) {
    return callAdaptation(Object.assign({ scenario: 'travel' }, input));
  }

  function adaptForOffPlanEating(input) {
    return callAdaptation(Object.assign({ scenario: 'off_plan', userNote: input.text || input.userNote }, input));
  }

  function adaptForPerformance(input) {
    return callAdaptation(Object.assign({ scenario: 'performance' }, input));
  }

  var api = {
    id: ID,
    optimizeNutritionStrategy: optimizeNutritionStrategy,
    adaptForAthlete: adaptForAthlete,
    adaptForIllness: adaptForIllness,
    adaptForBudget: adaptForBudget,
    adaptForTravel: adaptForTravel,
    adaptForOffPlanEating: adaptForOffPlanEating,
    adaptForPerformance: adaptForPerformance
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.openai = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
