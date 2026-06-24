/**
 * Ingredient quantity audit + merge (OpenAI week library repair path).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPAIR_JS = path.join(__dirname, '..', 'js', 'arc-ingredient-qty-repair.js');

function loadArcIngredientQtyRepair() {
  const sandbox = { console, ArcIngredientQtyRepair: null };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(REPAIR_JS, 'utf8'), context, { filename: 'arc-ingredient-qty-repair.js' });
  return sandbox.ArcIngredientQtyRepair;
}

describe('auditRecipeIngredientQuantities', () => {
  const R = loadArcIngredientQtyRepair();

  test('complete when ing and ingQty counts match with values', () => {
    const audit = R.auditRecipeIngredientQuantities({
      ing: ['Eggs', 'Spinach'],
      ingQty: { Eggs: '3 large', Spinach: '1 cup' }
    });
    assert.equal(audit.complete, true);
    assert.equal(audit.needsQuantityRepair, false);
    assert.equal(audit.ingCount, 2);
    assert.equal(audit.ingQtyCount, 2);
  });

  test('needs repair when ingQty missing entries', () => {
    const audit = R.auditRecipeIngredientQuantities({
      ing: ['Chicken breast', 'Rice', 'Broccoli'],
      ingQty: {}
    });
    assert.equal(audit.complete, false);
    assert.equal(audit.needsQuantityRepair, true);
    assert.equal(audit.missing.length, 3);
  });

  test('needs repair when extra ingQty keys', () => {
    const audit = R.auditRecipeIngredientQuantities({
      ing: ['Rice'],
      ingQty: { Rice: '1 cup', Salt: 'pinch' }
    });
    assert.equal(audit.needsQuantityRepair, true);
    assert.equal(audit.ingQtyCount, 2);
    assert.equal(audit.ingCount, 1);
  });
});

describe('mergeRepairedIngredientQty', () => {
  const R = loadArcIngredientQtyRepair();

  test('merges patch for missing ingredients only', () => {
    const recipe = {
      name: 'Bowl',
      ing: ['Chicken breast', 'Rice'],
      ingQty: { 'Chicken breast': '6 oz' }
    };
    R.mergeRepairedIngredientQty(recipe, { rice: '1/2 cup' }, ['Rice']);
    assert.equal(recipe.ingQty['Chicken breast'], '6 oz');
    assert.equal(recipe.ingQty.Rice, '1/2 cup');
    const audit = R.auditRecipeIngredientQuantities(recipe);
    assert.equal(audit.complete, true);
  });
});

describe('isOpenAiWeekLibraryMeta', () => {
  const R = loadArcIngredientQtyRepair();

  test('spoonacular meta skips repair', () => {
    assert.equal(R.isOpenAiWeekLibraryMeta({ source: 'spoonacular' }), false);
  });

  test('week_recipe_library meta triggers repair path', () => {
    assert.equal(R.isOpenAiWeekLibraryMeta({ source: 'week_recipe_library' }), true);
  });
});
