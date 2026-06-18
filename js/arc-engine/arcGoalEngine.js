/**
 * Arc Goal Engine — translate onboarding goals into nutrition targets.
 * Consumes user physiology; delegates macro math to Nutrition Engine.
 */
(function (global) {
  'use strict';

  var Nutrition = function () {
    return (global.ArcEngine && global.ArcEngine.Nutrition) || null;
  };

  var GOAL_ALIASES = {
    'lose weight': 'lose_weight',
    lose_weight: 'lose_weight',
    'gain weight': 'gain_weight',
    gain_weight: 'gain_weight',
    'body recomp': 'body_recomp',
    body_recomp: 'body_recomp',
    'maintain weight': 'maintain_weight',
    maintain_weight: 'maintain_weight',
    'gain muscle': 'gain_muscle',
    gain_muscle: 'gain_muscle',
    'build muscle': 'gain_muscle',
    'eat healthier': 'eat_healthier',
    eat_healthier: 'eat_healthier',
    'improve energy': 'improve_energy',
    improve_energy: 'improve_energy'
  };

  var STRATEGIES = {
    lose_weight: 'caloric_deficit',
    gain_weight: 'caloric_surplus',
    body_recomp: 'recomp_deficit',
    maintain_weight: 'maintenance',
    gain_muscle: 'muscle_surplus',
    eat_healthier: 'health_focus',
    improve_energy: 'energy_consistency'
  };

  /**
   * Normalize onboarding goal label to slug.
   * @param {string} goal
   * @returns {string}
   */
  function normalizeGoal(goal) {
    if (goal == null) return 'maintain_weight';
    var raw = String(goal).trim();
    if (GOAL_ALIASES[raw]) return GOAL_ALIASES[raw];
    var lower = raw.toLowerCase();
    if (GOAL_ALIASES[lower]) return GOAL_ALIASES[lower];
    var slug = lower.replace(/\s+/g, '_');
    return GOAL_ALIASES[slug] || slug;
  }

  /**
   * Clamp weekly pace (lb/week) to supported chip values.
   * @param {number} pace
   * @returns {number}
   */
  function normalizePace(pace) {
    var p = Number(pace);
    if (!isFinite(p) || p <= 0) return 0.5;
    if (p < 0.25) return 0.25;
    if (p > 1) return 1;
    return p;
  }

  /**
   * Daily kcal adjustment from lb/week (~3500 kcal per lb).
   * 0.5 lb/week ≈ 250 kcal/day; 1 lb/week ≈ 500 kcal/day.
   * @param {number} paceLbWeek
   * @returns {number}
   */
  function paceToDailyDelta(paceLbWeek) {
    var p = normalizePace(paceLbWeek);
    return Math.round((p * 3500) / 7);
  }

  /**
   * Calorie adjustment for goal (signed: negative = deficit).
   * @param {string} goalKey
   * @param {number} paceLbWeek
   * @param {{ muscleEmphasis?: boolean }} [opts]
   * @returns {{ adjustment: number, strategy: string, paceApplied: number|null }}
   */
  function calorieAdjustmentForGoal(goalKey, paceLbWeek, opts) {
    opts = opts || {};
    var paceDelta = paceToDailyDelta(paceLbWeek);
    var strategy = STRATEGIES[goalKey] || 'maintenance';

    if (goalKey === 'lose_weight') {
      return { adjustment: -paceDelta, strategy: strategy, paceApplied: normalizePace(paceLbWeek) };
    }
    if (goalKey === 'gain_weight') {
      return { adjustment: paceDelta, strategy: strategy, paceApplied: normalizePace(paceLbWeek) };
    }
    if (goalKey === 'gain_muscle') {
      var floor = opts.muscleEmphasis ? 115 : 95;
      var surplus = Math.max(paceDelta, floor);
      return { adjustment: surplus, strategy: strategy, paceApplied: normalizePace(paceLbWeek) };
    }
    if (goalKey === 'body_recomp') {
      var trim = Math.min(240, Math.max(90, Math.round(paceDelta * 0.5)));
      return { adjustment: -trim, strategy: strategy, paceApplied: null };
    }
    if (goalKey === 'eat_healthier' || goalKey === 'improve_energy' || goalKey === 'maintain_weight') {
      return { adjustment: 0, strategy: strategy, paceApplied: null };
    }
    return { adjustment: 0, strategy: 'maintenance', paceApplied: null };
  }

  /**
   * Translate onboarding profile into Arc nutrition targets.
   * @param {{
   *   goal: string,
   *   goalPace?: number,
   *   weight: number,
   *   height: number,
   *   age: number,
   *   gender: string,
   *   activityLevel: string,
   *   weightUnit?: string,
   *   heightUnit?: string,
   *   muscleEmphasis?: boolean
   * }} input
   * @returns {{
   *   targetCalories: number,
   *   proteinTarget: number,
   *   fatTarget: number,
   *   carbTarget: number,
   *   strategy: string,
   *   maintenanceCalories: number,
   *   goal: string,
   *   paceLbWeek: number|null,
   *   calorieAdjustment: number
   * }}
   */
  function computeGoalTargets(input) {
    input = input || {};
    var nut = Nutrition();
    if (!nut) {
      throw new Error('[Arc Goal Engine] ArcEngine.Nutrition must load before arcGoalEngine.js');
    }

    var goalKey = normalizeGoal(input.goal);
    var pace = input.goalPace != null ? normalizePace(input.goalPace) : 0.5;
    var phys = nut.calculateMaintenanceCalories(input);
    var calAdj = calorieAdjustmentForGoal(goalKey, pace, { muscleEmphasis: input.muscleEmphasis });
    var targetCalories = nut.calculateCalories(phys.maintenanceCalories, calAdj.adjustment);

    var macros = nut.buildMacroTargets({
      weight: phys.weightLb,
      weightUnit: 'lb',
      height: phys.heightCm,
      heightUnit: 'cm',
      age: phys.age,
      gender: phys.gender,
      activityLevel: input.activityLevel,
      goal: goalKey,
      targetCalories: targetCalories,
      goalPace: calAdj.paceApplied != null ? pace : undefined,
      muscleEmphasis: input.muscleEmphasis
    });

    return {
      targetCalories: macros.targetCalories,
      proteinTarget: macros.protein,
      fatTarget: macros.fat,
      carbTarget: macros.carbs,
      strategy: calAdj.strategy,
      maintenanceCalories: macros.maintenanceCalories,
      goal: goalKey,
      paceLbWeek: calAdj.paceApplied,
      calorieAdjustment: calAdj.adjustment,
      bmr: macros.bmr,
      activityFactor: macros.activityFactor
    };
  }

  var api = {
    GOAL_ALIASES: GOAL_ALIASES,
    STRATEGIES: STRATEGIES,
    normalizeGoal: normalizeGoal,
    normalizePace: normalizePace,
    paceToDailyDelta: paceToDailyDelta,
    calorieAdjustmentForGoal: calorieAdjustmentForGoal,
    computeGoalTargets: computeGoalTargets
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.Goal = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
