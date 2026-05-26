/**
 * Arc Validation Layer — catch bad API data before the user sees it.
 */
(function (global) {
  'use strict';

  var PROTEIN_G_PER_LB_MAX = 2.5;
  var CALORIES_PER_DAY_MAX = 10000;
  var CALORIES_PER_DAY_MIN = 800;

  /**
   * @param {{ calories?: number, protein?: number, carbs?: number, fat?: number }} macros
   * @returns {object}
   */
  function validateNutritionConsistency(macros) {
    macros = macros || {};
    var issues = [];
    var cals = Number(macros.calories);
    var p = Number(macros.protein) || 0;
    var c = Number(macros.carbs) || 0;
    var f = Number(macros.fat) || 0;

    if (!isFinite(cals) || cals <= 0) issues.push('missing_or_invalid_calories');
    if (p < 0 || c < 0 || f < 0) issues.push('negative_macro');

    var computed = p * 4 + c * 4 + f * 9;
    if (isFinite(cals) && cals > 0) {
      var delta = Math.abs(computed - cals) / cals;
      if (delta > 0.2) issues.push('calorie_macro_mismatch');
    }

    return {
      valid: issues.length === 0,
      issues: issues,
      computedCalories: Math.round(computed)
    };
  }

  /**
   * @param {{ calories?: number, protein?: number, weightLb?: number, context?: 'meal'|'daily' }} macros
   * @returns {object}
   */
  function detectMacroOutliers(macros) {
    macros = macros || {};
    var flags = [];
    var cals = Number(macros.calories);
    var protein = Number(macros.protein);
    var context = macros.context || 'daily';
    var weightLb = Number(macros.weightLb) || 200;

    if (context === 'meal') {
      if (isFinite(cals) && cals > 2500) flags.push('meal_calories_out_of_range');
      if (isFinite(protein) && protein > 120) flags.push('protein_unrealistic');
      return { outliers: flags, acceptable: flags.length === 0 };
    }

    if (isFinite(cals) && (cals > CALORIES_PER_DAY_MAX || cals < CALORIES_PER_DAY_MIN)) {
      flags.push('calories_out_of_range');
    }
    if (isFinite(protein) && weightLb > 0) {
      var gPerLb = protein / weightLb;
      if (gPerLb > PROTEIN_G_PER_LB_MAX) flags.push('protein_unrealistic');
    }

    return { outliers: flags, acceptable: flags.length === 0 };
  }

  /**
   * @param {object} recipe
   * @returns {object}
   */
  function verifyRecipeCompleteness(recipe) {
    recipe = recipe || {};
    var missing = [];
    if (!recipe.title && !recipe.recipeId) missing.push('title_or_id');
    if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length) missing.push('ingredients');
    if (!recipe.servings) missing.push('servings');
    return { complete: missing.length === 0, missing: missing };
  }

  /**
   * @param {{ calories?: number, protein?: number, carbs?: number, fat?: number, weightLb?: number }} data
   * @returns {object}
   */
  function detectImpossibleNutrition(data) {
    data = data || {};
    var impossible = [];
    var cals = Number(data.calories);
    var p = Number(data.protein) || 0;
    var c = Number(data.carbs) || 0;
    var f = Number(data.fat) || 0;
    var context = data.context || 'meal';

    if (isFinite(cals) && cals < 50 && (p > 30 || c > 40)) impossible.push('macros_exceed_calories');
    if (p > 200) impossible.push('protein_impossible_single_meal');
    if (cals > 0 && p * 4 > cals * 1.1) impossible.push('protein_exceeds_calories');
    if (context === 'meal' && p + c + f > 350) impossible.push('gram_totals_impossible');
    if (context === 'daily' && p + c + f > 500) impossible.push('gram_totals_impossible');

    var consistency = validateNutritionConsistency(data);
    var outliers = detectMacroOutliers(data);

    return {
      impossible: impossible,
      consistency: consistency,
      outliers: outliers,
      safe: impossible.length === 0 && consistency.valid && outliers.acceptable
    };
  }

  var api = {
    validateNutritionConsistency: validateNutritionConsistency,
    detectMacroOutliers: detectMacroOutliers,
    verifyRecipeCompleteness: verifyRecipeCompleteness,
    detectImpossibleNutrition: detectImpossibleNutrition
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Validation = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
