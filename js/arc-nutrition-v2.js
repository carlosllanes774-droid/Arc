/**
 * Arc Nutrition System V2 — outcome-driven nutrition engine.
 * Hard-reject only safety/constraint violations; rank everything else by quality.
 */
(function (global) {
  'use strict';

  var MIN_MEAL_CALORIES = 250;
  var MAX_MEAL_CALORIES = 1800;
  var MIN_MAIN_MEAL_PROTEIN_G = 15;

  var PROTEIN_KEYWORDS = ['chicken', 'turkey', 'beef', 'salmon', 'tuna', 'shrimp', 'tofu', 'tempeh', 'egg', 'yogurt', 'cottage cheese', 'lentil', 'beans', 'chickpea', 'fish', 'pork', 'lamb'];
  var PROCESSED_KEYWORDS = ['instant', 'powdered', 'processed', 'refined', 'syrup', 'shortening', 'margarine', 'frozen meal', 'hot dog', 'nugget', 'ramen'];
  var WHOLE_FOOD_KEYWORDS = ['spinach', 'broccoli', 'sweet potato', 'oats', 'quinoa', 'brown rice', 'avocado', 'berries', 'tomato', 'pepper', 'onion', 'garlic', 'beans', 'lentils', 'chickpeas', 'kale', 'carrot', 'apple', 'banana'];
  var FIBER_KEYWORDS = ['beans', 'lentils', 'oats', 'broccoli', 'spinach', 'berries', 'quinoa', 'chickpea', 'vegetable', 'whole grain', 'bran', 'flax', 'chia'];
  var SATIETY_KEYWORDS = ['beans', 'lentils', 'potato', 'oats', 'vegetable', 'yogurt', 'egg', 'chicken', 'tofu', 'broccoli', 'rice'];
  var SNACK_KEYWORDS = ['snack', 'bar', 'bite', 'shake', 'smoothie'];
  var BUDGET_MAX_PRICE = { budget: 7, moderate: 12, flexible: null };

  function toNumber(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function normalizeText(s) {
    return String(s || '').toLowerCase();
  }

  function normalizeGoal(goal) {
    var g = normalizeText(goal);
    if (g.indexOf('muscle') !== -1 || g.indexOf('gain weight') !== -1) return 'muscle_gain';
    if (g.indexOf('lose') !== -1 || g.indexOf('fat') !== -1) return 'fat_loss';
    if (g.indexOf('athlet') !== -1 || g.indexOf('performance') !== -1) return 'athletic_performance';
    return 'maintenance';
  }

  function isSnackCategory(cat) {
    return /snack/i.test(String(cat || ''));
  }

  function isMainMealCategory(cat) {
    return !isSnackCategory(cat);
  }

  function extractNutrition(recipe) {
    recipe = recipe || {};
    var nutrition = recipe.nutrition && typeof recipe.nutrition === 'object' ? recipe.nutrition : recipe;
    return {
      calories: toNumber(nutrition.calories || recipe.calories || recipe.cal),
      protein: toNumber(nutrition.protein || recipe.protein || recipe.p),
      carbs: toNumber(nutrition.carbs || recipe.carbs || recipe.c),
      fat: toNumber(nutrition.fat || recipe.fat || recipe.f),
      fiber: toNumber(nutrition.fiber || recipe.fiber)
    };
  }

  function collectIngredientLines(recipe) {
    var list = Array.isArray(recipe && recipe.ingredients) ? recipe.ingredients : (Array.isArray(recipe && recipe.ing) ? recipe.ing : []);
    return list.map(function (i) {
      if (typeof i === 'string') return normalizeText(i);
      return normalizeText(i && (i.original || i.name || ''));
    }).filter(Boolean);
  }

  function containsAny(text, words) {
    var i;
    for (i = 0; i < words.length; i++) {
      if (text.indexOf(words[i]) !== -1) return true;
    }
    return false;
  }

  function countMatches(texts, words) {
    var count = 0;
    texts.forEach(function (t) {
      if (containsAny(t, words)) count++;
    });
    return count;
  }

  function deriveSignals(recipe) {
    recipe = recipe || {};
    var title = normalizeText(recipe.title || recipe.name);
    var tags = Array.isArray(recipe.tags) ? recipe.tags.map(normalizeText) : [];
    var ingredients = collectIngredientLines(recipe);
    var blob = [title].concat(tags).concat(ingredients).join(' ');
    return {
      ingredients: ingredients,
      blob: blob,
      isSnack: containsAny(blob, SNACK_KEYWORDS) || isSnackCategory(recipe.cat)
    };
  }

  function budgetTierKey(tier) {
    var t = normalizeText(tier);
    if (t.indexOf('budget') !== -1) return 'budget';
    if (t.indexOf('flex') !== -1) return 'flexible';
    return 'moderate';
  }

  /**
   * Hard rejection — safety and constraint violations only (Tier 1–2 constraints).
   * @param {object} recipe
   * @param {{ cat?: string, budgetTier?: string, budget?: string, price?: number }} [options]
   * @returns {{ rejected: boolean, reasons: string[] }}
   */
  function shouldHardRejectRecipe(recipe, options) {
    options = options || {};
    var signals = deriveSignals(recipe);
    var cat = options.cat || recipe.cat || '';
    var macros = extractNutrition(recipe);
    var reasons = [];

    if (macros.calories > 0 && macros.calories < MIN_MEAL_CALORIES) {
      reasons.push('calories_below_minimum');
    }
    if (macros.calories > MAX_MEAL_CALORIES) {
      reasons.push('calories_above_maximum');
    }
    if (isMainMealCategory(cat) && !signals.isSnack && macros.protein > 0 && macros.protein < MIN_MAIN_MEAL_PROTEIN_G) {
      reasons.push('protein_below_main_meal_minimum');
    }

    var processedHits = countMatches(signals.ingredients, PROCESSED_KEYWORDS);
    if (processedHits >= 4) reasons.push('poor_ingredient_quality');

    var budgetKey = budgetTierKey(options.budgetTier || options.budget || recipe.budget);
    var maxPrice = BUDGET_MAX_PRICE[budgetKey];
    var price = toNumber(options.price != null ? options.price : recipe.price);
    if (maxPrice != null && price > maxPrice + 0.01) {
      reasons.push('budget_exceeded');
    }

    return { rejected: reasons.length > 0, reasons: reasons };
  }

  function goalWeights(goal) {
    var g = normalizeGoal(goal);
    if (g === 'muscle_gain') {
      return { protein: 1.35, calorieSurplus: 1.2, carbs: 1.15, satiety: 0.9, fiber: 0.95, sustainability: 1.0 };
    }
    if (g === 'fat_loss') {
      return { protein: 1.35, satiety: 1.25, fiber: 1.2, calorieControl: 1.15, sustainability: 1.05 };
    }
    if (g === 'athletic_performance') {
      return { protein: 1.25, carbs: 1.25, recovery: 1.15, sustainability: 0.95 };
    }
    return { balance: 1.15, sustainability: 1.2, variety: 1.1 };
  }

  /**
   * Daily protein guidance (g/kg bodyweight).
   * @param {string} goal
   * @returns {{ min: number, max: number }}
   */
  function dailyProteinRangePerKg(goal) {
    var g = normalizeGoal(goal);
    if (g === 'muscle_gain') return { min: 1.6, max: 2.2 };
    if (g === 'fat_loss') return { min: 1.8, max: 2.7 };
    return { min: 1.4, max: 2.0 };
  }

  /**
   * Tier 3 soft score — meal calorie alignment (never rejects).
   * @param {number} recipeCal
   * @param {number} targetCal
   * @returns {number}
   */
  function mealCalorieSoftScore(recipeCal, targetCal) {
    recipeCal = toNumber(recipeCal);
    targetCal = toNumber(targetCal);
    if (!(targetCal > 0) || !(recipeCal > 0)) return 0;
    var diffPct = Math.abs(recipeCal - targetCal) / targetCal;
    return Math.max(0, 8 - diffPct * 16);
  }

  /**
   * Quality ranking score — recipes are ranked, not rejected, for Tier 3 factors.
   * @param {object} recipe
   * @param {object} [options]
   * @returns {{ total: number, breakdown: object }}
   */
  function scoreRecipeQuality(recipe, options) {
    options = options || {};
    var signals = deriveSignals(recipe);
    var macros = extractNutrition(recipe);
    var calories = macros.calories;
    var protein = macros.protein;
    var carbs = macros.carbs;
    var fat = macros.fat;
    var fiber = macros.fiber;
    var prepTime = toNumber(recipe.prepTime || recipe.readyInMinutes || parseInt(String(recipe.time || '').replace(/[^0-9]/g, ''), 10));
    var ingredientCount = signals.ingredients.length;
    var weights = goalWeights(options.goal || options.profile && options.profile.goal);
    var isSnack = signals.isSnack;

    var proteinQuality = clamp(countMatches(signals.ingredients, PROTEIN_KEYWORDS) * 2.5, 0, 12);
    if (protein >= 25) proteinQuality += 2;

    var proteinDensity = clamp((protein / Math.max(1, calories)) * 140, 0, 14);
    if (isSnack) proteinDensity *= 0.6;
    proteinDensity *= weights.protein || 1;

    var micronutrientDensity = clamp(countMatches(signals.ingredients, WHOLE_FOOD_KEYWORDS) * 1.8, 0, 12);
    var fiberContent = clamp((fiber > 0 ? fiber * 0.8 : 0) + countMatches(signals.ingredients, FIBER_KEYWORDS) * 1.5, 0, 10);
    fiberContent *= weights.fiber || 1;

    var wholeFoodHits = countMatches(signals.ingredients, WHOLE_FOOD_KEYWORDS);
    var processedHits = countMatches(signals.ingredients, PROCESSED_KEYWORDS);
    var ingredientQuality = clamp(6 + wholeFoodHits * 1.8 - processedHits * 2.2, 0, 12);

    var costEfficiency = 8;
    if (protein >= 30) costEfficiency += 1.5;
    var budgetKey = budgetTierKey(options.budgetTier || options.budget);
    if (budgetKey === 'budget' && countMatches(signals.ingredients, ['salmon', 'steak', 'asparagus']) > 1) costEfficiency -= 2.5;
    if (ingredientCount > 12) costEfficiency -= 1.5;
    costEfficiency = clamp(costEfficiency, 0, 10);

    var prepSimplicity = 10;
    if (ingredientCount > 14) prepSimplicity -= 4;
    if (prepTime > 45) prepSimplicity -= 4;
    if (options.busy && prepTime > 30) prepSimplicity -= 2;
    prepSimplicity = clamp(prepSimplicity, 0, 10);

    var preferenceMatch = clamp(toNumber(options.preferenceMatch), 0, 10);
    var overlap = clamp(toNumber(options.ingredientOverlap) * 10, 0, 10);

    var adherenceLikelihood = 6;
    if (containsAny(signals.blob, ['loaded', 'deep fried', 'triple', 'extreme'])) adherenceLikelihood -= 3;
    if (ingredientCount >= 5 && ingredientCount <= 11) adherenceLikelihood += 2;
    if (countMatches(signals.ingredients, SATIETY_KEYWORDS) >= 2) adherenceLikelihood += 1.5;
    adherenceLikelihood *= weights.sustainability || 1;
    adherenceLikelihood = clamp(adherenceLikelihood, 0, 10);

    if (weights.carbs && carbs >= 30) proteinQuality += 0.5;
    if (weights.satiety && countMatches(signals.ingredients, SATIETY_KEYWORDS) >= 2) adherenceLikelihood += 0.5;

    var breakdown = {
      proteinQuality: Math.round(proteinQuality * 10) / 10,
      proteinDensity: Math.round(proteinDensity * 10) / 10,
      micronutrientDensity: Math.round(micronutrientDensity * 10) / 10,
      fiberContent: Math.round(fiberContent * 10) / 10,
      ingredientQuality: Math.round(ingredientQuality * 10) / 10,
      costEfficiency: Math.round(costEfficiency * 10) / 10,
      preparationSimplicity: Math.round(prepSimplicity * 10) / 10,
      userPreferenceMatch: Math.round(preferenceMatch * 10) / 10,
      ingredientOverlap: Math.round(overlap * 10) / 10,
      adherenceLikelihood: Math.round(adherenceLikelihood * 10) / 10
    };

    var total = 0;
    var k;
    for (k in breakdown) total += breakdown[k];

    return { total: Math.round(clamp(total, 1, 100)), breakdown: breakdown };
  }

  /**
   * Outcome-driven nutrition prompt block for AI recipe generation.
   */
  function formatNutritionPromptBlock(mt, calT, macros, goal) {
    mt = mt || {};
    macros = macros || {};
    var r = Math.round;
    var proteinRange = dailyProteinRangePerKg(goal);
    var weightKg = toNumber(macros.weightKg);
    var dailyProteinNote = '';
    if (weightKg > 0) {
      dailyProteinNote = ' (~' + r(weightKg * proteinRange.min) + '–' + r(weightKg * proteinRange.max) + ' g/day at ' +
        proteinRange.min + '–' + proteinRange.max + ' g/kg)';
    }

    var lines = [];
    lines.push('=== ARC NUTRITION V2 — OUTCOME-DRIVEN PLANNING ===');
    lines.push('Arc optimizes for goal achievement, adherence, protein adequacy, food quality, and sustainability — NOT exact per-meal calorie matching.');
    lines.push('');
    lines.push('DAILY TARGETS (primary evaluation level):');
    lines.push('- Calories: ' + calT + ' kcal/day across ' + (mt.n || mt.slots && mt.slots.length || 3) + ' eating occasion(s)');
    lines.push('- Protein: ' + macros.protein + ' g/day' + dailyProteinNote);
    lines.push('- Carbs: ' + macros.carbs + ' g/day · Fat: ' + macros.fat + ' g/day');
    lines.push('');
    lines.push('MEAL STRUCTURE — flexible sizing is valid. Examples: Breakfast 500 + Lunch 700 + Dinner 1500 kcal, OR three ~900 kcal meals.');
    lines.push('Individual recipes may be below or above category averages if they help the user succeed. The planner balances the day via portions, sides, and snacks.');
    lines.push('');
    lines.push('REFERENCE CATEGORY AVERAGES (soft guidance — not strict per-meal matching):');
    if (mt.Breakfast) lines.push('- Breakfast: ~' + r(mt.Breakfast.cal) + ' kcal, ~' + r(mt.Breakfast.p) + ' g protein');
    if (mt.Lunch) lines.push('- Lunch: ~' + r(mt.Lunch.cal) + ' kcal, ~' + r(mt.Lunch.p) + ' g protein');
    if (mt.Dinner) lines.push('- Dinner: ~' + r(mt.Dinner.cal) + ' kcal, ~' + r(mt.Dinner.p) + ' g protein');
    if (mt.Snack) lines.push('- Snack: ~' + r(mt.Snack.cal) + ' kcal, ~' + r(mt.Snack.p) + ' g protein');
    if (mt.perSlot) {
      lines.push('- Equal-split reference per slot: ~' + r(mt.perSlot.cal) + ' kcal, ~' + r(mt.perSlot.p) + ' g protein');
    }
    lines.push('');
    lines.push('HARD RULES for each recipe:');
    lines.push('- Calories must be between ' + MIN_MEAL_CALORIES + ' and ' + MAX_MEAL_CALORIES + ' kcal per serving');
    lines.push('- Main meals (Breakfast/Lunch/Dinner) must provide at least ' + MIN_MAIN_MEAL_PROTEIN_G + ' g protein');
    lines.push('- Macros (cal, p, c, f) must mathematically align with ingredients (4/4/9 rule)');
    lines.push('- Daily totals across a full day of meals should approximate DAILY TARGETS — adjust portions so weekly options can compose coherent days');
    lines.push('');
    lines.push('Do NOT reject or force-fit recipes solely because they differ from category averages. Vary meal sizes naturally.');
    return lines.join('\n') + '\n';
  }

  var api = {
    MIN_MEAL_CALORIES: MIN_MEAL_CALORIES,
    MAX_MEAL_CALORIES: MAX_MEAL_CALORIES,
    MIN_MAIN_MEAL_PROTEIN_G: MIN_MAIN_MEAL_PROTEIN_G,
    isSnackCategory: isSnackCategory,
    isMainMealCategory: isMainMealCategory,
    extractNutrition: extractNutrition,
    shouldHardRejectRecipe: shouldHardRejectRecipe,
    scoreRecipeQuality: scoreRecipeQuality,
    mealCalorieSoftScore: mealCalorieSoftScore,
    formatNutritionPromptBlock: formatNutritionPromptBlock,
    goalWeights: goalWeights,
    dailyProteinRangePerKg: dailyProteinRangePerKg,
    normalizeGoal: normalizeGoal
  };

  global.ArcNutritionV2 = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
