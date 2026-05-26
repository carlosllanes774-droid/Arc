/**
 * Arc API Orchestrator — routes information requests; runs adaptive meal pipeline.
 *
 * Flow:
 *   Arc Engine → Spoonacular → Edamam → USDA → Validation → OpenAI → Kroger → Portion Scaling
 *
 * Arc Engine owns targets, optimization, validation decisions, and execution.
 */
(function (global) {
  'use strict';

  function providers() {
    var p = global.ArcApi && global.ArcApi.Providers;
    if (!p) throw new Error('[Arc API] Load provider modules before apiOrchestrator.js');
    return p;
  }

  function services() {
    return (global.ArcApi && global.ArcApi.Services) || {};
  }

  function validation() {
    return (global.ArcApi && global.ArcApi.Validation) || null;
  }

  /**
   * @type {Object<string, string>}
   */
  var RESPONSIBILITY_OWNER = {
    recipe_retrieval: 'spoonacular',
    recipe_metadata: 'spoonacular',
    meal_discovery: 'spoonacular',

    ingredient_parsing: 'edamam',
    food_understanding: 'edamam',
    recipe_nutrition_analysis: 'edamam',
    diet_labels: 'edamam',
    food_intelligence: 'edamam',

    nutrition_verification: 'usda',
    macro_validation: 'usda',
    source_of_truth: 'usda',

    adaptation: 'openai',
    optimization: 'openai',
    reasoning: 'openai',

    grocery_pricing: 'kroger',
    availability: 'kroger',
    substitutions: 'kroger'
  };

  /**
   * @type {Object<string, { provider: string, method: string, responsibility: string }>}
   */
  var OPERATIONS = {
    retrieveRecipe: { provider: 'spoonacular', method: 'retrieveRecipe', responsibility: 'recipe_retrieval' },
    getRecipeMetadata: { provider: 'spoonacular', method: 'getRecipeMetadata', responsibility: 'recipe_metadata' },
    discoverMeals: { provider: 'spoonacular', method: 'discoverMeals', responsibility: 'meal_discovery' },
    searchRecipes: { provider: 'spoonacular', method: 'searchRecipes', responsibility: 'meal_discovery' },

    parseIngredients: { provider: 'edamam', method: 'parseIngredients', responsibility: 'ingredient_parsing' },
    parseFoodInput: { provider: 'edamam', method: 'parseFoodInput', responsibility: 'ingredient_parsing' },
    understandFood: { provider: 'edamam', method: 'understandFood', responsibility: 'food_understanding' },
    analyzeRecipeNutrition: { provider: 'edamam', method: 'analyzeRecipeNutrition', responsibility: 'recipe_nutrition_analysis' },
    getDietLabels: { provider: 'edamam', method: 'getDietLabels', responsibility: 'diet_labels' },
    getFoodIntelligence: { provider: 'edamam', method: 'getFoodIntelligence', responsibility: 'food_intelligence' },

    verifyNutrition: { provider: 'usda', method: 'verifyNutrition', responsibility: 'nutrition_verification' },
    validateMacros: { provider: 'usda', method: 'validateMacros', responsibility: 'macro_validation' },
    resolveSourceOfTruth: { provider: 'usda', method: 'resolveSourceOfTruth', responsibility: 'source_of_truth' },

    adapt: { provider: 'openai', method: 'adapt', responsibility: 'adaptation' },
    optimize: { provider: 'openai', method: 'optimize', responsibility: 'optimization' },
    reason: { provider: 'openai', method: 'reason', responsibility: 'reasoning' },

    getGroceryPricing: { provider: 'kroger', method: 'getPricing', responsibility: 'grocery_pricing' },
    checkAvailability: { provider: 'kroger', method: 'checkAvailability', responsibility: 'availability' },
    findSubstitutions: { provider: 'kroger', method: 'findSubstitutions', responsibility: 'substitutions' }
  };

  var PROVIDER_CATALOG = {
    spoonacular: {
      label: 'Spoonacular',
      role: 'Recipe catalog & meal discovery',
      responsibilities: ['recipe_retrieval', 'recipe_metadata', 'meal_discovery'],
      arcDoesNot: ['macro targets', 'meal slot optimization', 'adherence scoring']
    },
    edamam: {
      label: 'Edamam',
      role: 'Food & ingredient intelligence',
      responsibilities: [
        'ingredient_parsing',
        'food_understanding',
        'recipe_nutrition_analysis',
        'diet_labels',
        'food_intelligence'
      ],
      arcDoesNot: ['calorie targets', 'goal strategy', 'portion scaling decisions']
    },
    usda: {
      label: 'USDA FoodData Central',
      role: 'Nutrition verification & truth layer',
      responsibilities: ['nutrition_verification', 'macro_validation', 'source_of_truth'],
      arcDoesNot: ['recipe discovery', 'grocery pricing']
    },
    openai: {
      label: 'OpenAI',
      role: 'Adaptation, optimization language, reasoning',
      responsibilities: ['adaptation', 'optimization', 'reasoning'],
      arcDoesNot: ['TDEE calculation', 'deterministic meal presets', 'budget tiers', 'meal creation']
    },
    kroger: {
      label: 'Kroger',
      role: 'Grocery market data',
      responsibilities: ['grocery_pricing', 'availability', 'substitutions'],
      arcDoesNot: ['nutrition targets', 'recipe nutrition analysis']
    }
  };

  function trace() {
    return global.ArcApi && global.ArcApi.Trace;
  }

  function dispatch(operationName, input) {
    var op = OPERATIONS[operationName];
    if (!op) {
      return Promise.resolve({
        provider: null,
        responsibility: null,
        status: 'unknown_operation',
        data: null,
        error: 'Unknown operation: ' + operationName,
        arcOwned: false
      });
    }

    var owner = op.provider;
    if (RESPONSIBILITY_OWNER[op.responsibility] !== owner) {
      return Promise.reject(new Error('[Arc API] Responsibility routing mismatch: ' + op.responsibility));
    }

    var p = providers()[owner];
    if (!p || typeof p[op.method] !== 'function') {
      return Promise.resolve({
        provider: owner,
        responsibility: op.responsibility,
        status: 'provider_missing',
        data: null,
        error: 'Provider adapter not loaded: ' + owner,
        arcOwned: false
      });
    }

    return p[op.method](input);
  }

  function analyzeAndValidateRecipe(input) {
    input = input || {};
    return dispatch('analyzeRecipeNutrition', input).then(function (nutrition) {
      var macros = nutrition.data && nutrition.data.normalized;
      if (!macros || nutrition.status !== 'ok') {
        return { nutrition: nutrition, validation: null, arcNote: 'Nutrition analysis incomplete — skip USDA validation' };
      }

      var V = validation();
      var preCheck = V ? V.detectImpossibleNutrition(macros) : { safe: true };

      return dispatch('validateMacros', {
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat
      }).then(function (usdaValidation) {
        return {
          nutrition: nutrition,
          validation: usdaValidation,
          preCheck: preCheck,
          arcNote: 'Arc Engine applies targets, scaling, and meal strategy — not external APIs'
        };
      });
    });
  }

  /**
   * Full adaptive meal pipeline — Arc Engine first, APIs provide information.
   * @param {object} profile Arc Engine profile + optional scenario, zipCode, foodLog
   * @returns {Promise<object>}
   */
  function runAdaptiveMealPipeline(profile) {
    profile = profile || {};
    var T = trace();
    if (T) T.logOrchestrator('meal pipeline started');

    var arcResult = null;

    if (global.ArcEngine && typeof global.ArcEngine.run === 'function') {
      arcResult = global.ArcEngine.run(profile);
    } else if (global.ArcEngine && typeof global.ArcEngine.computeTargets === 'function') {
      arcResult = { goal: global.ArcEngine.computeTargets(profile), targets: global.ArcEngine.computeTargets(profile) };
    }

    var targets = arcResult && (arcResult.targets || arcResult.goal) || {};
    var scenario = profile.scenario || inferScenario(profile);
    var S = services();
    var V = validation();

    var searchFilters = {
      query: profile.mealQuery || 'high protein dinner',
      maxCalories: profile.maxCalories || (targets.targetCalories ? Math.round(targets.targetCalories / (profile.mealsPerDay || 3)) : null),
      diet: profile.diet,
      number: profile.recipeCount || 3
    };

    return (S.spoonacular ? S.spoonacular.searchRecipes(searchFilters) : dispatch('discoverMeals', searchFilters))
      .then(function (recipeSearch) {
        var recipes = (recipeSearch.data && recipeSearch.data.recipes) || [];
        var recipe = recipes[0] || profile.recipe || null;

        if (!recipe) {
          if (T) T.logMessage('Spoonacular no recipes found');
          return buildPipelineResult({
            arcResult: arcResult,
            scenario: scenario,
            recipeSearch: recipeSearch,
            error: 'no_recipe_found',
            degraded: true
          });
        }

        var ingrLines = (recipe.ingredients || []).map(function (i) {
          return i.original || i.name || String(i);
        }).filter(Boolean);

        var edamamPromise = profile.foodLogText
          ? (S.edamam ? S.edamam.parseFoodInput({ text: profile.foodLogText }) : dispatch('parseFoodInput', { text: profile.foodLogText }))
          : (S.edamam
            ? S.edamam.analyzeRecipeNutrition({ title: recipe.title, ingr: ingrLines })
            : dispatch('analyzeRecipeNutrition', { title: recipe.title, ingr: ingrLines }));

        return edamamPromise.then(function (nutrition) {
          var macros = nutrition.data && (nutrition.data.normalized || nutrition.data.totalNutrients);
          if (nutrition.data && nutrition.data.normalized) macros = nutrition.data.normalized;

          if (nutrition.status !== 'ok' && T) {
            T.logMessage('Edamam nutrition analysis failed');
          }

          var usdaPromise = macros
            ? (S.usda ? S.usda.validateMacros(macros) : dispatch('validateMacros', macros))
            : Promise.resolve(null);

          return usdaPromise.then(function (usdaValidation) {
            var validationReport = V && macros
              ? V.detectImpossibleNutrition(Object.assign({}, macros, {
                context: 'meal',
                weightLb: profile.weight
              }))
              : null;

            if (validationReport && !validationReport.safe) {
              if (T) T.logMessage('USDA validation failed');
              return buildPipelineResult({
                arcResult: arcResult,
                scenario: scenario,
                recipe: recipe,
                nutrition: nutrition,
                usdaValidation: usdaValidation,
                validationReport: validationReport,
                blocked: true,
                error: 'nutrition_failed_validation'
              });
            }

            var openaiPromise = pickOpenAiAdaptation(S, scenario, arcResult, profile);
            return openaiPromise.then(function (adaptation) {
              var groceryIngredients = (recipe.ingredients || []).map(function (ing, idx) {
                return { key: 'ing_' + idx, name: ing.name || ing.original || 'ingredient' };
              });

              var krogerPromise = S.kroger
                ? S.kroger.estimateGroceryCost({
                  zipCode: profile.zipCode,
                  ingredients: groceryIngredients,
                  budgetConstraints: arcResult && arcResult.budget
                })
                : dispatch('getGroceryPricing', { zipCode: profile.zipCode, items: groceryIngredients });

              return krogerPromise.then(function (pricing) {
                if (T && pricing && pricing.status === 'not_configured') {
                  T.logMessage('Kroger unavailable');
                }

                var recipeWithNutrition = Object.assign({}, recipe, {
                  nutrition: macros || {},
                  calories: macros && macros.calories,
                  protein: macros && macros.protein,
                  carbs: macros && macros.carbs,
                  fat: macros && macros.fat
                });

                var scaledRecipe = null;
                if (global.ArcEngine && global.ArcEngine.PortionScaler && macros) {
                  var slot = arcResult && arcResult.mealStrategy && arcResult.mealStrategy.slots && arcResult.mealStrategy.slots[0];
                  var slotTarget = profile.recipeTarget || slot || targets;
                  scaledRecipe = global.ArcEngine.PortionScaler.scaleRecipe(recipeWithNutrition, {
                    calories: slotTarget.calories || slotTarget.targetCalories,
                    protein: slotTarget.protein || slotTarget.proteinTarget,
                    carbs: slotTarget.carbs || slotTarget.carbTarget,
                    fat: slotTarget.fat || slotTarget.fatTarget
                  });
                }

                var finalResult = buildPipelineResult({
                  arcResult: arcResult,
                  scenario: scenario,
                  recipeSearch: recipeSearch,
                  recipe: recipe,
                  nutrition: nutrition,
                  usdaValidation: usdaValidation,
                  validationReport: validationReport,
                  adaptation: adaptation,
                  pricing: pricing,
                  scaledRecipe: scaledRecipe
                });
                if (T) T.logMessage('Final meal generation complete');
                return finalResult;
              });
            });
          });
        });
      }).catch(function (err) {
        if (T) T.logOrchestrator('meal pipeline failed');
        throw err;
      });
  }

  function inferScenario(profile) {
    if (profile.foodLogText) return 'off_plan';
    if (profile.scenario) return profile.scenario;
    if (profile.athlete && profile.athlete.phase === 'offseason') return 'athlete_offseason';
    if (profile.sickWeek) return 'sick_week';
    if (profile.travelWeek) return 'travel';
    if (profile.budgetTier === 'low' || profile.budgetTier === 'Budget') return 'budget';
    return 'performance';
  }

  function pickOpenAiAdaptation(S, scenario, arcResult, profile) {
    if (!S.openai) return dispatch('optimize', { prompt: 'scenario:' + scenario, arcContext: arcResult });

    var ctx = { arc: arcResult, profile: { goal: profile.goal, budgetTier: profile.budgetTier } };
    switch (scenario) {
      case 'athlete_offseason': return S.openai.adaptForAthlete({ arcContext: ctx, userNote: profile.userNote });
      case 'sick_week': return S.openai.adaptForIllness({ arcContext: ctx });
      case 'travel': return S.openai.adaptForTravel({ arcContext: ctx });
      case 'budget': return S.openai.adaptForBudget({ arcContext: ctx });
      case 'off_plan': return S.openai.adaptForOffPlanEating({ arcContext: ctx, text: profile.foodLogText });
      default: return S.openai.optimizeNutritionStrategy({ arcContext: ctx });
    }
  }

  function buildPipelineResult(parts) {
    parts = parts || {};
    return {
      version: '2.0.0',
      generatedAt: new Date().toISOString(),
      arcOwned: true,
      blocked: !!parts.blocked,
      degraded: !!parts.degraded,
      error: parts.error || null,
      scenario: parts.scenario,
      arc: parts.arcResult,
      recipeSearch: parts.recipeSearch || null,
      recipe: parts.recipe || null,
      nutrition: parts.nutrition || null,
      usdaValidation: parts.usdaValidation || null,
      validation: parts.validationReport || null,
      adaptation: parts.adaptation || null,
      pricing: parts.pricing || null,
      scaledRecipe: parts.scaledRecipe || null,
      note: 'Arc Engine owns intelligence; external APIs provide information'
    };
  }

  function getProviderRegistry() {
    return Object.keys(PROVIDER_CATALOG).map(function (id) {
      var entry = PROVIDER_CATALOG[id];
      return {
        id: id,
        label: entry.label,
        role: entry.role,
        responsibilities: entry.responsibilities.slice(),
        status: providers()[id] ? 'adapter_loaded' : 'not_loaded',
        arcBoundary: entry.arcDoesNot
      };
    });
  }

  function getIntegrationStatus() {
    var out = {};
    Object.keys(PROVIDER_CATALOG).forEach(function (id) {
      out[id] = {
        status: providers()[id] ? 'adapter_ready' : 'not_loaded',
        service: services()[id] ? 'service_ready' : 'service_missing',
        responsibilities: PROVIDER_CATALOG[id].responsibilities.slice()
      };
    });
    return out;
  }

  var api = {
    RESPONSIBILITY_OWNER: RESPONSIBILITY_OWNER,
    OPERATIONS: OPERATIONS,
    PROVIDER_CATALOG: PROVIDER_CATALOG,
    dispatch: dispatch,
    analyzeAndValidateRecipe: analyzeAndValidateRecipe,
    runAdaptiveMealPipeline: runAdaptiveMealPipeline,
    getProviderRegistry: getProviderRegistry,
    getIntegrationStatus: getIntegrationStatus,

    retrieveRecipe: function (input) { return dispatch('retrieveRecipe', input); },
    getRecipeMetadata: function (input) { return dispatch('getRecipeMetadata', input); },
    discoverMeals: function (input) { return dispatch('discoverMeals', input); },
    searchRecipes: function (input) { return dispatch('searchRecipes', input); },

    parseIngredients: function (input) { return dispatch('parseIngredients', input); },
    parseFoodInput: function (input) { return dispatch('parseFoodInput', input); },
    understandFood: function (input) { return dispatch('understandFood', input); },
    analyzeRecipeNutrition: function (input) { return dispatch('analyzeRecipeNutrition', input); },
    getDietLabels: function (input) { return dispatch('getDietLabels', input); },
    getFoodIntelligence: function (input) { return dispatch('getFoodIntelligence', input); },

    verifyNutrition: function (input) { return dispatch('verifyNutrition', input); },
    validateMacros: function (input) { return dispatch('validateMacros', input); },
    resolveSourceOfTruth: function (input) { return dispatch('resolveSourceOfTruth', input); },

    adapt: function (input) { return dispatch('adapt', input); },
    optimize: function (input) { return dispatch('optimize', input); },
    reason: function (input) { return dispatch('reason', input); },

    getGroceryPricing: function (input) { return dispatch('getGroceryPricing', input); },
    checkAvailability: function (input) { return dispatch('checkAvailability', input); },
    findSubstitutions: function (input) { return dispatch('findSubstitutions', input); }
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Orchestrator = api;
  global.ArcApi.dispatch = dispatch;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
