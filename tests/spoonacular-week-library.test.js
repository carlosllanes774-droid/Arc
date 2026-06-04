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
        calories: 520,
        protein: 42,
        carbs: 28,
        fat: 18,
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
    assert.equal(mapped.recipes[0].cal, 520);
    assert.equal(mapped.recipes[0].p, 42);
    assert.equal(mapped.recipes[0].c, 28);
    assert.equal(mapped.recipes[0].f, 18);
    assert.equal(mapped.recipes[0].nutritionSource, 'spoonacular');
    assert.equal(mapped.recipes[0].nutritionVerified, false);
    assert.equal(mapped.recipes[0].nutritionConfidence, 'low');
    assert.equal(mapped.recipes[0].ing.length, 1);
    assert.equal(mapped.recipes[0].ing[0], 'beef');
    assert.equal(mapped.recipes[0].ingQty.beef, '8 oz');
    assert.equal(JSON.stringify(mapped.recipes[0].ingEdamam), JSON.stringify(['8 oz beef']));
    assert.equal(mapped.recipes[0].steps.length, 2);
  });

  test('maps nutrition from nutrition object when top-level macros absent', () => {
    const bulk = {
      recipes: [{
        id: 2,
        title: 'Salad',
        extendedIngredients: [{ name: 'lettuce', original: '2 cups lettuce' }],
        instructions: [],
        nutrition: { calories: 180, protein: 8, carbs: 12, fat: 10 }
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '2': 'Lunch' }).recipes[0];
    assert.equal(mapped.cal, 180);
    assert.equal(mapped.p, 8);
    assert.equal(mapped.nutritionSource, 'spoonacular');
  });

  test('uses category target fallback when Spoonacular nutrition missing', () => {
    const bulk = {
      recipes: [{
        id: 3,
        title: 'Plain Bowl',
        extendedIngredients: [{ name: 'rice', original: '1 cup rice' }],
        instructions: ['Cook']
      }]
    };
    const mt = {
      Lunch: { cal: 600, p: 45, c: 55, f: 18 },
      perSlot: { cal: 600, p: 45, c: 55, f: 18 }
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '3': 'Lunch' }, mt).recipes[0];
    assert.equal(mapped.cal, 600);
    assert.equal(mapped.p, 45);
    assert.equal(mapped.nutritionSource, 'category_targets');
    assert.equal(mapped.nutritionVerified, false);
  });

  test('stores ingEdamam from original without duplicating names', () => {
    const bulk = {
      recipes: [{
        id: 1,
        title: 'Omelette',
        extendedIngredients: [
          { name: 'eggs', original: '3 eggs' },
          { name: 'salt', original: 'salt to taste' }
        ],
        instructions: []
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '1': 'Breakfast' }).recipes[0];
    assert.equal(JSON.stringify(mapped.ingEdamam), JSON.stringify(['3 eggs', 'salt to taste']));
    assert.equal(mapped.ingQty.eggs, '3 eggs');
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

describe('selectOverlapOptimizedLibrary', () => {
  const Lib = loadLib();

  test('prefers higher ingredient overlap over variety', () => {
    var shared = {
      spoonacularId: 1,
      cat: 'Dinner',
      ing: ['chicken', 'rice', 'broccoli']
    };
    var distinct = {
      spoonacularId: 2,
      cat: 'Dinner',
      ing: ['salmon', 'quinoa', 'asparagus', 'lemon', 'dill']
    };
    var overlapBuddy = {
      spoonacularId: 3,
      cat: 'Dinner',
      ing: ['chicken', 'rice', 'spinach']
    };
    var selection = Lib.selectOverlapOptimizedLibrary(
      [distinct, overlapBuddy, shared],
      { Dinner: 2 },
      { isBudget: true, preferOverlap: true }
    );
    assert.equal(selection.recipes.length, 2);
    var ids = selection.recipes.map(function (r) { return Number(r.spoonacularId); });
    assert.ok(ids.indexOf(1) >= 0 && ids.indexOf(3) >= 0);
    assert.equal(ids.indexOf(2), -1);
    assert.ok(selection.overlap.weekAverage > 0.2);
    assert.ok(selection.uniqueIngredients <= 4);
  });

  test('budget profile favors fewer unique ingredients', () => {
    var simple = {
      spoonacularId: 10,
      cat: 'Lunch',
      ing: ['eggs', 'toast']
    };
    var complex = {
      spoonacularId: 11,
      cat: 'Lunch',
      ing: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    };
    var selection = Lib.selectOverlapOptimizedLibrary(
      [complex, simple],
      { Lunch: 1 },
      { isBudget: true, preferOverlap: true }
    );
    assert.equal(selection.recipes[0].spoonacularId, 10);
    assert.equal(selection.uniqueIngredients, 2);
  });
});

describe('parseDislikes and recipeMatchesDislike', () => {
  const Lib = loadLib();

  test('parseDislikes splits comma and newline separated terms', () => {
    assert.equal(JSON.stringify(Lib.parseDislikes('mushrooms, cilantro\nolives')), '["mushrooms","cilantro","olives"]');
    assert.equal(Lib.parseDislikes('').length, 0);
  });

  test('recipeMatchesDislike checks title and ingredients', () => {
    var recipe = validRecipe({ name: 'Mushroom Risotto', ing: ['rice', 'broth'] });
    assert.equal(Lib.recipeMatchesDislike(recipe, ['mushroom']), 'mushroom');
    assert.equal(Lib.recipeMatchesDislike(recipe, ['cilantro']), null);
    var ingHit = validRecipe({ name: 'Garden Bowl', ing: ['spinach', 'cilantro', 'quinoa'] });
    assert.equal(Lib.recipeMatchesDislike(ingHit, ['cilantro']), 'cilantro');
  });
});

describe('validateRecipeDietCompliance', () => {
  const Lib = loadLib();

  test('vegan rejects chicken', () => {
    var r = validRecipe({ name: 'Chicken Bowl', ing: ['chicken', 'rice'] });
    var result = Lib.validateRecipeDietCompliance(r, ['Vegan']);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(function (v) { return v.indexOf('vegan:') === 0; }));
  });

  test('vegetarian allows eggs but rejects fish', () => {
    var eggs = validRecipe({ name: 'Omelette', ing: ['eggs', 'spinach'] });
    assert.equal(Lib.validateRecipeDietCompliance(eggs, ['Vegetarian']).ok, true);
    var fish = validRecipe({ name: 'Salmon plate', ing: ['salmon', 'lemon'] });
    assert.equal(Lib.validateRecipeDietCompliance(fish, ['Vegetarian']).ok, false);
  });

  test('dairy-free rejects cheese', () => {
    var r = validRecipe({ name: 'Pasta', ing: ['pasta', 'parmesan'] });
    assert.equal(Lib.validateRecipeDietCompliance(r, ['Dairy-free']).ok, false);
  });

  test('nut allergy rejects peanuts', () => {
    var r = validRecipe({ name: 'Stir fry', ing: ['peanut sauce', 'vegetables'] });
    assert.equal(Lib.validateRecipeDietCompliance(r, ['Nut allergy']).ok, false);
  });

  test('halal rejects pork and wine', () => {
    assert.equal(Lib.validateRecipeDietCompliance(validRecipe({ ing: ['pork'] }), ['Halal']).ok, false);
    assert.equal(Lib.validateRecipeDietCompliance(validRecipe({ ing: ['red wine'] }), ['Halal']).ok, false);
  });

  test('gluten-free rejects wheat flour', () => {
    var r = validRecipe({ name: 'Bread bowl', ing: ['wheat flour', 'yeast'] });
    assert.equal(Lib.validateRecipeDietCompliance(r, ['Gluten-free']).ok, false);
  });
});

describe('filterCompliantCandidates', () => {
  const Lib = loadLib();

  test('filters dislikes and diet violations from pool', () => {
    var pool = [
      validRecipe({ spoonacularId: 1, name: 'Beef Stew', ing: ['beef', 'carrot'] }),
      validRecipe({ spoonacularId: 2, name: 'Veg Bowl', ing: ['rice', 'broccoli'] }),
      validRecipe({ spoonacularId: 3, name: 'Peanut Noodles', ing: ['noodles', 'peanut butter'] })
    ];
    var result = Lib.filterCompliantCandidates(pool, ['Vegan'], ['beef', 'peanut']);
    assert.equal(result.compliant.length, 1);
    assert.equal(result.compliant[0].spoonacularId, 2);
    assert.equal(result.rejectedDislikes.length, 2);
    assert.equal(result.rejectedDiet.length, 0);
  });
});

describe('selectOverlapOptimizedLibrary weekly mode', () => {
  const Lib = loadLib();

  test('preferProtein favors higher protein density', () => {
    var low = { spoonacularId: 1, cat: 'Dinner', cal: 500, p: 20, ing: ['a', 'b'] };
    var high = { spoonacularId: 2, cat: 'Dinner', cal: 500, p: 45, ing: ['c', 'd'] };
    var selection = Lib.selectOverlapOptimizedLibrary([low, high], { Dinner: 1 }, { preferProtein: true, preferOverlap: false });
    assert.equal(selection.recipes[0].spoonacularId, 2);
  });

  test('varietyMode prefers lower ingredient overlap', () => {
    var sharedA = { spoonacularId: 1, cat: 'Lunch', ing: ['chicken', 'rice', 'broccoli'] };
    var sharedB = { spoonacularId: 2, cat: 'Lunch', ing: ['chicken', 'rice', 'spinach'] };
    var distinct = { spoonacularId: 3, cat: 'Lunch', ing: ['salmon', 'quinoa', 'asparagus'] };
    var varietyPick = Lib.selectOverlapOptimizedLibrary(
      [sharedA, sharedB, distinct],
      { Lunch: 2 },
      { varietyMode: true, preferOverlap: false }
    );
    var ids = varietyPick.recipes.map(function (r) { return Number(r.spoonacularId); });
    assert.ok(ids.indexOf(3) >= 0);
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
                calories: 400,
                protein: 20,
                carbs: 40,
                fat: 12,
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

  test('passes maxReadyTime and minProtein for weekly mode search', async () => {
    var searchBodies = [];
    const Lib = loadLib({
      fetch: function (url, opts) {
        const path = String(url);
        if (path.indexOf('/bulk') >= 0) {
          var body = JSON.parse(opts.body);
          var recipes = (body.ids || []).map(function (id, idx) {
            return {
              id: id,
              title: 'Recipe ' + id,
              calories: 400,
              protein: 40,
              carbs: 30,
              fat: 12,
              readyInMinutes: 20,
              extendedIngredients: [{ name: 'tofu', original: '8 oz tofu' }],
              instructions: ['Cook']
            };
          });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ recipes: recipes })
          });
        }
        searchBodies.push(JSON.parse(opts.body));
        var isDinner = String(JSON.parse(opts.body).query || '').indexOf('dinner') >= 0;
        var ids = isDinner ? [201, 202, 203, 204, 205, 206] : [101, 102, 103, 104, 105, 106];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: ids.map(function (id) { return { id: id, recipeId: id }; })
          })
        });
      }
    });

    await new Promise((resolve) => {
      Lib.fetchSpoonacularWeekLibrary(
        {
          libraryTargets: { perCat: { Lunch: 2, Dinner: 2 }, total: 4, profile: 'standard', varietyMode: false },
          mt: { perSlot: { cal: 500, p: 40 }, Lunch: { cal: 500, p: 40 }, Dinner: { cal: 500, p: 40 } },
          restrictions: ['Vegan'],
          dislikes: 'mushroom',
          weekMode: { focus: 'quick', maxReadyTime: 25, preferProtein: true }
        },
        function (err, payload) {
          resolve({ err, payload, searchBodies });
        }
      );
    }).then(function (result) {
      assert.equal(result.err, null);
      assert.ok(result.searchBodies.length >= 1);
      assert.ok(result.searchBodies.every(function (b) { return b.maxReadyTime === 25; }));
      assert.ok(result.searchBodies.some(function (b) { return b.minProtein > 0; }));
      assert.ok(result.payload.recipes.every(function (r) {
        return r.ing.indexOf('tofu') >= 0;
      }));
    });
  });

  test('filters disliked ingredients and fetches compliant replacements', async () => {
    var searchCall = 0;
    const Lib = loadLib({
      fetch: function (url, opts) {
        const path = String(url);
        if (path.indexOf('/bulk') >= 0) {
          var body = JSON.parse(opts.body);
          var recipes = (body.ids || []).map(function (id) {
            if (Number(id) === 1) {
              return {
                id: 1,
                title: 'Mushroom Soup',
                calories: 400,
                protein: 30,
                carbs: 35,
                fat: 12,
                extendedIngredients: [{ name: 'mushroom', original: '2 cups mushroom' }],
                instructions: ['Simmer']
              };
            }
            return {
              id: id,
              title: 'Clean Bowl ' + id,
              calories: 420,
              protein: 32,
              carbs: 36,
              fat: 11,
              extendedIngredients: [{ name: 'tofu', original: '8 oz tofu' }],
              instructions: ['Cook']
            };
          });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ recipes: recipes })
          });
        }
        searchCall += 1;
        var ids = searchCall === 1 ? [1, 2, 3, 4, 5, 6] : [7, 8, 9, 10, 11, 12];
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: ids.map(function (id) { return { id: id, recipeId: id }; })
          })
        });
      }
    });

    const result = await new Promise((resolve) => {
      Lib.fetchSpoonacularWeekLibrary(
        {
          libraryTargets: { perCat: { Lunch: 3, Dinner: 3 }, total: 6, profile: 'standard', varietyMode: false },
          mt: { perSlot: { cal: 500, p: 40 }, Lunch: { cal: 500, p: 40 }, Dinner: { cal: 500, p: 40 } },
          restrictions: [],
          dislikes: 'mushroom'
        },
        function (err, payload) {
          resolve({ err, payload, searchCall });
        }
      );
    });

    assert.equal(result.err, null);
    assert.ok(result.searchCall >= 1);
    assert.ok(result.payload.recipes.every(function (r) {
      return String(r.name).toLowerCase().indexOf('mushroom') < 0;
    }));
  });

  test('requests bulk with includeNutrition true and selects overlap-optimized subset', async () => {
    let bulkBody = null;
    const Lib = loadLib({
      fetch: function (url, opts) {
        const path = String(url);
        if (path.indexOf('/bulk') >= 0) {
          bulkBody = JSON.parse(opts.body);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({
              recipes: [
                { id: 1, title: 'A', calories: 400, protein: 30, carbs: 35, fat: 12, extendedIngredients: [{ name: 'chicken', original: '8 oz chicken' }, { name: 'rice', original: '1 cup rice' }], instructions: ['x'] },
                { id: 2, title: 'B', calories: 500, protein: 35, carbs: 40, fat: 14, extendedIngredients: [{ name: 'salmon', original: '6 oz salmon' }], instructions: ['y'] },
                { id: 3, title: 'C', calories: 450, protein: 32, carbs: 38, fat: 13, extendedIngredients: [{ name: 'chicken', original: '8 oz chicken' }, { name: 'broccoli', original: '2 cups broccoli' }], instructions: ['z'] },
                { id: 4, title: 'D', calories: 420, protein: 28, carbs: 36, fat: 11, extendedIngredients: [{ name: 'beef', original: '8 oz beef' }], instructions: ['w'] },
                { id: 5, title: 'E', calories: 410, protein: 29, carbs: 34, fat: 10, extendedIngredients: [{ name: 'chicken', original: '8 oz chicken' }, { name: 'rice', original: '1 cup rice' }], instructions: ['v'] },
                { id: 6, title: 'F', calories: 430, protein: 31, carbs: 37, fat: 12, extendedIngredients: [{ name: 'tofu', original: '8 oz tofu' }], instructions: ['u'] }
              ]
            })
          });
        }
        var searchBody = opts && opts.body ? JSON.parse(opts.body) : {};
        var isDinner = String(searchBody.query || '').indexOf('dinner') >= 0;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: isDinner
              ? [{ id: 4, recipeId: 4 }, { id: 5, recipeId: 5 }, { id: 6, recipeId: 6 }]
              : [{ id: 1, recipeId: 1 }, { id: 2, recipeId: 2 }, { id: 3, recipeId: 3 }]
          })
        });
      }
    });

    const result = await new Promise((resolve) => {
      Lib.fetchSpoonacularWeekLibrary(
        {
          libraryTargets: {
            perCat: { Lunch: 3, Dinner: 3 },
            total: 6,
            profile: 'standard',
            budgetProfile: 'Moderate',
            varietyMode: false
          },
          mt: { perSlot: { cal: 500, p: 40, c: 50, f: 15 }, Lunch: { cal: 500, p: 40, c: 50, f: 15 }, Dinner: { cal: 500, p: 40, c: 50, f: 15 } },
          restrictions: []
        },
        function (err, payload, meta) {
          resolve({ err, payload, meta });
        }
      );
    });

    assert.equal(bulkBody && bulkBody.includeNutrition, true);
    assert.equal(result.err, null);
    assert.equal(result.payload.recipes.length, 6);
    assert.ok(result.meta && result.meta.librarySelection);
    assert.ok(result.meta.librarySelection.overlapAfter >= result.meta.librarySelection.overlapBefore || result.meta.librarySelection.uniqueIngredientsAfter <= result.meta.librarySelection.uniqueIngredientsBefore);
    assert.ok(result.payload.recipes.every(function (r) {
      return r.nutritionSource === 'spoonacular' && r.cal > 0 && r.p > 0;
    }));
  });
});

describe('cuisine preference enforcement', () => {
  const Lib = loadLib();

  test('resolveCuisineContext maps Mexican and Italian to Spoonacular slugs', () => {
    var ctx = Lib.resolveCuisineContext(['Mexican', 'Italian']);
    assert.equal(ctx.active, true);
    assert.equal(ctx.selected.length, 2);
    assert.equal(ctx.selected[0], 'Mexican');
    assert.equal(ctx.selected[1], 'Italian');
    assert.equal(ctx.slugs.length, 2);
    assert.equal(ctx.slugs[0], 'mexican');
    assert.equal(ctx.slugs[1], 'italian');
    assert.equal(ctx.cuisineParam, 'mexican,italian');
    assert.ok(ctx.queryTerms.indexOf('mexican') >= 0);
    assert.ok(ctx.queryTerms.indexOf('italian') >= 0);
  });

  test('buildCategorySearchQuery prefixes cuisine into search terms', () => {
    var ctx = Lib.resolveCuisineContext(['Mexican', 'Italian']);
    var lunchQ = Lib.buildCategorySearchQuery('Lunch', ctx, 0);
    var dinnerQ = Lib.buildCategorySearchQuery('Dinner', ctx, 1);
    assert.ok(/mexican/i.test(lunchQ));
    assert.ok(/lunch/i.test(lunchQ));
    assert.ok(/italian/i.test(dinnerQ));
    assert.ok(/dinner/i.test(dinnerQ));
  });

  test('selectOverlapOptimizedLibrary prefers cuisine-matched recipes', () => {
    var ctx = Lib.resolveCuisineContext(['Italian']);
    var italian = {
      spoonacularId: 1,
      cat: 'Dinner',
      name: 'Classic Pasta Marinara',
      ing: ['pasta', 'marinara', 'parmesan'],
      cal: 500,
      p: 30
    };
    var generic = {
      spoonacularId: 2,
      cat: 'Dinner',
      name: 'Plain Chicken Bowl',
      ing: ['chicken', 'rice'],
      cal: 500,
      p: 30
    };
    var pick = Lib.selectOverlapOptimizedLibrary(
      [generic, italian],
      { Dinner: 1 },
      { preferOverlap: false, cuisineCtx: ctx }
    );
    assert.equal(pick.recipes[0].spoonacularId, 1);
  });

  test('fetchSpoonacularWeekLibrary sends cuisine param and biased queries for Mexican + Italian', async () => {
    var searchBodies = [];
    const Lib = loadLib({
      fetch: function (url, opts) {
        const path = String(url);
        if (path.indexOf('/bulk') >= 0) {
          var body = JSON.parse(opts.body);
          var recipes = (body.ids || []).map(function (id) {
            var n = Number(id);
            if (n === 10) {
              return {
                id: 10,
                title: 'Chicken Taco Bowl',
                calories: 420,
                protein: 32,
                carbs: 36,
                fat: 11,
                tags: ['mexican'],
                extendedIngredients: [{ name: 'tortilla', original: '2 tortillas' }, { name: 'salsa', original: '1/2 cup salsa' }],
                instructions: ['Assemble']
              };
            }
            if (n === 20) {
              return {
                id: 20,
                title: 'Pasta Primavera',
                calories: 430,
                protein: 28,
                carbs: 40,
                fat: 12,
                tags: ['italian'],
                extendedIngredients: [{ name: 'pasta', original: '8 oz pasta' }, { name: 'parmesan', original: '2 tbsp parmesan' }],
                instructions: ['Boil']
              };
            }
            return {
              id: id,
              title: 'Generic Bowl ' + id,
              calories: 400,
              protein: 25,
              carbs: 35,
              fat: 10,
              extendedIngredients: [{ name: 'chicken', original: '8 oz chicken' }],
              instructions: ['Cook']
            };
          });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ recipes: recipes })
          });
        }
        searchBodies.push(JSON.parse(opts.body));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            results: [
              { id: 10, recipeId: 10 },
              { id: 20, recipeId: 20 },
              { id: 30, recipeId: 30 },
              { id: 40, recipeId: 40 },
              { id: 50, recipeId: 50 },
              { id: 60, recipeId: 60 }
            ]
          })
        });
      }
    });

    const result = await new Promise((resolve) => {
      Lib.fetchSpoonacularWeekLibrary(
        {
          libraryTargets: { perCat: { Lunch: 4 }, total: 4, profile: 'standard', varietyMode: false },
          mt: { perSlot: { cal: 500, p: 40 }, Lunch: { cal: 500, p: 40 } },
          restrictions: [],
          cuisines: ['Mexican', 'Italian']
        },
        function (err, payload) {
          resolve({ err, payload, searchBodies });
        }
      );
    });

    assert.equal(result.err, null);
    assert.ok(result.searchBodies.length >= 1);
    assert.ok(result.searchBodies.every(function (b) {
      return b.cuisine === 'mexican,italian';
    }));
    assert.ok(result.searchBodies.some(function (b) {
      return /mexican|italian/i.test(String(b.query || ''));
    }));

    var dist = Lib.summarizeCuisineDistribution(result.payload.recipes, Lib.resolveCuisineContext(['Mexican', 'Italian']));
    assert.ok(dist.matchedCount >= 1, 'expected at least one cuisine-matched recipe in final library');
    assert.ok(
      dist.counts.mexican >= 1 || dist.counts.italian >= 1,
      'final library should include mexican or italian signals: ' + JSON.stringify(dist.counts)
    );
  });
});
