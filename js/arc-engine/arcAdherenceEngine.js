/**
 * Arc Adherence Engine — track plan adherence and surface adaptation signals.
 * Feeds a future adaptation layer (no API calls).
 */
(function (global) {
  'use strict';

  var EVENT_TYPES = {
    MEAL_COMPLETED: 'meal_completed',
    MEAL_MODIFIED: 'meal_modified',
    OFF_PLAN: 'off_plan_meal',
    SKIPPED: 'skipped_meal'
  };

  var EVENT_SCORES = {
    meal_completed: 1,
    meal_modified: 0.65,
    off_plan_meal: 0.25,
    skipped_meal: 0
  };

  /**
   * @typedef {object} AdherenceEvent
   * @property {string} type
   * @property {string} [slot]
   * @property {string} [date] - ISO date
   * @property {object} [meta]
   */

  /**
   * Normalize event type string.
   * @param {string} type
   * @returns {string}
   */
  function normalizeEventType(type) {
    var t = type != null ? String(type).trim().toLowerCase() : '';
    if (t === 'completed' || t === 'meal_completed') return EVENT_TYPES.MEAL_COMPLETED;
    if (t === 'modified' || t === 'meal_modified') return EVENT_TYPES.MEAL_MODIFIED;
    if (t === 'off_plan' || t === 'off_plan_meal') return EVENT_TYPES.OFF_PLAN;
    if (t === 'skipped' || t === 'skipped_meal') return EVENT_TYPES.SKIPPED;
    return t;
  }

  /**
   * Record a meal adherence event (immutable log entry).
   * @param {AdherenceEvent} event
   * @param {Array<AdherenceEvent>} [log]
   * @returns {AdherenceEvent}
   */
  function recordMealEvent(event, log) {
    event = event || {};
    var entry = {
      type: normalizeEventType(event.type),
      slot: event.slot || null,
      date: event.date || new Date().toISOString().slice(0, 10),
      timestamp: event.timestamp || Date.now(),
      meta: event.meta || {}
    };
    if (Array.isArray(log)) log.push(entry);
    return entry;
  }

  /**
   * Estimate adherence score 0–1 from event log.
   * @param {Array<AdherenceEvent>} events
   * @param {{ expectedMealsPerDay?: number, days?: number }} [opts]
   * @returns {{ score: number, completed: number, modified: number, offPlan: number, skipped: number }}
   */
  function estimatePlanAdherence(events, opts) {
    opts = opts || {};
    events = Array.isArray(events) ? events : [];
    var completed = 0;
    var modified = 0;
    var offPlan = 0;
    var skipped = 0;
    var weighted = 0;
    var count = 0;

    events.forEach(function (ev) {
      var type = normalizeEventType(ev.type);
      var w = EVENT_SCORES[type];
      if (w == null) return;
      count += 1;
      weighted += w;
      if (type === EVENT_TYPES.MEAL_COMPLETED) completed += 1;
      else if (type === EVENT_TYPES.MEAL_MODIFIED) modified += 1;
      else if (type === EVENT_TYPES.OFF_PLAN) offPlan += 1;
      else if (type === EVENT_TYPES.SKIPPED) skipped += 1;
    });

    var expected = (opts.expectedMealsPerDay || 3) * (opts.days || 7);
    var coverage = expected > 0 ? Math.min(1, count / expected) : 0;
    var rawScore = count > 0 ? weighted / count : 0;
    var score = Math.round((rawScore * 0.75 + coverage * 0.25) * 100) / 100;

    return { score: score, completed: completed, modified: modified, offPlan: offPlan, skipped: skipped };
  }

  /**
   * Detect recurring adherence patterns.
   * @param {Array<AdherenceEvent>} events
   * @returns {Array<object>}
   */
  function detectPatterns(events) {
    events = Array.isArray(events) ? events : [];
    var bySlot = {};
    var byDow = {};

    events.forEach(function (ev) {
      var type = normalizeEventType(ev.type);
      var slot = ev.slot || 'unknown';
      if (!bySlot[slot]) bySlot[slot] = { total: 0, skipped: 0, offPlan: 0 };
      bySlot[slot].total += 1;
      if (type === EVENT_TYPES.SKIPPED) bySlot[slot].skipped += 1;
      if (type === EVENT_TYPES.OFF_PLAN) bySlot[slot].offPlan += 1;

      var d = ev.date ? new Date(ev.date + 'T12:00:00') : new Date();
      var dow = d.getDay();
      if (!byDow[dow]) byDow[dow] = { total: 0, weak: 0 };
      byDow[dow].total += 1;
      if (type === EVENT_TYPES.SKIPPED || type === EVENT_TYPES.OFF_PLAN) byDow[dow].weak += 1;
    });

    var patterns = [];
    Object.keys(bySlot).forEach(function (slot) {
      var s = bySlot[slot];
      if (s.total >= 3 && s.skipped / s.total >= 0.4) {
        patterns.push({ kind: 'skip_heavy_slot', slot: slot, rate: s.skipped / s.total });
      }
      if (s.total >= 3 && s.offPlan / s.total >= 0.35) {
        patterns.push({ kind: 'off_plan_slot', slot: slot, rate: s.offPlan / s.total });
      }
    });

    Object.keys(byDow).forEach(function (dow) {
      var d = byDow[dow];
      if (d.total >= 4 && d.weak / d.total >= 0.45) {
        patterns.push({ kind: 'weak_day_of_week', dayIndex: Number(dow), rate: d.weak / d.total });
      }
    });

    return patterns;
  }

  /**
   * Signals for a future adaptation engine (deterministic heuristics).
   * @param {Array<AdherenceEvent>} events
   * @param {{ goal?: string, proteinTarget?: number }} [context]
   * @returns {object}
   */
  function futureAdaptationSignals(events, context) {
    context = context || {};
    var adherence = estimatePlanAdherence(events, context.adherenceOpts);
    var patterns = detectPatterns(events);
    var signals = [];

    if (adherence.score < 0.55) {
      signals.push({
        code: 'simplify_plan',
        strength: 'high',
        message: 'Adherence is soft — reduce prep burden and repeat forgiving mains.'
      });
    }
    if (adherence.skipped >= 3) {
      signals.push({
        code: 'slot_redesign',
        strength: 'medium',
        message: 'Skipped meals are clustering — rebalance slot timing or defaults.'
      });
    }
    if (adherence.offPlan >= 2) {
      signals.push({
        code: 'flex_meals',
        strength: 'medium',
        message: 'Off-plan meals are frequent — add structured flex slots.'
      });
    }
    patterns.forEach(function (p) {
      if (p.kind === 'skip_heavy_slot') {
        signals.push({
          code: 'swap_slot',
          strength: 'medium',
          slot: p.slot,
          message: 'Consider swapping or simplifying the ' + p.slot + ' slot.'
        });
      }
    });

    return {
      adherence: adherence,
      patterns: patterns,
      signals: signals,
      readyForAdaptation: signals.length > 0
    };
  }

  var api = {
    EVENT_TYPES: EVENT_TYPES,
    EVENT_SCORES: EVENT_SCORES,
    normalizeEventType: normalizeEventType,
    recordMealEvent: recordMealEvent,
    estimatePlanAdherence: estimatePlanAdherence,
    detectPatterns: detectPatterns,
    futureAdaptationSignals: futureAdaptationSignals
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.Adherence = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
