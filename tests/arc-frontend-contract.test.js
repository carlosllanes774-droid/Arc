/**
 * Arc frontend recipe contract adapter tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_JS = path.join(__dirname, '..', 'js', 'arc-frontend-contract.js');
const FIXTURE_LOOSE = path.join(__dirname, 'fixtures', 'canonical-week-loose.json');

function loadArcFrontendContract() {
  const sandbox = { console, ArcFrontendContract: null };
  const context = vm.createContext(sandbox);
  vm.runInContext(readFileSync(CONTRACT_JS, 'utf8'), context, { filename: 'arc-frontend-contract.js' });
  return sandbox.ArcFrontendContract;
}

describe('Arc frontend contract adapter', () => {
  const AFC = loadArcFrontendContract();

  test('maps verbose pipeline fields to canonical render schema', () => {
    const loose = JSON.parse(readFileSync(FIXTURE_LOOSE, 'utf8')).recipes[0];
    const out = AFC.validateFrontendRecipeContract(loose);

    assert.equal(out.cal, 650);
    assert.equal(out.p, 45);
    assert.equal(out.c, 55);
    assert.equal(out.f, 18);
    assert.equal(out.cat, 'Lunch');
    assert.deepEqual(out.ing, ['Chicken', 'Rice', 'Broccoli']);
    assert.equal(out.steps.length, 3);
    assert.equal(out.steps[0].instruction, 'Cook chicken.');
    assert.equal(out.name, 'Test Chicken Bowl');
  });

  test('preserves spoonacularId and ingEdamam passthrough fields', () => {
    const out = AFC.adaptRecipeToFrontendContract({
      name: 'Sp Bowl',
      cal: 500,
      cat: 'Lunch',
      ing: ['rice'],
      spoonacularId: 716429,
      ingEdamam: ['1 cup rice'],
      ingKeys: ['sp_716429_0']
    });
    assert.equal(out.spoonacularId, 716429);
    assert.deepEqual(out.ingEdamam, ['1 cup rice']);
    assert.deepEqual(out.ingKeys, ['sp_716429_0']);
  });

  test('preserves canonical fields when already compact', () => {
    const canonical = {
      name: 'Bowl',
      cal: 500,
      p: 40,
      c: 50,
      f: 12,
      cat: 'Dinner',
      ing: ['Rice'],
      steps: [{ phase: 'Cook', instruction: 'Boil rice.' }],
      nutritionConfidence: 'high',
      nutritionVerified: true,
      nutritionSource: 'edamam+usda',
      servings: 2,
      tags: ['Quick']
    };
    const out = AFC.adaptRecipeToFrontendContract(canonical);
    assert.equal(out.cal, 500);
    assert.equal(out.p, 40);
    assert.equal(out.cat, 'Dinner');
    assert.equal(out.nutritionConfidence, 'high');
    assert.equal(out.nutritionVerified, true);
    assert.equal(out.nutritionSource, 'edamam+usda');
    assert.equal(out.servings, 2);
  });

  test('applies safe defaults for partial payloads', () => {
    const out = AFC.validateFrontendRecipeContract({ name: 'Minimal' });
    assert.equal(out.cal, 0);
    assert.equal(out.p, 0);
    assert.equal(out.cat, 'Lunch');
    assert.ok(Array.isArray(out.ing));
    assert.ok(out.steps.length >= 1);
  });

  test('normalizeRecipesForRender batch normalizes array', () => {
    const loose = JSON.parse(readFileSync(FIXTURE_LOOSE, 'utf8')).recipes;
    const list = AFC.normalizeRecipesForRender(loose, { log: false });
    assert.equal(list.length, 1);
    assert.equal(list[0].cal, 650);
  });
});
