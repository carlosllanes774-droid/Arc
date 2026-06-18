/**
 * Arc Nutrition Engine — trusted calorie and macro calculations.
 * Foundation layer for Arc's intelligence stack (no external APIs).
 */
(function (global) {
  'use strict';

  /** Mifflin–St Jeor activity multipliers (aligned with Arc onboarding). */
  var ACTIVITY_FACTORS = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    moderately_active: 1.55,
    'very active': 1.725,
    very_active: 1.725,
    athlete: 1.9
  };

  var ONBOARDING_ACTIVITY_MAP = {
    Sedentary: 'sedentary',
    Light: 'light',
    Moderate: 'moderate',
    'Moderately active': 'moderate',
    'Very active': 'very_active',
    Athlete: 'athlete'
  };

  /**
   * Normalize activity level strings from onboarding or engine input.
   * @param {string} activityLevel
   * @returns {string}
   */
  function normalizeActivityLevel(activityLevel) {
    if (activityLevel == null) return 'moderate';
    var raw = String(activityLevel).trim();
    if (ONBOARDING_ACTIVITY_MAP[raw]) return ONBOARDING_ACTIVITY_MAP[raw];
    var key = raw.toLowerCase().replace(/\s+/g, '_');
    if (ACTIVITY_FACTORS[key] != null) return key;
    if (key.indexOf('moderate') !== -1) return 'moderate';
    if (key.indexOf('sedentary') !== -1) return 'sedentary';
    if (key.indexOf('athlete') !== -1) return 'athlete';
    if (key.indexOf('very') !== -1) return 'very_active';
    if (key.indexOf('light') !== -1) return 'light';
    return 'moderate';
  }

  /**
   * @param {string} gender
   * @returns {'male'|'female'}
   */
  function normalizeGender(gender) {
    var g = gender != null ? String(gender).trim().toLowerCase() : 'male';
    if (g === 'f' || g === 'female' || g === 'woman' || g === 'women') return 'female';
    return 'male';
  }

  /**
   * Coerce weight to pounds.
   * @param {number} weight
   * @param {'lb'|'kg'|string} [unit]
   * @returns {number}
   */
  function weightToLb(weight, unit) {
    var w = Number(weight);
    if (!isFinite(w) || w <= 0) return 170;
    var u = unit != null ? String(unit).toLowerCase() : 'lb';
    if (u === 'kg' || u === 'kilogram' || u === 'kilograms') return w * 2.20462;
    return w;
  }

  /**
   * Coerce height to centimeters.
   * @param {number} height
   * @param {'in'|'cm'|string} [unit]
   * @returns {number}
   */
  function heightToCm(height, unit) {
    var h = Number(height);
    if (!isFinite(h) || h <= 0) return 170;
    var u = unit != null ? String(unit).toLowerCase() : 'in';
    if (u === 'in' || u === 'inch' || u === 'inches') return h * 2.54;
    return h;
  }

  /**
   * Clamp a value between min and max.
   * @param {number} n
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Mifflin–St Jeor basal metabolic rate (kcal/day).
   * @param {{ weightLb: number, heightCm: number, age: number, gender: string }} params
   * @returns {number}
   */
  function calculateBMR(params) {
    var weightKg = params.weightLb * 0.453592;
    var heightCm = params.heightCm;
    var age = params.age;
    if (params.gender === 'female') {
      return (10 * weightKg) + (6.25 * heightCm) - (5 * age) - 161;
    }
    return (10 * weightKg) + (6.25 * heightCm) - (5 * age) + 5;
  }

  /**
   * Maintenance calories (TDEE) via Mifflin–St Jeor × activity factor.
   * @param {{
   *   weight: number,
   *   height: number,
   *   age: number,
   *   gender: string,
   *   activityLevel: string,
   *   weightUnit?: string,
   *   heightUnit?: string
   * }} input
   * @returns {{ maintenanceCalories: number, bmr: number, activityFactor: number, weightLb: number, heightCm: number }}
   */
  function calculateMaintenanceCalories(input) {
    input = input || {};
    var weightLb = weightToLb(input.weight, input.weightUnit);
    var heightCm = heightToCm(input.height, input.heightUnit);
    var age = parseInt(input.age, 10);
    if (!isFinite(age) || age < 14) age = 30;
    if (age > 100) age = 100;
    var gender = normalizeGender(input.gender);
    var activityKey = normalizeActivityLevel(input.activityLevel);
    var factor = ACTIVITY_FACTORS[activityKey] || 1.55;
    var bmr = calculateBMR({ weightLb: weightLb, heightCm: heightCm, age: age, gender: gender });
    var maintenance = Math.round(bmr * factor);
    return {
      maintenanceCalories: maintenance,
      bmr: Math.round(bmr),
      activityFactor: factor,
      weightLb: weightLb,
      heightCm: heightCm,
      age: age,
      gender: gender,
      activityLevel: activityKey
    };
  }

  /**
   * Protein grams per lb by goal profile (Arc guidance ranges).
   * @param {string} goalKey - normalized goal slug
   * @param {string} activityKey
   * @param {{ goalPace?: number, muscleEmphasis?: boolean }} [opts]
   * @returns {{ gramsPerLb: number, minPerLb: number, maxPerLb: number }}
   */
  function proteinRangeForGoal(goalKey, activityKey, opts) {
    opts = opts || {};
    var minR = 0.8;
    var maxR = 1.0;
    var t = 0.5;

    if (goalKey === 'lose_weight') {
      minR = 0.8;
      maxR = 1.0;
      var pace = Number(opts.goalPace);
      if (isFinite(pace) && pace >= 0.75) t = 0.85;
      else if (isFinite(pace) && pace <= 0.25) t = 0.35;
    } else if (goalKey === 'gain_weight') {
      minR = 0.8;
      maxR = 1.0;
      t = 0.45;
    } else if (goalKey === 'body_recomp') {
      minR = 1.0;
      maxR = 1.2;
      t = 0.6;
    } else if (goalKey === 'gain_muscle') {
      minR = 1.0;
      maxR = 1.15;
      t = 0.75;
      if (opts.muscleEmphasis) t = 0.9;
    } else if (goalKey === 'maintain_weight' || goalKey === 'eat_healthier') {
      minR = 0.8;
      maxR = 0.95;
      t = 0.45;
    } else if (goalKey === 'improve_energy') {
      minR = 0.8;
      maxR = 0.95;
      t = 0.4;
    }

    if (activityKey === 'athlete' || activityKey === 'very_active') {
      if (goalKey === 'body_recomp' || goalKey === 'gain_muscle') {
        minR = 0.95;
        maxR = 1.1;
      } else {
        minR = 0.9;
        maxR = 1.1;
      }
      t = Math.max(t, 0.55);
    }

    return {
      gramsPerLb: minR + (maxR - minR) * t,
      minPerLb: minR,
      maxPerLb: maxR
    };
  }

  /**
   * Daily protein target in grams.
   * @param {{
   *   weight: number,
   *   goal?: string,
   *   activityLevel?: string,
   *   targetCalories?: number,
   *   goalPace?: number,
   *   weightUnit?: string,
   *   muscleEmphasis?: boolean
   * }} input
   * @returns {number}
   */
  function calculateProtein(input) {
    input = input || {};
    var weightLb = weightToLb(input.weight, input.weightUnit);
    var goalKey = normalizeGoalSlug(input.goal);
    var activityKey = normalizeActivityLevel(input.activityLevel);
    var range = proteinRangeForGoal(goalKey, activityKey, {
      goalPace: input.goalPace,
      muscleEmphasis: input.muscleEmphasis
    });
    var grams = weightLb * range.gramsPerLb;
    var cap = activityKey === 'athlete' ? weightLb * 1.1 : weightLb * 1.05;
    if (grams > cap) grams = cap;

    var cals = Number(input.targetCalories);
    if (isFinite(cals) && cals > 0) {
      var maxByCal = Math.floor((cals * 0.4) / 4);
      if (grams > maxByCal) grams = maxByCal;
    }

    return roundMacro(grams, 5, 55);
  }

  /**
   * Fat target: 20–35% of calories (goal-aware within band).
   * @param {number} calories
   * @param {string} [goal]
   * @returns {number} grams
   */
  function calculateFat(calories, goal) {
    var cals = Number(calories);
    if (!isFinite(cals) || cals <= 0) return 0;
    var goalKey = normalizeGoalSlug(goal);
    var pct = 0.28;
    if (goalKey === 'lose_weight') pct = 0.25;
    else if (goalKey === 'gain_muscle' || goalKey === 'gain_weight') pct = 0.27;
    else if (goalKey === 'improve_energy' || goalKey === 'eat_healthier') pct = 0.3;
    else if (goalKey === 'body_recomp') pct = 0.26;
    pct = clamp(pct, 0.2, 0.35);
    return roundMacro((cals * pct) / 9, 1, 35);
  }

  /**
   * Carb target from remaining calories after protein and fat.
   * @param {number} calories
   * @param {number} proteinGrams
   * @param {number} fatGrams
   * @returns {number}
   */
  function calculateCarbs(calories, proteinGrams, fatGrams) {
    var cals = Number(calories);
    var p = Number(proteinGrams) || 0;
    var f = Number(fatGrams) || 0;
    if (!isFinite(cals) || cals <= 0) return 0;
    var remaining = cals - (p * 4) - (f * 9);
    if (remaining < 120) remaining = 120;
    return roundMacro(remaining / 4, 1, 40);
  }

  /**
   * Apply calorie adjustment to maintenance (deficit/surplus already computed).
   * @param {number} maintenance
   * @param {number} adjustment
   * @returns {number}
   */
  function calculateCalories(maintenance, adjustment) {
    var m = Math.round(Number(maintenance));
    var adj = Number(adjustment) || 0;
    if (!isFinite(m) || m <= 0) m = 2000;
    return clamp(Math.round(m + adj), 1200, 5500);
  }

  /**
   * Round macro grams to step with floor.
   * @param {number} g
   * @param {number} step
   * @param {number} floor
   * @returns {number}
   */
  function roundMacro(g, step, floor) {
    if (!isFinite(g) || g <= 0) return floor || 0;
    var r = Math.round(g / step) * step;
    return Math.max(floor || 0, r);
  }

  /**
   * Normalize goal to internal slug.
   * @param {string} goal
   * @returns {string}
   */
  function normalizeGoalSlug(goal) {
    var g = goal != null ? String(goal).trim().toLowerCase() : '';
    if (g === 'build muscle') return 'gain_muscle';
    return g.replace(/\s+/g, '_');
  }

  /**
   * Full macro object from physiology + calorie target.
   * @param {{
   *   weight: number,
   *   height: number,
   *   age: number,
   *   gender: string,
   *   activityLevel: string,
   *   goal?: string,
   *   targetCalories: number,
   *   goalPace?: number,
   *   weightUnit?: string,
   *   heightUnit?: string,
   *   muscleEmphasis?: boolean
   * }} input
   * @returns {object}
   */
  function buildMacroTargets(input) {
    input = input || {};
    var phys = calculateMaintenanceCalories(input);
    var calories = Number(input.targetCalories);
    if (!isFinite(calories) || calories <= 0) calories = phys.maintenanceCalories;

    var protein = calculateProtein({
      weight: phys.weightLb,
      weightUnit: 'lb',
      goal: input.goal,
      activityLevel: input.activityLevel,
      targetCalories: calories,
      goalPace: input.goalPace,
      muscleEmphasis: input.muscleEmphasis
    });
    var fat = calculateFat(calories, input.goal);
    var carbs = calculateCarbs(calories, protein, fat);

    var cur = protein * 4 + carbs * 4 + fat * 9;
    var diff = calories - cur;
    if (Math.abs(diff) >= 12) {
      carbs = roundMacro(carbs + diff / 4, 1, 40);
    }

    return {
      maintenanceCalories: phys.maintenanceCalories,
      targetCalories: calories,
      protein,
      fat,
      carbs,
      bmr: phys.bmr,
      activityFactor: phys.activityFactor,
      weightLb: phys.weightLb,
      heightCm: phys.heightCm
    };
  }

  var api = {
    ACTIVITY_FACTORS: ACTIVITY_FACTORS,
    normalizeActivityLevel: normalizeActivityLevel,
    normalizeGender: normalizeGender,
    normalizeGoalSlug: normalizeGoalSlug,
    weightToLb: weightToLb,
    heightToCm: heightToCm,
    calculateBMR: calculateBMR,
    calculateMaintenanceCalories: calculateMaintenanceCalories,
    calculateProtein: calculateProtein,
    calculateFat: calculateFat,
    calculateCarbs: calculateCarbs,
    calculateCalories: calculateCalories,
    buildMacroTargets: buildMacroTargets,
    proteinRangeForGoal: proteinRangeForGoal
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.Nutrition = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
