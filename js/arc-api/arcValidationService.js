/**
 * Arc Validation Layer — catch bad API data before the user sees it.
 */
(function (global) {
  'use strict';

  var PROTEIN_G_PER_LB_MAX = 2.5;
  var CALORIES_PER_DAY_MAX = 10000;
  var CALORIES_PER_DAY_MIN = 800;
  var OIL_KEYWORDS = ['oil', 'butter', 'ghee', 'lard', 'shortening'];

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

    if (isFinite(cals) && cals < 50 && (p > 30 || c > 40 || f > 20)) impossible.push('macros_exceed_calories');
    if (p > 200) impossible.push('protein_impossible_single_meal');
    if (cals > 0 && p * 4 > cals * 1.1) impossible.push('protein_exceeds_calories');
    if (cals > 0 && f * 9 > cals * 1.15) impossible.push('fat_exceeds_calories');
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

  /**
   * @param {{ calories?: number, protein?: number, carbs?: number, fat?: number, fiber?: number }} macros
   * @returns {{ tags: string[], rules: object, balanced: boolean }}
   */
  function deriveNutritionTags(macros) {
    macros = macros || {};
    var calories = Math.max(0, Number(macros.calories) || 0);
    var protein = Math.max(0, Number(macros.protein) || 0);
    var carbs = Math.max(0, Number(macros.carbs) || 0);
    var fat = Math.max(0, Number(macros.fat) || 0);
    var fiber = Math.max(0, Number(macros.fiber) || 0);
    var calsFromMacros = protein * 4 + carbs * 4 + fat * 9;
    var denom = calories > 0 ? calories : (calsFromMacros > 0 ? calsFromMacros : 1);
    var carbPct = (carbs * 4) / denom;
    var protPct = (protein * 4) / denom;
    var fatPct = (fat * 9) / denom;

    var highProtein = protein >= 25;
    var lowCarb = carbPct <= 0.25;
    var highFiber = fiber >= 8;
    var balanced = protPct >= 0.18 && protPct <= 0.4 && carbPct >= 0.25 && carbPct <= 0.5 && fatPct >= 0.2 && fatPct <= 0.4;

    var tags = [];
    if (highProtein) tags.push('high_protein');
    if (lowCarb) tags.push('low_carb');
    if (highFiber) tags.push('high_fiber');
    if (balanced) tags.push('balanced');

    return {
      tags: tags,
      balanced: balanced,
      rules: {
        high_protein: highProtein,
        low_carb: lowCarb,
        high_fiber: highFiber,
        balanced: balanced
      }
    };
  }

  /**
   * Keep only tags that pass hard nutrition rules.
   * @param {string[]} tags
   * @param {{ calories?: number, protein?: number, carbs?: number, fat?: number, fiber?: number }} macros
   * @returns {{ validTags: string[], rejectedTags: string[] }}
   */
  function validateRecipeTags(tags, macros) {
    var requested = Array.isArray(tags) ? tags.map(function (t) { return String(t || '').trim().toLowerCase(); }).filter(Boolean) : [];
    var normalized = deriveNutritionTags(macros);
    var allowed = {};
    normalized.tags.forEach(function (t) { allowed[t] = true; });

    var validTags = [];
    var rejectedTags = [];
    requested.forEach(function (tag) {
      var canonical = tag.replace(/\s+/g, '_').replace(/-/g, '_');
      if (allowed[canonical]) validTags.push(canonical);
      else rejectedTags.push(canonical);
    });
    return { validTags: validTags, rejectedTags: rejectedTags };
  }

  /**
   * Basic serving-scale sanity checks.
   * @param {{ ingredients?: Array<object>, scaled?: object, scaleFactor?: number }} scaledRecipe
   * @returns {{ valid: boolean, issues: string[] }}
   */
  function validateServingScaling(scaledRecipe) {
    var issues = [];
    var ingredients = (scaledRecipe && Array.isArray(scaledRecipe.ingredients)) ? scaledRecipe.ingredients : [];
    var sf = Number(scaledRecipe && scaledRecipe.scaleFactor);
    if (!isFinite(sf) || sf <= 0) issues.push('invalid_scale_factor');
    ingredients.forEach(function (ing) {
      var qty = Number(ing && (ing.quantity != null ? ing.quantity : ing.amount));
      if (isFinite(qty) && qty < 0) issues.push('negative_scaled_quantity');
      var name = String((ing && (ing.name || ing.original)) || '').toLowerCase();
      if (isFinite(qty) && qty > 6) {
        var i;
        for (i = 0; i < OIL_KEYWORDS.length; i++) {
          if (name.indexOf(OIL_KEYWORDS[i]) !== -1) {
            issues.push('oil_scaling_explosion');
            break;
          }
        }
      }
    });
    return { valid: issues.length === 0, issues: issues };
  }

  /**
   * Pipeline-level nutrition guardrail checks.
   * @param {{ calories?: number, protein?: number, carbs?: number, fat?: number }} macros
   * @returns {{ valid: boolean, issues: string[] }}
   */
  function runNutritionSanityChecks(macros) {
    macros = macros || {};
    var issues = [];
    var calories = Number(macros.calories) || 0;
    var protein = Number(macros.protein) || 0;
    var carbs = Number(macros.carbs) || 0;
    var fat = Number(macros.fat) || 0;
    var computed = protein * 4 + carbs * 4 + fat * 9;
    if (!(calories > 0)) issues.push('missing_calories');
    if (fat > 0 && calories > 0 && fat * 9 > calories * 1.15) issues.push('fat_exceeds_calorie_math');
    if (protein < 8) issues.push('extremely_low_protein');
    if (calories > 0 && Math.abs(computed - calories) / calories > 0.2) issues.push('impossible_calorie_calculation');
    if (calories > 1800) issues.push('meal_calories_too_high');
    return { valid: issues.length === 0, issues: issues, computedCalories: Math.round(computed) };
  }

  var api = {
    validateNutritionConsistency: validateNutritionConsistency,
    detectMacroOutliers: detectMacroOutliers,
    verifyRecipeCompleteness: verifyRecipeCompleteness,
    detectImpossibleNutrition: detectImpossibleNutrition,
    deriveNutritionTags: deriveNutritionTags,
    validateRecipeTags: validateRecipeTags,
    validateServingScaling: validateServingScaling,
    runNutritionSanityChecks: runNutritionSanityChecks
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Validation = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
