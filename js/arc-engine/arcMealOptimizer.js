/**
 * Arc Meal Optimizer — deterministic meal strategy rules (not AI).
 * Future recipe and grocery inputs plug in here.
 */
(function (global) {
  'use strict';

  var STRATEGY_PRESETS = {
    high_protein: {
      id: 'high_protein',
      label: 'High protein',
      priority: ['protein_density', 'even_distribution', 'satiety'],
      macroBias: { proteinShift: 0.05, carbShift: -0.03 },
      mealCountHint: 4
    },
    budget_focused: {
      id: 'budget_focused',
      label: 'Budget focused',
      priority: ['cost_efficiency', 'batch_prep', 'staple_rotation'],
      macroBias: {},
      mealCountHint: 3
    },
    athlete_recovery: {
      id: 'athlete_recovery',
      label: 'Athlete recovery',
      priority: ['post_workout_carbs', 'hydration_friendly', 'protein_timing'],
      macroBias: { carbShift: 0.08, proteinShift: 0.02 },
      mealCountHint: 4
    },
    performance_carbs: {
      id: 'performance_carbs',
      label: 'Performance carbs',
      priority: ['training_day_carbs', 'glycogen_support', 'moderate_fat'],
      macroBias: { carbShift: 0.1, fatShift: -0.04 },
      mealCountHint: 5
    },
    higher_satiety: {
      id: 'higher_satiety',
      label: 'Higher satiety',
      priority: ['fiber_forward', 'protein_leverage', 'volume_eating'],
      macroBias: { proteinShift: 0.03, fatShift: 0.02 },
      mealCountHint: 4
    },
    lower_prep_burden: {
      id: 'lower_prep_burden',
      label: 'Lower prep burden',
      priority: ['minimal_steps', 'repeatable_mains', 'leftover_friendly'],
      macroBias: {},
      mealCountHint: 3
    }
  };

  /**
   * Pick primary optimizer preset from goal + modifiers.
   * @param {string} goalKey
   * @param {object} modifiers
   * @returns {string}
   */
  function selectPrimaryPreset(goalKey, modifiers) {
    modifiers = modifiers || {};
    if (modifiers.athletePhase === 'performance_day' || modifiers.dayType === 'high_output') {
      return 'performance_carbs';
    }
    if (modifiers.athletePhase === 'recovery_day' || modifiers.dayType === 'recovery') {
      return 'athlete_recovery';
    }
    if (modifiers.budgetTier === 'low') return 'budget_focused';
    if (goalKey === 'lose_weight') return 'higher_satiety';
    if (goalKey === 'gain_muscle') return 'high_protein';
    if (goalKey === 'improve_energy') return 'higher_satiety';
    if (modifiers.prepBurden === 'low' || modifiers.skill === 'Beginner') return 'lower_prep_burden';
    return 'high_protein';
  }

  /**
   * Build meal strategy from nutrition targets and optional constraints.
   * @param {{
   *   targetCalories: number,
   *   proteinTarget: number,
   *   fatTarget: number,
   *   carbTarget: number,
   *   strategy?: string,
   *   goal?: string
   * }} nutritionTargets
   * @param {{
   *   recipes?: Array<object>,
   *   groceryConstraints?: object,
   *   budgetTier?: string,
   *   athleteModifiers?: object,
   *   prepBurden?: string,
   *   skill?: string,
   *   mealsPerDay?: number
   * }} [options]
   * @returns {object}
   */
  function optimizeMeals(nutritionTargets, options) {
    options = options || {};
    nutritionTargets = nutritionTargets || {};
    var goalKey = nutritionTargets.goal || options.goal || 'maintain_weight';
    var modifiers = Object.assign({}, options.athleteModifiers || {}, {
      budgetTier: options.budgetTier,
      prepBurden: options.prepBurden,
      skill: options.skill
    });

    var presetId = selectPrimaryPreset(goalKey, modifiers);
    var preset = STRATEGY_PRESETS[presetId] || STRATEGY_PRESETS.high_protein;
    var mealsPerDay = options.mealsPerDay || preset.mealCountHint || 3;
    var slots = buildMealSlots(mealsPerDay, nutritionTargets, preset);

    return {
      presetId: preset.id,
      label: preset.label,
      priorities: preset.priority.slice(),
      macroBias: preset.macroBias,
      mealsPerDay: mealsPerDay,
      slots: slots,
      notes: buildStrategyNotes(goalKey, preset, options),
      recipeReady: Array.isArray(options.recipes) && options.recipes.length > 0,
      groceryReady: !!options.groceryConstraints
    };
  }

  /**
   * Split daily targets across meal slots.
   * @param {number} mealCount
   * @param {object} targets
   * @param {object} preset
   * @returns {Array<object>}
   */
  function buildMealSlots(mealCount, targets, preset) {
    var weights = mealCount === 5
      ? [0.2, 0.1, 0.3, 0.15, 0.25]
      : mealCount === 4
        ? [0.25, 0.1, 0.35, 0.3]
        : [0.28, 0.32, 0.4];
    var names = mealCount === 5
      ? ['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner']
      : mealCount === 4
        ? ['breakfast', 'snack', 'lunch', 'dinner']
        : ['breakfast', 'lunch', 'dinner'];

    if (preset.id === 'athlete_recovery' || preset.id === 'performance_carbs') {
      if (mealCount >= 4) weights = [0.22, 0.08, 0.28, 0.42];
    }

    return names.map(function (name, i) {
      var w = weights[i] || (1 / names.length);
      return {
        slot: name,
        weight: w,
        calories: Math.round((targets.targetCalories || 0) * w),
        protein: Math.round((targets.proteinTarget || 0) * w),
        carbs: Math.round((targets.carbTarget || 0) * w),
        fat: Math.round((targets.fatTarget || 0) * w)
      };
    });
  }

  /**
   * @param {string} goalKey
   * @param {object} preset
   * @param {object} options
   * @returns {string[]}
   */
  function buildStrategyNotes(goalKey, preset, options) {
    var notes = ['Arc optimizer preset: ' + preset.label + '.'];
    if (goalKey === 'lose_weight') notes.push('Emphasize protein-forward plates for satiety within deficit.');
    if (goalKey === 'body_recomp') notes.push('Keep protein elevated; distribute carbs around activity when known.');
    if (options.budgetTier === 'low') notes.push('Favor staple proteins and repeatable mains for cost stability.');
    if (!options.recipes || !options.recipes.length) {
      notes.push('Recipe list pending — Spoonacular discovery + Edamam nutrition + USDA verification via ArcApi.');
    }
    return notes;
  }

  var api = {
    STRATEGY_PRESETS: STRATEGY_PRESETS,
    selectPrimaryPreset: selectPrimaryPreset,
    optimizeMeals: optimizeMeals,
    buildMealSlots: buildMealSlots
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.MealOptimizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
