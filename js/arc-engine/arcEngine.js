/**
 * Arc Engine — central orchestrator for Arc's nutrition intelligence layer.
 *
 * Pipeline:
 *   Goal Engine → Nutrition context → Athlete Engine → Meal Optimizer
 *   → Budget Engine → Portion Scaler (when recipe present) → Arc Nutrition Strategy
 *
 * External data via js/arc-api (ArcApi.Orchestrator) — not invoked here.
 * Spoonacular: recipes · Edamam: food/nutrition · USDA: verify · OpenAI: reason · Kroger: grocery
 */
(function (global) {
  'use strict';

  function engine(name) {
    var e = global.ArcEngine && global.ArcEngine[name];
    if (!e) throw new Error('[Arc Engine] Missing module: ' + name);
    return e;
  }

  /** Delegates to ArcApi orchestrator when loaded; static catalog otherwise. */
  function integrationSnapshot() {
    if (global.ArcApi && global.ArcApi.Orchestrator && global.ArcApi.Orchestrator.getIntegrationStatus) {
      return global.ArcApi.Orchestrator.getIntegrationStatus();
    }
    return {
      spoonacular: { status: 'adapter_not_loaded', responsibilities: ['recipe_retrieval', 'recipe_metadata', 'meal_discovery'] },
      edamam: { status: 'adapter_not_loaded', responsibilities: ['ingredient_parsing', 'food_understanding', 'recipe_nutrition_analysis', 'diet_labels', 'food_intelligence'] },
      usda: { status: 'adapter_not_loaded', responsibilities: ['nutrition_verification', 'macro_validation', 'source_of_truth'] },
      openai: { status: 'adapter_not_loaded', responsibilities: ['adaptation', 'optimization', 'reasoning'] },
      kroger: { status: 'adapter_not_loaded', responsibilities: ['grocery_pricing', 'availability', 'substitutions'] }
    };
  }

  /**
   * Run full Arc intelligence pipeline.
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
   *   muscleEmphasis?: boolean,
   *   athlete?: { phase?: string, dayType?: string, sport?: string },
   *   budgetTier?: string,
   *   mealsPerDay?: number,
   *   skill?: string,
   *   recipe?: object,
   *   recipeTarget?: object,
   *   adherenceLog?: Array<object>
   * }} profile
   * @returns {object}
   */
  function run(profile) {
    profile = profile || {};
    var Goal = engine('Goal');
    var Athlete = engine('Athlete');
    var MealOptimizer = engine('MealOptimizer');
    var Budget = engine('Budget');
    var PortionScaler = engine('PortionScaler');
    var Adherence = engine('Adherence');

    var goalTargets = Goal.computeGoalTargets(profile);
    var activeTargets = {
      targetCalories: goalTargets.targetCalories,
      proteinTarget: goalTargets.proteinTarget,
      fatTarget: goalTargets.fatTarget,
      carbTarget: goalTargets.carbTarget,
      goal: goalTargets.goal,
      strategy: goalTargets.strategy
    };

    var athleteResult = null;
    if (profile.athlete || profile.activityLevel === 'Athlete' || profile.activityLevel === 'athlete') {
      athleteResult = Athlete.applyAthleteModifiers(activeTargets, profile.athlete || {});
      if (athleteResult && athleteResult.adjustedTargets) {
        activeTargets = Object.assign({}, activeTargets, athleteResult.adjustedTargets);
      }
    }

    var mealStrategy = MealOptimizer.optimizeMeals(activeTargets, {
      goal: goalTargets.goal,
      budgetTier: profile.budgetTier,
      athleteModifiers: athleteResult ? { athletePhase: athleteResult.phase } : null,
      skill: profile.skill,
      mealsPerDay: profile.mealsPerDay,
      recipes: profile.recipes,
      groceryConstraints: profile.groceryConstraints
    });

    var budgetConstraints = Budget.getBudgetConstraints(profile.budgetTier || 'moderate', {
      householdSize: profile.householdSize,
      weeklyBudgetUsd: profile.weeklyBudgetUsd
    });

    var scaledRecipe = null;
    if (profile.recipe) {
      var slotTarget = profile.recipeTarget || (mealStrategy.slots && mealStrategy.slots[0]) || activeTargets;
      scaledRecipe = PortionScaler.scaleRecipe(profile.recipe, {
        calories: slotTarget.calories || slotTarget.targetCalories,
        protein: slotTarget.protein || slotTarget.proteinTarget,
        carbs: slotTarget.carbs || slotTarget.carbTarget,
        fat: slotTarget.fat || slotTarget.fatTarget
      });
    }

    var adherenceInsights = null;
    if (profile.adherenceLog && profile.adherenceLog.length) {
      adherenceInsights = Adherence.futureAdaptationSignals(profile.adherenceLog, {
        goal: goalTargets.goal,
        proteinTarget: activeTargets.proteinTarget,
        adherenceOpts: { expectedMealsPerDay: profile.mealsPerDay || 3 }
      });
    }

    return {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      goal: goalTargets,
      targets: activeTargets,
      athlete: athleteResult,
      mealStrategy: mealStrategy,
      budget: budgetConstraints,
      scaledRecipe: scaledRecipe,
      adherence: adherenceInsights,
      integrations: integrationSnapshot()
    };
  }

  /**
   * Lightweight entry: goal targets only (no meal/budget pipeline).
   * @param {object} profile
   * @returns {object}
   */
  function computeTargets(profile) {
    return engine('Goal').computeGoalTargets(profile);
  }

  /**
   * Canonical nutrition target entry — sole source of calorie/macro truth.
   * Accepts Arc onboarding profile (UP) or engine-native fields.
   * @param {object} profile
   * @returns {object}
   */
  function generateNutritionTargets(profile) {
    profile = profile || {};
    if (global.ArcRuntime && typeof global.ArcRuntime.profileToEngineInput === 'function') {
      profile = global.ArcRuntime.profileToEngineInput(profile);
    }
    return computeTargets(profile);
  }

  var api = {
    run: run,
    computeTargets: computeTargets,
    generateNutritionTargets: generateNutritionTargets,
    engine: engine
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.run = run;
  global.ArcEngine.computeTargets = computeTargets;
  global.ArcEngine.generateNutritionTargets = generateNutritionTargets;
  Object.assign(global.ArcEngine, api);
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
