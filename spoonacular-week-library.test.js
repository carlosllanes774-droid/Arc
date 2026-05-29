/**
 * Spoonacular week library mapper + validation (pre-applyLibrary gate).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_JS = path.join(__dirname, '..', 'js', 'spoonacular-week-library.js');

function loadLib(sandboxExtras) {
  const sandbox = Object.assign(
    { console, ArcRuntime: null, ArcSpoonacularWeekLibrary: null },
    sandboxExtras || {}
  );
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(LIB_JS, 'utf8'), ctx, { filename: 'spoonacular-week-library.js' });
  return sandbox.ArcSpoonacularWeekLibrary;
}

function validRecipe(overrides) {
  return Object.assign({
    id: 1,
    spoonacularId: 1001,
    name: 'Test Bowl',
    cat: 'Lunch',
    ing: ['chicken', 'rice'],
    ingQty: { chicken: '8 oz', rice: '1 cup' }
  }, overrides || {});
}

describe('validateSpoonacularWeekLibrary', () => {
  const Lib = loadLib();

  test('accepts a valid library of 4+ recipes', () => {
    const recipes = [
      validRecipe({ id: 1, spoonacularId: 1, cat: 'Breakfast' }),
      validRecipe({ id: 2, spoonacularId: 2, cat: 'Lunch' }),
      validRecipe({ id: 3, spoonacularId: 3, cat: 'Dinner' }),
      validRecipe({ id: 4, spoonacularId: 4, cat: 'Snack' })
    ];
    const result = Lib.validateSpoonacularWeekLibrary(recipes);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  test('rejects fewer than 4 recipes', () => {
    const result = Lib.validateSpoonacularWeekLibrary([
      validRecipe({ id: 1 }),
      validRecipe({ id: 2 }),
      validRecipe({ id: 3 })
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(function (e) { return e.indexOf('recipe_count_below_minimum') === 0; }));
  });

  test('rejects missing or invalid cat', () => {
    const result = Lib.validateSpoonacularWeekLibrary([
      validRecipe({ id: 1, cat: 'Breakfast' }),
      validRecipe({ id: 2, cat: 'Lunch' }),
      validRecipe({ id: 3, cat: 'Dinner' }),
      validRecipe({ id: 4, cat: '' })
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(function (e) { return e.indexOf('invalid_or_missing_cat') > 0; }));
  });

  test('rejects non-canonical cat values', () => {
    const result = Lib.validateSpoonacularWeekLibrary([
      validRecipe({ id: 1, cat: 'Breakfast' }),
      validRecipe({ id: 2, cat: 'Lunch' }),
      validRecipe({ id: 3, cat: 'Dinner' }),
      validRecipe({ id: 4, cat: 'Brunch' })
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(function (e) { return e.indexOf('invalid_or_missing_cat') > 0; }));
  });

  test('rejects missing name, ing, or spoonacularId', () => {
    const base = [
      validRecipe({ id: 1, cat: 'Breakfast' }),
      validRecipe({ id: 2, cat: 'Lunch' }),
      validRecipe({ id: 3, cat: 'Dinner' })
    ];
    const noName = Lib.validateSpoonacularWeekLibrary(base.concat([validRecipe({ id: 4, name: '' })]));
    assert.equal(noName.ok, false);
    assert.ok(noName.errors.some(function (e) { return e.indexOf('missing_name') > 0; }));

    const noIng = Lib.validateSpoonacularWeekLibrary(base.concat([validRecipe({ id: 4, ing: [] })]));
    assert.equal(noIng.ok, false);
    assert.ok(noIng.errors.some(function (e) { return e.indexOf('missing_ing') > 0; }));

    const noSpId = Lib.validateSpoonacularWeekLibrary(base.concat([validRecipe({ id: 4, spoonacularId: null })]));
    assert.equal(noSpId.ok, false);
    assert.ok(noSpId.errors.some(function (e) { return e.indexOf('missing_spoonacularId') > 0; }));
  });
});

describe('mapSpoonacularBulkToWeekLibrary', () => {
  const Lib = loadLib();

  test('maps bulk payload with category bucket and ingredients', () => {
    const bulk = {
      recipes: [{
        id: 716429,
        recipeId: 716429,
        title: 'Beef Stir-Fry',
        servings: 4,
        readyInMinutes: 25,
        extendedIngredients: [
          { name: 'beef', amount: 8, unit: 'oz', original: '8 oz beef' }
        ],
        instructions: ['Slice beef.', 'Stir fry.']
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '716429': 'Dinner' });
    assert.equal(mapped.recipes.length, 1);
    assert.equal(mapped.recipes[0].name, 'Beef Stir-Fry');
    assert.equal(mapped.recipes[0].cat, 'Dinner');
    assert.equal(mapped.recipes[0].spoonacularId, 716429);
    assert.equal(mapped.recipes[0].ing.length, 1);
    assert.equal(mapped.recipes[0].ing[0], 'beef');
    assert.equal(mapped.recipes[0].ingQty.beef, '8 oz');
    assert.equal(mapped.recipes[0].steps.length, 2);
  });

  test('mapped single recipe fails validation until library has 4 entries', () => {
    const bulk = {
      recipes: [{
        id: 1,
        title: 'Omelette',
        extendedIngredients: [{ name: 'eggs', original: '3 eggs' }],
        instructions: ['Cook']
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '1': 'Breakfast' });
    const validation = Lib.validateSpoonacularWeekLibrary(mapped.recipes);
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some(function (e) { return e.indexOf('recipe_count_below_minimum') === 0; }));
  });
});

describe('fetchSpoonacularWeekLibrary validation gate', () => {
  test('does not call success callback when validation fails after map', async () => {
    const Lib = loadLib({
      fetch: function (url) {
        const path = String(url);
        if (path.indexOf('/bulk') >= 0) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              recipes: [{
                id: 99,
                title: 'Solo',
                extendedIngredients: [{ name: 'rice', original: '1 cup rice' }],
                instructions: ['Cook']
              }]
            })
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ results: [{ id: 99, recipeId: 99 }] })
        });
      }
    });

    const result = await new Promise((resolve) => {
      Lib.fetchSpoonacularWeekLibrary(
        { libraryTargets: { perCat: { Lunch: 2 }, total: 2 }, mt: { perSlot: { cal: 500 } }, restrictions: [] },
        function (err, payload) {
          resolve({ err, payload });
        }
      );
    });

    assert.ok(result.err && result.err.type === 'validation_failed');
    assert.equal(result.payload, null);
  });
});
