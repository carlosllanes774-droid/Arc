/**
 * Arc Nutrition System V2 — hard reject vs quality ranking.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V2_PATH = path.join(__dirname, '..', 'js', 'arc-nutrition-v2.js');

function loadV2() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(V2_PATH, 'utf8'), sandbox, { filename: 'arc-nutrition-v2.js' });
  return sandbox.ArcNutritionV2;
}

describe('Arc Nutrition V2 hard rejection', () => {
  const V2 = loadV2();

  test('accepts 500 kcal lunch with adequate protein', () => {
    const result = V2.shouldHardRejectRecipe(
      { cal: 500, p: 35, cat: 'Lunch', ing: ['chicken', 'rice', 'broccoli'] },
      { budget: 'Moderate' }
    );
    assert.equal(result.rejected, false);
  });

  test('accepts 1200 kcal dinner — tier 3 variance allowed', () => {
    const result = V2.shouldHardRejectRecipe(
      { cal: 1200, p: 60, cat: 'Dinner', ing: ['salmon', 'quinoa', 'spinach'] },
      { budget: 'Flexible' }
    );
    assert.equal(result.rejected, false);
  });

  test('rejects calories below 250', () => {
    const result = V2.shouldHardRejectRecipe({ cal: 200, p: 20, cat: 'Lunch', ing: ['egg'] });
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes('calories_below_minimum'));
  });

  test('rejects calories above 1800', () => {
    const result = V2.shouldHardRejectRecipe({ cal: 1900, p: 80, cat: 'Dinner', ing: ['beef'] });
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes('calories_above_maximum'));
  });

  test('rejects main meal with protein below 15g', () => {
    const result = V2.shouldHardRejectRecipe({ cal: 400, p: 10, cat: 'Lunch', ing: ['rice'] });
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes('protein_below_main_meal_minimum'));
  });

  test('rejects budget violation on budget tier', () => {
    const result = V2.shouldHardRejectRecipe(
      { cal: 600, p: 40, cat: 'Dinner', price: 14, ing: ['steak'] },
      { budget: 'Budget' }
    );
    assert.equal(result.rejected, true);
    assert.ok(result.reasons.includes('budget_exceeded'));
  });
});

describe('Arc Nutrition V2 quality scoring', () => {
  const V2 = loadV2();

  test('ranks high-protein whole-food recipe above low-quality option', () => {
    var quality = V2.scoreRecipeQuality(
      { cal: 650, p: 45, cat: 'Dinner', ing: ['chicken breast', 'broccoli', 'quinoa', 'spinach'], time: '25 min' },
      { goal: 'Gain muscle' }
    );
    var weak = V2.scoreRecipeQuality(
      { cal: 640, p: 12, cat: 'Dinner', ing: ['instant ramen', 'processed syrup', 'refined flour', 'margarine'], time: '5 min' },
      { goal: 'Gain muscle' }
    );
    assert.ok(quality.total > weak.total);
  });

  test('mealCalorieSoftScore peaks near target without rejecting far meals', () => {
    assert.ok(V2.mealCalorieSoftScore(700, 700) > V2.mealCalorieSoftScore(500, 700));
    assert.ok(V2.mealCalorieSoftScore(500, 700) >= 0);
  });

  test('formatNutritionPromptBlock emphasizes daily targets over per-meal strictness', () => {
    var block = V2.formatNutritionPromptBlock(
      {
        n: 3,
        Breakfast: { cal: 500, p: 30 },
        Lunch: { cal: 700, p: 40 },
        Dinner: { cal: 900, p: 45 },
        perSlot: { cal: 700, p: 38 }
      },
      2100,
      { protein: 150, carbs: 200, fat: 70, weightKg: 80 },
      'Lose weight'
    );
    assert.ok(block.indexOf('OUTCOME-DRIVEN') !== -1);
    assert.ok(block.indexOf('NOT exact per-meal calorie matching') !== -1);
    assert.ok(block.indexOf('±10%') === -1);
    assert.ok(block.indexOf('250') !== -1);
    assert.ok(block.indexOf('1800') !== -1);
  });
});
