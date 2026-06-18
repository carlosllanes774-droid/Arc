/**
 * Spoonacular → Edamam ingredient line and spoonacularId preservation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function loadPipeline() {
  const edSandbox = vm.createContext({ console, ArcApi: {} });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/arc-api/edamamHelpers.js'), 'utf8'), edSandbox);
  const Edamam = edSandbox.ArcApi.Edamam;

  const libSandbox = vm.createContext({ console, ArcRuntime: null, ArcSpoonacularWeekLibrary: null });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/spoonacular-week-library.js'), 'utf8'), libSandbox);
  const Lib = libSandbox.ArcSpoonacularWeekLibrary;

  const pipeSandbox = vm.createContext({
    console,
    ArcRuntime: { apiUrl: (p) => p },
    ArcApi: { Edamam },
    ArcNutritionPipeline: null
  });
  vm.runInContext(readFileSync(path.join(ROOT, 'js/arc-nutrition-pipeline.js'), 'utf8'), pipeSandbox);

  return {
    Lib,
    Pipeline: pipeSandbox.ArcNutritionPipeline,
    Edamam
  };
}

function linesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasDuplicatedIngredientName(line) {
  const parts = String(line || '').toLowerCase().trim().split(/\s+/);
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  const prev = parts[parts.length - 2];
  return last === prev;
}

describe('Spoonacular Edamam ingredient lines', () => {
  const { Lib, Pipeline } = loadPipeline();

  test('uses original text for Edamam — no duplicated names', () => {
    const bulk = {
      recipes: [{
        id: 716429,
        title: 'Omelette',
        extendedIngredients: [
          { name: 'eggs', original: '3 eggs' },
          { name: 'salt', original: 'salt to taste' },
          { name: 'beef', amount: 8, unit: 'oz', original: '8 oz beef' }
        ],
        instructions: []
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '716429': 'Breakfast' }).recipes[0];
    assert.ok(linesEqual(mapped.ingEdamam, ['3 eggs', 'salt to taste', '8 oz beef']));
    assert.equal(mapped.spoonacularId, 716429);

    const lines = Pipeline.ingredientLines(mapped);
    assert.ok(linesEqual(lines, ['3 eggs', 'salt to taste', '8 oz beef']));
    lines.forEach((line) => {
      assert.equal(hasDuplicatedIngredientName(line), false, 'duplicated name in: ' + line);
    });
  });

  test('duplicate display names keep separate stable ingQty keys', () => {
    const bulk = {
      recipes: [{
        id: 99,
        title: 'Cake',
        extendedIngredients: [
          { id: 1, name: 'flour', amount: 1, unit: 'cup', original: '1 cup flour' },
          { id: 2, name: 'flour', amount: 2, unit: 'tbsp', original: '2 tbsp flour for dusting' }
        ],
        instructions: []
      }]
    };
    const mapped = Lib.mapSpoonacularBulkToWeekLibrary(bulk, { '99': 'Snack' }).recipes[0];
    assert.equal(mapped.ing.length, 2);
    assert.equal(mapped.ingKeys.length, 2);
    assert.notEqual(mapped.ingKeys[0], mapped.ingKeys[1]);
    assert.equal(mapped.ingQty[mapped.ingKeys[0]], '1 cup');
    assert.equal(mapped.ingQty[mapped.ingKeys[1]], '2 tbsp');
    assert.ok(linesEqual(mapped.ingEdamam, ['1 cup flour', '2 tbsp flour for dusting']));

    const lines = Pipeline.ingredientLines(mapped);
    assert.equal(lines.length, 2);
  });

  test('spoonacularRecipeIdFor ignores local id', () => {
    const { Pipeline } = loadPipeline();
    assert.equal(Pipeline.spoonacularRecipeIdFor({ id: 1, spoonacularId: 716429 }), 716429);
    assert.equal(Pipeline.spoonacularRecipeIdFor({ id: 1 }), null);
  });

  test('OpenAI-style recipes still join qty without duplicating', () => {
    const lines = Pipeline.ingredientLines({
      ing: ['eggs'],
      ingQty: { eggs: '3 eggs' }
    });
    assert.ok(linesEqual(lines, ['3 eggs']));
    assert.equal(hasDuplicatedIngredientName(lines[0]), false);
  });
});

describe('normalizeGeneratedRecipe spoonacularId passthrough (simulated)', () => {
  test('fields survive minimal normalizer shape', () => {
    const mapped = {
      spoonacularId: 716429,
      ingEdamam: ['3 eggs'],
      ingKeys: ['sp_716429_0'],
      ing: ['eggs'],
      ingQty: { eggs: '3 eggs' },
      name: 'Omelette',
      cat: 'Breakfast'
    };
    const norm = {
      id: 1,
      spoonacularId: mapped.spoonacularId != null ? mapped.spoonacularId : null,
      ingEdamam: Array.isArray(mapped.ingEdamam) ? mapped.ingEdamam.slice() : [],
      ingKeys: Array.isArray(mapped.ingKeys) ? mapped.ingKeys.slice() : [],
      ing: mapped.ing.slice(),
      ingQty: mapped.ingQty
    };
    const { Pipeline } = loadPipeline();
    assert.equal(norm.spoonacularId, 716429);
    assert.equal(Pipeline.spoonacularRecipeIdFor(norm), 716429);
    assert.ok(linesEqual(Pipeline.ingredientLines(norm), ['3 eggs']));
  });
});
