/**
 * Arc Engine — Phase 1 test cases (Node built-in test runner).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(__dirname, '..', 'js', 'arc-engine');

const LOAD_ORDER = [
  'arcNutritionEngine.js',
  'arcGoalEngine.js',
  'arcAthleteEngine.js',
  'arcMealOptimizer.js',
  'arcBudgetEngine.js',
  'arcPortionScaler.js',
  'arcAdherenceEngine.js',
  'arcEngine.js'
];

/**
 * Load Arc engine scripts into a sandbox (IIFE → global.ArcEngine).
 * @returns {object}
 */
function loadArcEngine() {
  const sandbox = { ArcEngine: {}, console };
  const context = vm.createContext(sandbox);
  for (const file of LOAD_ORDER) {
    const src = readFileSync(path.join(ENGINE_DIR, file), 'utf8');
    vm.runInContext(src, context, { filename: file });
  }
  return sandbox.ArcEngine;
}

describe('Arc Goal Engine', () => {
  const Arc = loadArcEngine();

  test('male 200 lb — gain 1 lb/week — moderately active', () => {
    const result = Arc.Goal.computeGoalTargets({
      goal: 'Gain weight',
      goalPace: 1,
      weight: 200,
      height: 70,
      age: 28,
      gender: 'male',
      activityLevel: 'Moderate'
    });

    assert.ok(result.targetCalories >= 3000 && result.targetCalories <= 4000,
      'calorie target should be a reasonable surplus (~' + result.targetCalories + ')');
    assert.ok(result.proteinTarget >= 160 && result.proteinTarget <= 220,
      'protein should be ~0.8–1.0 g/lb (' + result.proteinTarget + 'g)');
    assert.equal(result.strategy, 'caloric_surplus');
    assert.equal(result.paceLbWeek, 1);
    assert.ok(result.maintenanceCalories > 2500);
    assert.ok(result.calorieAdjustment >= 450, '~500 kcal/day surplus for 1 lb/week');
  });

  test('body recomp — slight deficit, elevated protein', () => {
    const result = Arc.Goal.computeGoalTargets({
      goal: 'Body recomp',
      goalPace: 0.5,
      weight: 175,
      height: 68,
      age: 32,
      gender: 'female',
      activityLevel: 'Moderate'
    });

    assert.equal(result.strategy, 'recomp_deficit');
    assert.ok(result.targetCalories < result.maintenanceCalories);
    assert.ok(result.proteinTarget >= 175, 'recomp protein ≥ ~1.0 g/lb');
    assert.ok(result.proteinTarget <= 220);
  });

  test('lose 0.75 lb/week', () => {
    const result = Arc.Goal.computeGoalTargets({
      goal: 'Lose weight',
      goalPace: 0.75,
      weight: 190,
      height: 69,
      age: 40,
      gender: 'male',
      activityLevel: 'Light'
    });

    assert.equal(result.strategy, 'caloric_deficit');
    assert.ok(result.targetCalories < result.maintenanceCalories);
    const expectedDelta = Arc.Goal.paceToDailyDelta(0.75);
    assert.equal(result.calorieAdjustment, -expectedDelta);
    assert.ok(result.proteinTarget >= 150);
  });

  test('improve energy — maintenance-style', () => {
    const result = Arc.Goal.computeGoalTargets({
      goal: 'Improve energy',
      weight: 160,
      height: 65,
      age: 29,
      gender: 'female',
      activityLevel: 'Sedentary'
    });

    assert.equal(result.strategy, 'energy_consistency');
    assert.equal(result.calorieAdjustment, 0);
    assert.ok(Math.abs(result.targetCalories - result.maintenanceCalories) <= 50);
  });
});

describe('Arc Athlete Engine', () => {
  const Arc = loadArcEngine();

  test('athlete offseason — modest carb/protein bump', () => {
    const base = Arc.Goal.computeGoalTargets({
      goal: 'Gain muscle',
      goalPace: 0.5,
      weight: 185,
      height: 72,
      age: 22,
      gender: 'male',
      activityLevel: 'Athlete'
    });

    const mod = Arc.Athlete.applyAthleteModifiers(base, { phase: 'offseason' });
    assert.equal(mod.phase, 'offseason');
    assert.ok(mod.adjustedTargets.targetCalories >= base.targetCalories);
    assert.ok(mod.adjustedTargets.carbTarget >= base.carbTarget);
  });

  test('performance day — carb allocation increase', () => {
    const base = {
      targetCalories: 3200,
      proteinTarget: 190,
      fatTarget: 85,
      carbTarget: 380
    };
    const mod = Arc.Athlete.applyAthleteModifiers(base, { phase: 'performance_day' });
    assert.ok(mod.adjustedTargets.carbTarget > base.carbTarget);
  });
});

describe('Arc Engine orchestrator', () => {
  const Arc = loadArcEngine();

  test('full pipeline returns integrated strategy object', () => {
    const strategy = Arc.run({
      goal: 'Gain weight',
      goalPace: 1,
      weight: 200,
      height: 70,
      age: 28,
      gender: 'male',
      activityLevel: 'Moderate',
      budgetTier: 'Moderate',
      recipe: {
        name: 'Chicken bowl',
        calories: 600,
        protein: 45,
        carbs: 55,
        fat: 18,
        ingredients: [
          { name: 'chicken', quantity: 6, unit: 'oz' },
          { name: 'rice', quantity: 1, unit: 'cup' }
        ]
      },
      recipeTarget: { calories: 850 }
    });

    assert.ok(strategy.goal);
    assert.ok(strategy.targets);
    assert.ok(strategy.mealStrategy.slots.length >= 3);
    assert.equal(strategy.budget.tier, 'moderate');
    assert.ok(strategy.scaledRecipe.scaleFactor > 1);
    assert.equal(strategy.scaledRecipe.scaled.calories, 850);
    assert.ok(strategy.integrations.openai);
    assert.ok(Array.isArray(strategy.integrations.edamam.responsibilities));
    assert.ok(strategy.integrations.edamam.responsibilities.includes('recipe_nutrition_analysis'));
  });
});

describe('Arc Portion Scaler', () => {
  const Arc = loadArcEngine();

  test('scales chicken bowl 600 → 850 kcal preserving ratios', () => {
    const out = Arc.PortionScaler.scaleRecipe(
      { name: 'Chicken bowl', calories: 600, protein: 45, carbs: 55, fat: 18,
        ingredients: [{ name: 'chicken', quantity: 6 }] },
      { calories: 850 }
    );
    assert.ok(out.scaleFactor > 1.35 && out.scaleFactor < 1.45);
    assert.equal(out.scaled.calories, 850);
    assert.ok(out.ingredients[0].quantity > 6);
  });
});

describe('Arc Adherence Engine', () => {
  const Arc = loadArcEngine();

  test('detects skip-heavy patterns', () => {
    const log = [
      { type: 'skipped_meal', slot: 'breakfast', date: '2026-05-01' },
      { type: 'skipped_meal', slot: 'breakfast', date: '2026-05-02' },
      { type: 'meal_completed', slot: 'lunch', date: '2026-05-01' },
      { type: 'skipped_meal', slot: 'breakfast', date: '2026-05-03' }
    ];
    const patterns = Arc.Adherence.detectPatterns(log);
    assert.ok(patterns.some((p) => p.kind === 'skip_heavy_slot' && p.slot === 'breakfast'));
  });
});
