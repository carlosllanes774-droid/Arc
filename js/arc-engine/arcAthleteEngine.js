/**
 * Arc Athlete Engine — phase- and day-type nutrition modifiers.
 * Prepares future performance/recovery optimization without external APIs.
 */
(function (global) {
  'use strict';

  var PHASES = {
    offseason: {
      id: 'offseason',
      label: 'Offseason',
      calorieMultiplier: 1.04,
      carbShift: 0.04,
      proteinShift: 0.02,
      emphasis: 'lean_mass_support'
    },
    in_season: {
      id: 'in_season',
      label: 'In season',
      calorieMultiplier: 1.02,
      carbShift: 0.06,
      proteinShift: 0.01,
      emphasis: 'performance_fuel'
    },
    performance_day: {
      id: 'performance_day',
      label: 'Performance day',
      calorieMultiplier: 1.06,
      carbShift: 0.12,
      proteinShift: 0,
      emphasis: 'glycogen_priority'
    },
    recovery_day: {
      id: 'recovery_day',
      label: 'Recovery day',
      calorieMultiplier: 1,
      carbShift: 0.05,
      proteinShift: 0.04,
      emphasis: 'repair_priority'
    },
    high_output_day: {
      id: 'high_output_day',
      label: 'High output day',
      calorieMultiplier: 1.08,
      carbShift: 0.1,
      proteinShift: 0.03,
      emphasis: 'output_and_recovery'
    }
  };

  /**
   * Normalize phase slug.
   * @param {string} phase
   * @returns {string}
   */
  function normalizePhase(phase) {
    if (phase == null) return 'offseason';
    var p = String(phase).trim().toLowerCase().replace(/\s+/g, '_');
    if (p === 'in-season' || p === 'inseason') return 'in_season';
    if (p === 'performance' || p === 'game_day') return 'performance_day';
    if (p === 'recovery' || p === 'rest_day') return 'recovery_day';
    if (p === 'high_output' || p === 'velocity_day') return 'high_output_day';
    if (PHASES[p]) return p;
    return 'offseason';
  }

  /**
   * Apply athlete modifiers to base nutrition targets.
   * @param {{
   *   targetCalories: number,
   *   proteinTarget: number,
   *   fatTarget: number,
   *   carbTarget: number
   * }} baseTargets
   * @param {{
   *   phase?: string,
   *   dayType?: string,
   *   sport?: string,
   *   sessionsPerWeek?: number
   * }} [context]
   * @returns {object}
   */
  function applyAthleteModifiers(baseTargets, context) {
    context = context || {};
    baseTargets = baseTargets || {};
    var phaseKey = normalizePhase(context.phase || context.dayType || 'offseason');
    var phase = PHASES[phaseKey] || PHASES.offseason;

    var calories = Math.round((baseTargets.targetCalories || 0) * phase.calorieMultiplier);
    var protein = Math.round((baseTargets.proteinTarget || 0) * (1 + phase.proteinShift));
    var carbs = Math.round((baseTargets.carbTarget || 0) * (1 + phase.carbShift));
    var fat = baseTargets.fatTarget || 0;

    var macroCal = protein * 4 + carbs * 4 + fat * 9;
    var diff = calories - macroCal;
    if (Math.abs(diff) >= 15) carbs = Math.max(40, carbs + Math.round(diff / 4));

    return {
      phase: phase.id,
      label: phase.label,
      emphasis: phase.emphasis,
      modifiers: {
        calorieMultiplier: phase.calorieMultiplier,
        carbShift: phase.carbShift,
        proteinShift: phase.proteinShift
      },
      adjustedTargets: {
        targetCalories: calories,
        proteinTarget: protein,
        fatTarget: fat,
        carbTarget: carbs
      },
      guidance: buildPhaseGuidance(phaseKey, context)
    };
  }

  /**
   * @param {string} phaseKey
   * @param {object} context
   * @returns {string[]}
   */
  function buildPhaseGuidance(phaseKey, context) {
    var lines = [];
    if (phaseKey === 'performance_day') {
      lines.push('Shift carbohydrates toward pre- and post-session windows when timing is known.');
    }
    if (phaseKey === 'recovery_day') {
      lines.push('Prioritize protein distribution and hydration-friendly meals across the day.');
    }
    if (phaseKey === 'high_output_day') {
      lines.push('Increase carb allocation and maintain recovery protein — avoid aggressive deficits.');
    }
    if (phaseKey === 'offseason') {
      lines.push('Modest surplus bias supports lean mass without aggressive peak-week cuts.');
    }
    if (context.sport) lines.push('Sport context noted (' + context.sport + ') for future training load APIs.');
    return lines;
  }

  var api = {
    PHASES: PHASES,
    normalizePhase: normalizePhase,
    applyAthleteModifiers: applyAthleteModifiers
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.Athlete = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
