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
  var OPENAI_OPTIMIZATION_TIMEOUT_MS = 7000;
  var OPENAI_ENHANCEMENT_TIMEOUT_MS = 12000;
  var OPENAI_CACHE_TTL_MS = 20 * 60 * 1000;
  var OPENAI_ENHANCEMENT_CACHE_TTL_MS = 60 * 60 * 1000;
  var inFlight = new Map();

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

  function stableStringify(value) {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.slice(0, 8).map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'recipes' || k === 'plan' || k === 'history' || k === 'raw') continue;
      out.push(JSON.stringify(k) + ':' + stableStringify(value[k]));
    }
    return '{' + out.join(',') + '}';
  }

  function compactArcContext(ctx) {
    ctx = ctx || {};
    return {
      goal: ctx.goal || null,
      targets: ctx.targets || null,
      budget: ctx.budget || null,
      adherence: ctx.adherence || null,
      profile: ctx.profile ? {
        goal: ctx.profile.goal || null,
        budgetTier: ctx.profile.budgetTier || null
      } : null
    };
  }

  /**
   * @param {{ scenario: string, arcContext: object, userNote?: string }} input
   * @returns {Promise<object>}
   */
  function callAdaptation(input) {
    var b = Base();
    var scenario = input.scenario || 'general';
    var compactContext = compactArcContext(input.arcContext);
    var cacheKey = 'openai:' + scenario + ':' + stableStringify(compactContext) + ':' + String(input.userNote || '').slice(0, 120);
    var c = Cache();
    if (c) {
      var hit = c.get('openai', cacheKey);
      if (hit) return Promise.resolve(hit);
    }
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

    var hint = SCENARIO_PROMPTS[scenario] || SCENARIO_PROMPTS.performance;
    var userContent = [
      'Scenario: ' + scenario,
      'Guidance: ' + hint,
      'Arc context: ' + JSON.stringify(compactContext),
      input.userNote ? 'User note: ' + input.userNote : ''
    ].join('\n');

    var req = b.postJson('/api/ai', {
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userContent }
      ],
      taskType: 'optimization',
      max_tokens: 220,
      timeout_ms: OPENAI_OPTIMIZATION_TIMEOUT_MS
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
      if (c) c.set('openai', cacheKey, out, OPENAI_CACHE_TTL_MS);
      return out;
    }).catch(function (err) {
      return b.fail(ID, 'adaptation', err && err.message ? err.message : 'Network error');
    }).finally(function () {
      inFlight.delete(cacheKey);
    });
    inFlight.set(cacheKey, req);
    return req;
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

  /**
   * @param {{ recipe: object, scenario?: string, profile?: object }} input
   * @returns {Promise<object>}
   */
  function enhanceRecipePresentation(input) {
    input = input || {};
    var b = Base();
    var recipe = input.recipe || {};
    var title = String(recipe.title || recipe.name || 'Meal');
    var ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 14).map(function (ing) {
      return String((ing && (ing.original || ing.name)) || '').trim();
    }).filter(Boolean) : [];
    var instructions = Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 8) : [];
    var compactInstructions = instructions.map(function (step) {
      return String(step || '').trim();
    }).filter(Boolean);
    var compactIngredients = ingredients.slice(0, 10);
    var enhancementKey = 'openai:enhance:' + stableStringify({
      scenario: input.scenario || 'performance',
      goal: input.profile && input.profile.goal,
      title: title,
      ingredients: compactIngredients,
      instructions: compactInstructions.slice(0, 6)
    });
    var c = Cache();

    if (!title || !ingredients.length) {
      return Promise.resolve(b.fail(ID, 'adaptation', 'recipe data required for enhancement'));
    }
    if (c) {
      var hit = c.get('openai', enhancementKey);
      if (hit) return Promise.resolve(hit);
    }
    if (inFlight.has(enhancementKey)) return inFlight.get(enhancementKey);

    var prompt = [
      'Enhance recipe title and instructions for Arc premium nutrition coaching.',
      'Rules:',
      '- Keep nutrition intent aligned to scenario.',
      '- Return concise, high-clarity, action-first cooking steps.',
      '- Improve flavor guidance and cooking terminology.',
      '- Avoid changing core ingredients or macro intent.',
      '- Keep each instruction under 18 words.',
      '- No narrative, no storytelling, no extra explanations.',
      '- Return strict JSON with keys: title, instructions (array of strings).',
      'Scenario: ' + String(input.scenario || 'performance'),
      'User goal: ' + String((input.profile && input.profile.goal) || ''),
      'Recipe title: ' + title,
      'Ingredients: ' + JSON.stringify(compactIngredients),
      'Instructions: ' + JSON.stringify(compactInstructions)
    ].join('\n');

    var req = b.postJson('/api/ai', {
      messages: [
        { role: 'system', content: 'You are a culinary performance coach. Rewrite recipe title and steps in premium meal-kit style. Return valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      taskType: 'optimization',
      max_tokens: 240,
      timeout_ms: OPENAI_ENHANCEMENT_TIMEOUT_MS
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 503) return b.notConfigured(ID, 'adaptation');
        return b.fail(ID, 'adaptation', (res.json && res.json.error) || 'OpenAI enhancement failed');
      }
      var text = extractAiText(res.json);
      var parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      if (!parsed || !parsed.title || !Array.isArray(parsed.instructions) || !parsed.instructions.length) {
        return b.fail(ID, 'adaptation', 'Invalid enhancement format');
      }
      var out = b.ok(ID, 'adaptation', {
        enhancedTitle: String(parsed.title),
        enhancedInstructions: parsed.instructions.map(function (s) { return String(s); }).filter(Boolean)
      });
      if (c) c.set('openai', enhancementKey, out, OPENAI_ENHANCEMENT_CACHE_TTL_MS);
      return out;
    }).catch(function (err) {
      return b.fail(ID, 'adaptation', err && err.message ? err.message : 'Network error');
    }).finally(function () {
      inFlight.delete(enhancementKey);
    });
    inFlight.set(enhancementKey, req);
    return req;
  }

  var api = {
    id: ID,
    optimizeNutritionStrategy: optimizeNutritionStrategy,
    adaptForAthlete: adaptForAthlete,
    adaptForIllness: adaptForIllness,
    adaptForBudget: adaptForBudget,
    adaptForTravel: adaptForTravel,
    adaptForOffPlanEating: adaptForOffPlanEating,
    adaptForPerformance: adaptForPerformance,
    enhanceRecipePresentation: enhanceRecipePresentation
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Services = global.ArcApi.Services || {};
  global.ArcApi.Services.openai = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
