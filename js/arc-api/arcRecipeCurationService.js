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
    var V2 = global.ArcNutritionV2;

    if (V2 && V2.shouldHardRejectRecipe && V2.scoreRecipeQuality) {
      var hard = V2.shouldHardRejectRecipe(recipe, {
        cat: recipe.cat,
        budgetTier: ctx.budgetTier,
        budget: options.profile && options.profile.budget
      });
      var quality = V2.scoreRecipeQuality(recipe, {
        goal: ctx.goal,
        budgetTier: ctx.budgetTier,
        budget: options.profile && options.profile.budget,
        busy: ctx.busy,
        preferenceMatch: options.preferenceMatch,
        ingredientOverlap: options.ingredientOverlap
      });

      return {
        recipeQualityScore: quality.total,
        categoryScores: quality.breakdown,
        rejected: hard.rejected,
        rejectionReasons: hard.reasons,
        signals: signals
      };
    }

    var nutrition = recipe && recipe.nutrition ? recipe.nutrition : recipe || {};
    var calories = toNumber(nutrition.calories || recipe.calories || recipe.cal);
    var protein = toNumber(nutrition.protein || recipe.protein || recipe.p);
    var processedHits = countMatches(signals.ingredients, PROCESSED_KEYWORDS);
    var isSnack = containsAny(signals.blob, SNACK_KEYWORDS);
    var rejectionReasons = [];
    if (calories > 0 && calories < 250) rejectionReasons.push('calories_below_minimum');
    if (calories > 1800) rejectionReasons.push('calories_above_maximum');
    if (protein > 0 && protein < 15 && !isSnack) rejectionReasons.push('protein_below_main_meal_minimum');
    if (processedHits >= 4) rejectionReasons.push('poor_ingredient_quality');

    return {
      recipeQualityScore: 50,
      categoryScores: {},
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
