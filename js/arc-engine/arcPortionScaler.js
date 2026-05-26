/**
 * Arc Portion Scaler — scale recipe portions to hit user targets while preserving ratios.
 */
(function (global) {
  'use strict';

  /**
   * Sum numeric field across ingredients.
   * @param {Array<object>} ingredients
   * @param {string} field
   * @returns {number}
   */
  function sumIngredientField(ingredients, field) {
    if (!Array.isArray(ingredients)) return 0;
    return ingredients.reduce(function (acc, ing) {
      var v = Number(ing && ing[field]);
      return acc + (isFinite(v) ? v : 0);
    }, 0);
  }

  /**
   * Extract recipe nutrition totals.
   * @param {object} recipe
   * @returns {{ calories: number, protein: number, carbs: number, fat: number }}
   */
  function extractRecipeNutrition(recipe) {
    recipe = recipe || {};
    if (recipe.nutrition) {
      return {
        calories: Number(recipe.nutrition.calories) || 0,
        protein: Number(recipe.nutrition.protein) || 0,
        carbs: Number(recipe.nutrition.carbs) || 0,
        fat: Number(recipe.nutrition.fat) || 0
      };
    }
    return {
      calories: Number(recipe.calories) || 0,
      protein: Number(recipe.protein) || 0,
      carbs: Number(recipe.carbs) || 0,
      fat: Number(recipe.fat) || 0
    };
  }

  /**
   * Choose scale factor: prefer calorie match, fall back to protein-led scaling.
   * @param {object} current
   * @param {object} target
   * @param {object} [opts]
   * @returns {number}
   */
  function computeScaleFactor(current, target, opts) {
    opts = opts || {};
    var calScale = current.calories > 0 && target.calories > 0
      ? target.calories / current.calories
      : null;
    var protScale = current.protein > 0 && target.protein > 0
      ? target.protein / current.protein
      : null;

    var factor = calScale != null ? calScale : (protScale != null ? protScale : 1);
    if (opts.preferProtein && protScale != null) {
      factor = protScale * 0.35 + factor * 0.65;
    }

    if (!isFinite(factor) || factor <= 0) factor = 1;
    return Math.min(2.5, Math.max(0.4, factor));
  }

  /**
   * Scale ingredient quantities by factor; preserve unit and name.
   * @param {Array<object>} ingredients
   * @param {number} factor
   * @returns {Array<object>}
   */
  function scaleIngredients(ingredients, factor) {
    if (!Array.isArray(ingredients)) return [];
    return ingredients.map(function (ing) {
      ing = ing || {};
      var qty = Number(ing.quantity != null ? ing.quantity : ing.amount);
      var scaledQty = isFinite(qty) ? roundQuantity(qty * factor) : ing.quantity;
      var out = Object.assign({}, ing);
      if (ing.quantity != null) out.quantity = scaledQty;
      if (ing.amount != null) out.amount = scaledQty;
      if (ing.grams != null) out.grams = roundQuantity(Number(ing.grams) * factor);
      if (ing.calories != null) out.calories = roundQuantity(Number(ing.calories) * factor);
      if (ing.protein != null) out.protein = roundQuantity(Number(ing.protein) * factor);
      if (ing.carbs != null) out.carbs = roundQuantity(Number(ing.carbs) * factor);
      if (ing.fat != null) out.fat = roundQuantity(Number(ing.fat) * factor);
      out.scaleFactor = factor;
      return out;
    });
  }

  /**
   * @param {number} n
   * @returns {number}
   */
  function roundQuantity(n) {
    if (!isFinite(n)) return 0;
    if (n >= 100) return Math.round(n);
    if (n >= 10) return Math.round(n * 10) / 10;
    return Math.round(n * 100) / 100;
  }

  /**
   * Scale a recipe to approximate user slot or daily targets.
   * @param {{
   *   name?: string,
   *   calories?: number,
   *   protein?: number,
   *   carbs?: number,
   *   fat?: number,
   *   nutrition?: object,
   *   ingredients?: Array<object>
   * }} recipeNutrition
   * @param {{
   *   calories?: number,
   *   protein?: number,
   *   carbs?: number,
   *   fat?: number,
   *   targetCalories?: number,
   *   proteinTarget?: number,
   *   carbTarget?: number,
   *   fatTarget?: number
   * }} userTargets
   * @param {{ preferProtein?: boolean, maxScale?: number, minScale?: number }} [opts]
   * @returns {object}
   */
  function scaleRecipe(recipeNutrition, userTargets, opts) {
    opts = opts || {};
    var current = extractRecipeNutrition(recipeNutrition);
    var target = {
      calories: Number(userTargets.calories != null ? userTargets.calories : userTargets.targetCalories) || 0,
      protein: Number(userTargets.protein != null ? userTargets.protein : userTargets.proteinTarget) || 0,
      carbs: Number(userTargets.carbs != null ? userTargets.carbs : userTargets.carbTarget) || 0,
      fat: Number(userTargets.fat != null ? userTargets.fat : userTargets.fatTarget) || 0
    };

    var factor = computeScaleFactor(current, target, opts);
    if (opts.maxScale != null) factor = Math.min(factor, opts.maxScale);
    if (opts.minScale != null) factor = Math.max(factor, opts.minScale);

    var scaledIngredients = scaleIngredients(recipeNutrition.ingredients, factor);
    var scaledNutrition = {
      calories: Math.round(current.calories * factor),
      protein: Math.round(current.protein * factor),
      carbs: Math.round(current.carbs * factor),
      fat: Math.round(current.fat * factor)
    };

    return {
      recipeName: recipeNutrition.name || 'recipe',
      scaleFactor: Math.round(factor * 1000) / 1000,
      original: current,
      target: target,
      scaled: scaledNutrition,
      ingredients: scaledIngredients,
      delta: {
        calories: scaledNutrition.calories - current.calories,
        protein: scaledNutrition.protein - current.protein
      }
    };
  }

  var api = {
    extractRecipeNutrition: extractRecipeNutrition,
    computeScaleFactor: computeScaleFactor,
    scaleIngredients: scaleIngredients,
    scaleRecipe: scaleRecipe
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.PortionScaler = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
