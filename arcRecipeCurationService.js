/**
 * Arc recipe curation engine.
 * Scores, filters, ranks, and variety-balances candidate meals.
 */
(function (global) {
  'use strict';

  var PROTEIN_KEYWORDS = ['chicken', 'turkey', 'beef', 'salmon', 'tuna', 'shrimp', 'tofu', 'tempeh', 'egg', 'yogurt', 'cottage cheese', 'lentil', 'beans'];
  var PROCESSED_KEYWORDS = ['instant', 'powdered', 'processed', 'refined', 'syrup', 'shortening', 'margarine', 'frozen meal'];
  var WHOLE_FOOD_KEYWORDS = ['spinach', 'broccoli', 'sweet potato', 'oats', 'quinoa', 'brown rice', 'avocado', 'berries', 'tomato', 'pepper', 'onion', 'garlic', 'beans', 'lentils', 'chickpeas'];
  var FLAVOR_KEYWORDS = ['garlic', 'ginger', 'paprika', 'lemon', 'lime', 'herb', 'spice', 'sauce', 'chili', 'pepper', 'cumin', 'soy', 'vinegar', 'mustard'];
  var TEXTURE_KEYWORDS = ['crispy', 'crunchy', 'creamy', 'tender', 'caramelized', 'charred'];
  var SATIETY_KEYWORDS = ['beans', 'lentils', 'potato', 'oats', 'vegetable', 'yogurt', 'egg', 'chicken', 'tofu', 'broccoli', 'rice'];
  var SNACK_KEYWORDS = ['snack', 'bar', 'bite', 'shake', 'smoothie'];
  var OIL_FAT_KEYWORDS = ['oil', 'butter', 'ghee', 'cream', 'mayo', 'shortening', 'lard'];
  var CUISINE_KEYWORDS = ['mexican', 'italian', 'mediterranean', 'indian', 'thai', 'japanese', 'american', 'korean'];

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

  function collectIngredientText(recipe) {
    var list = Array.isArray(recipe && recipe.ingredients) ? recipe.ingredients : [];
    return list.map(function (i) {
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
    var ingredients = collectIngredientText(recipe);
    var allText = [title].concat(tags).concat(ingredients);
    var blob = allText.join(' ');

    var proteins = [];
    PROTEIN_KEYWORDS.forEach(function (k) { if (blob.indexOf(k) !== -1) proteins.push(k); });
    var cuisines = [];
    CUISINE_KEYWORDS.forEach(function (k) { if (blob.indexOf(k) !== -1) cuisines.push(k); });
    var textures = [];
    TEXTURE_KEYWORDS.forEach(function (k) { if (blob.indexOf(k) !== -1) textures.push(k); });
    var keyIngredients = ingredients.slice(0, 8).map(function (line) {
      return line.replace(/[0-9/.,]+/g, '').trim().split(/\s+/).slice(-2).join(' ');
    }).filter(Boolean);

    return {
      proteins: proteins,
      cuisines: cuisines,
      textures: textures,
      ingredients: ingredients,
      keyIngredients: keyIngredients,
      blob: blob
    };
  }

  function mealContext(profile, scenario) {
    profile = profile || {};
    return {
      goal: normalizeText(profile.goal || ''),
      budgetTier: normalizeText(profile.budgetTier || ''),
      busy: !!profile.busySchedule || normalizeText(profile.schedule || '').indexOf('busy') !== -1,
      travel: !!profile.travelWeek || scenario === 'travel',
      athlete: !!profile.athlete || scenario === 'athlete_offseason' || normalizeText(profile.goal || '').indexOf('athlete') !== -1
    };
  }

  function scoreRecipe(recipe, options) {
    options = options || {};
    var ctx = mealContext(options.profile, options.scenario);
    var signals = deriveSignals(recipe);
    var nutrition = recipe && recipe.nutrition ? recipe.nutrition : recipe || {};
    var calories = toNumber(nutrition.calories || recipe.calories || recipe.cal);
    var protein = toNumber(nutrition.protein || recipe.protein || recipe.p);
    var carbs = toNumber(nutrition.carbs || recipe.carbs || recipe.c);
    var fat = toNumber(nutrition.fat || recipe.fat || recipe.f);
    var prepTime = toNumber(recipe.prepTime || recipe.readyInMinutes || 0);
    var ingredientCount = signals.ingredients.length || (Array.isArray(recipe.ingredients) ? recipe.ingredients.length : 0);
    var isSnack = containsAny(signals.blob, SNACK_KEYWORDS);

    var macroCalories = protein * 4 + carbs * 4 + fat * 9;
    var denom = calories > 0 ? calories : (macroCalories > 0 ? macroCalories : 1);
    var fatPct = (fat * 9) / denom;
    var proteinPct = (protein * 4) / denom;
    var carbPct = (carbs * 4) / denom;

    var proteinDensity = clamp((protein / Math.max(1, calories)) * 160, 0, 25);
    if (protein < 20 && !isSnack) proteinDensity = proteinDensity * 0.35;

    var macroBalance = 15;
    if (fatPct > 0.55) macroBalance -= 9;
    if (proteinPct < 0.15) macroBalance -= 5;
    if (carbPct < 0.05 || carbPct > 0.75) macroBalance -= 3;
    if (calories > 1200 || calories < 180) macroBalance -= 3;
    if (Math.abs(macroCalories - calories) / Math.max(1, calories) > 0.25) macroBalance -= 4;
    macroBalance = clamp(macroBalance, 0, 15);

    var wholeFoodHits = countMatches(signals.ingredients, WHOLE_FOOD_KEYWORDS);
    var processedHits = countMatches(signals.ingredients, PROCESSED_KEYWORDS);
    var ingredientQuality = clamp(8 + wholeFoodHits * 2 - processedHits * 2, 0, 12);

    var athleteUtility = 10;
    if (ctx.athlete && carbs < 30) athleteUtility -= 3;
    if (ctx.goal.indexOf('fat') !== -1 && ingredientCount < 3) athleteUtility -= 2;
    if (countMatches(signals.ingredients, SATIETY_KEYWORDS) < 2) athleteUtility -= 2;
    athleteUtility = clamp(athleteUtility, 0, 12);

    var prepSimplicity = 10;
    if (ingredientCount > 14) prepSimplicity -= 4;
    if (ingredientCount < 4) prepSimplicity -= 2;
    if (prepTime > 45) prepSimplicity -= 4;
    if (ctx.busy && prepTime > 30) prepSimplicity -= 2;
    if (ctx.travel && ingredientCount > 8) prepSimplicity -= 3;
    prepSimplicity = clamp(prepSimplicity, 0, 10);

    var flavorHits = countMatches(signals.ingredients, FLAVOR_KEYWORDS);
    var tasteProxy = clamp(5 + flavorHits * 1.4 + (signals.textures.length ? 1 : 0), 0, 10);

    var budgetEfficiency = 8;
    if (protein >= 30) budgetEfficiency += 2;
    if (countMatches(signals.ingredients, ['salmon', 'steak', 'asparagus']) > 1 && ctx.budgetTier === 'budget') budgetEfficiency -= 3;
    if (ingredientCount > 12) budgetEfficiency -= 2;
    budgetEfficiency = clamp(budgetEfficiency, 0, 10);

    var repeatability = 6;
    if (containsAny(signals.blob, ['loaded', 'deep fried', 'triple', 'extreme'])) repeatability -= 3;
    if (ingredientCount >= 5 && ingredientCount <= 11) repeatability += 2;
    repeatability = clamp(repeatability, 0, 8);

    var total = Math.round(clamp(
      proteinDensity + macroBalance + ingredientQuality + athleteUtility + prepSimplicity + tasteProxy + budgetEfficiency + repeatability,
      1,
      100
    ));

    var rejectionReasons = [];
    if (protein < 20 && !isSnack) rejectionReasons.push('protein_below_threshold');
    if (fatPct > 0.62) rejectionReasons.push('excessive_fat_ratio');
    if (calories > 1400 || calories < 150) rejectionReasons.push('unrealistic_calories');
    if (processedHits >= 3) rejectionReasons.push('ultra_processed_ingredients');
    if (total < 45) rejectionReasons.push('low_quality_score');

    return {
      recipeQualityScore: total,
      categoryScores: {
        proteinDensity: Math.round(proteinDensity),
        macroBalance: Math.round(macroBalance),
        ingredientQuality: Math.round(ingredientQuality),
        athleteUtility: Math.round(athleteUtility),
        prepSimplicity: Math.round(prepSimplicity),
        tasteProxy: Math.round(tasteProxy),
        budgetEfficiency: Math.round(budgetEfficiency),
        repeatability: Math.round(repeatability)
      },
      rejected: rejectionReasons.length > 0,
      rejectionReasons: rejectionReasons,
      signals: signals
    };
  }

  function applyVarietyPenalty(scored, varietyState) {
    varietyState = varietyState || {};
    var proteins = varietyState.proteins || {};
    var cuisines = varietyState.cuisines || {};
    var ingredients = varietyState.ingredients || {};
    var textures = varietyState.textures || {};
    var penalty = 0;

    scored.signals.proteins.forEach(function (p) { if (proteins[p]) penalty += 3; });
    scored.signals.cuisines.forEach(function (c) { if (cuisines[c]) penalty += 2; });
    scored.signals.keyIngredients.forEach(function (i) { if (ingredients[i]) penalty += 1; });
    scored.signals.textures.forEach(function (t) { if (textures[t]) penalty += 1; });

    scored.varietyPenalty = penalty;
    scored.recipeQualityScore = clamp(scored.recipeQualityScore - penalty, 1, 100);
    return scored;
  }

  function commitToVariety(scored, varietyState) {
    varietyState = varietyState || {};
    varietyState.proteins = varietyState.proteins || {};
    varietyState.cuisines = varietyState.cuisines || {};
    varietyState.ingredients = varietyState.ingredients || {};
    varietyState.textures = varietyState.textures || {};
    scored.signals.proteins.forEach(function (p) { varietyState.proteins[p] = (varietyState.proteins[p] || 0) + 1; });
    scored.signals.cuisines.forEach(function (c) { varietyState.cuisines[c] = (varietyState.cuisines[c] || 0) + 1; });
    scored.signals.keyIngredients.forEach(function (i) { varietyState.ingredients[i] = (varietyState.ingredients[i] || 0) + 1; });
    scored.signals.textures.forEach(function (t) { varietyState.textures[t] = (varietyState.textures[t] || 0) + 1; });
    return varietyState;
  }

  function curateRecipes(recipes, options) {
    options = options || {};
    var desiredCount = Math.max(1, Number(options.desiredCount) || 1);
    var varietyState = options.varietyState || {};
    var scored = [];
    var rejected = [];
    var i;

    for (i = 0; i < recipes.length; i++) {
      var recipe = recipes[i];
      var s = scoreRecipe(recipe, options);
      s.recipe = recipe;
      if (s.rejected) {
        rejected.push(s);
      } else {
        applyVarietyPenalty(s, varietyState);
        scored.push(s);
      }
    }

    scored.sort(function (a, b) { return b.recipeQualityScore - a.recipeQualityScore; });

    var curated = [];
    for (i = 0; i < scored.length && curated.length < desiredCount; i++) {
      var pick = scored[i];
      commitToVariety(pick, varietyState);
      curated.push(pick);
    }

    return {
      curated: curated,
      rejected: rejected,
      varietyState: varietyState
    };
  }

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Curation = {
    scoreRecipe: scoreRecipe,
    curateRecipes: curateRecipes
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
