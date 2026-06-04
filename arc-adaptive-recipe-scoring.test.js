/**
 * Behavior-aware recipe scoring tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCORING_JS = path.join(__dirname, '..', 'js', 'arc-adaptive-recipe-scoring.js');

function loadScoring() {
  const sandbox = { console, ArcAdaptiveRecipeScoring: null };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(SCORING_JS, 'utf8'), ctx, { filename: 'arc-adaptive-recipe-scoring.js' });
  return sandbox.ArcAdaptiveRecipeScoring;
}

function overlap(a, b) {
  var keys = {};
  (a.ing || []).forEach(function (n) { keys[String(n).toLowerCase()] = 1; });
  var inter = 0;
  var union = 0;
  (b.ing || []).forEach(function (n) {
    var k = String(n).toLowerCase();
    union++;
    if (keys[k]) inter++;
  });
  (a.ing || []).forEach(function () { union++; });
  return union ? inter / union : 0;
}

describe('scoreRecipeAdaptiveBehavior', () => {
  const Score = loadScoring();

  test('liked recipe and similar meals score higher', () => {
    var recipes = [
      { id: 1, name: 'Loved Pasta', cat: 'Dinner', ing: ['pasta', 'tomato', 'basil'], time: '25 min', cal: 500, p: 30 },
      { id: 2, name: 'Similar Noodles', cat: 'Dinner', ing: ['pasta', 'tomato', 'garlic'], time: '28 min', cal: 480, p: 28 },
      { id: 3, name: 'Unrelated Steak', cat: 'Dinner', ing: ['steak', 'potato'], time: '35 min', cal: 600, p: 40 }
    ];
    var ctx = Score.buildAdaptiveScoringContext({
      mealFeedback: { 1: 1 },
      arcBehavior: { events: [], scores: {} },
      arcAdaptive: { favoriteMealNames: [] }
    }, { recipes: recipes, overlapFn: overlap });

    var similar = Score.scoreRecipeAdaptiveBehavior(recipes[1], ctx, { slotCat: 'Dinner' });
    var unrelated = Score.scoreRecipeAdaptiveBehavior(recipes[2], ctx, { slotCat: 'Dinner' });
    assert.ok(similar.delta > unrelated.delta);
    assert.ok(similar.breakdown.some(function (b) { return b.signal === 'liked_similarity'; }));
  });

  test('frequent swap pattern penalizes similar meals', () => {
    var recipes = [
      { id: 10, name: 'Heavy Bowl', cat: 'Lunch', ing: ['rice', 'chicken', 'broccoli'], time: '40 min', cal: 650, p: 35 },
      { id: 11, name: 'Rice Chicken Skillet', cat: 'Lunch', ing: ['rice', 'chicken', 'pepper'], time: '38 min', cal: 620, p: 33 },
      { id: 12, name: 'Salad', cat: 'Lunch', ing: ['greens', 'cucumber'], time: '12 min', cal: 320, p: 12 }
    ];
    var ctx = Score.buildAdaptiveScoringContext({
      arcBehavior: {
        events: [{ type: 'meal_replaced', payload: { plannedRid: 10, actualRid: 12 } }],
        scores: { frequentReplace: 0.6 }
      },
      arcAdaptive: {}
    }, { recipes: recipes, overlapFn: overlap });

    var penalized = Score.scoreRecipeAdaptiveBehavior(recipes[1], ctx, { slotCat: 'Lunch' });
    var neutral = Score.scoreRecipeAdaptiveBehavior(recipes[2], ctx, { slotCat: 'Lunch' });
    assert.ok(penalized.delta < neutral.delta);
    assert.ok(penalized.breakdown.some(function (b) { return b.signal === 'swap_away_similarity'; }));
  });

  test('breakfast skip favors lighter breakfasts', () => {
    var ctx = Score.buildAdaptiveScoringContext({
      arcAdaptive: { skipsBreakfastOften: true, foodLogSignals: { breakfastAdherence: 0.2 } },
      arcBehavior: { scores: { breakfastSkip: 0.55 }, events: [] }
    }, { recipes: [] });

    var light = Score.scoreRecipeAdaptiveBehavior(
      { id: 1, name: 'Yogurt Bowl', cat: 'Breakfast', ing: ['yogurt', 'berries'], time: '10 min', difficulty: 'Easy', cal: 280, p: 18 },
      ctx,
      { slotCat: 'Breakfast' }
    );
    var heavy = Score.scoreRecipeAdaptiveBehavior(
      { id: 2, name: 'Big Pancake Stack', cat: 'Breakfast', ing: ['flour', 'eggs', 'syrup', 'butter'], time: '35 min', cal: 620, p: 16 },
      ctx,
      { slotCat: 'Breakfast' }
    );
    assert.ok(light.delta > heavy.delta);
    assert.ok(light.breakdown.some(function (b) { return b.signal === 'breakfast_skip_lighter'; }));
  });

  test('quick and restaurant signals favor fast easy recipes', () => {
    var ctx = Score.buildAdaptiveScoringContext({
      arcBehavior: { scores: { quickPrepPref: 0.7 }, events: [] },
      arcAdaptive: {
        prefersQuickMeals: true,
        foodLogSignals: { quickMealPreference: 0.75, restaurantFrequency: 0.65, conveniencePreference: 0.6 }
      }
    }, { recipes: [] });

    var quick = Score.scoreRecipeAdaptiveBehavior(
      { id: 3, name: 'Quick Wrap', cat: 'Lunch', ing: ['tortilla', 'chicken'], time: '15 min', difficulty: 'Easy', cal: 400, p: 28 },
      ctx,
      { slotCat: 'Lunch' }
    );
    var slow = Score.scoreRecipeAdaptiveBehavior(
      { id: 4, name: 'Slow Roast', cat: 'Lunch', ing: ['beef', 'potato', 'carrot', 'onion', 'herb'], time: '55 min', cal: 700, p: 40 },
      ctx,
      { slotCat: 'Lunch' }
    );
    assert.ok(quick.delta > slow.delta);
    assert.ok(quick.breakdown.some(function (b) { return b.signal === 'quick_meal_preference'; }));
    assert.ok(quick.breakdown.some(function (b) { return b.signal === 'restaurant_convenience'; }));
  });
});
