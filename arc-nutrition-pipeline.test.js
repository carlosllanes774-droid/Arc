/**
 * Arc nutrition pipeline — fallback and macro retention behavior.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = path.join(__dirname, '..', 'js', 'arc-nutrition-pipeline.js');

function loadPipeline(fetchImpl) {
  const sandbox = {
    console,
    fetch: fetchImpl,
    ArcRuntime: { apiUrl: (p) => p },
    ArcApi: {
      Edamam: {
        normalizeIngredientLine: (s) => String(s || '').trim(),
        normalizeIngredientLines: (lines) => lines.filter(Boolean)
      },
      Validation: {
        detectImpossibleNutrition: () => ({ safe: true })
      },
      Trace: {
        logOrchestrator: () => {},
        logFallback: () => {},
        logMessage: () => {},
        pathToProvider: () => 'edamam',
        pathOperation: () => 'pipeline',
        nowIso: () => new Date().toISOString(),
        timeStart: () => 0,
        logProxy: () => {}
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(PIPELINE_PATH, 'utf8'), sandbox);
  return sandbox.ArcNutritionPipeline;
}

const baseRecipe = {
  name: 'Test Bowl',
  cat: 'Lunch',
  cal: 400,
  p: 30,
  c: 40,
  f: 12,
  ing: ['chicken breast'],
  ingQty: { 'chicken breast': '6 oz' }
};

const mealTargets = {
  Lunch: { cal: 650, p: 45, c: 60, f: 22 }
};

describe('ArcNutritionPipeline.verifyRecipe', () => {
  let logs;

  beforeEach(() => {
    logs = [];
    const orig = console.log;
    console.log = (...args) => {
      if (args[0] === '[ARC NUTRITION]') logs.push(args[1]);
      orig.apply(console, args);
    };
  });

  afterEach(() => {
    console.log = global.console.log;
  });

  test('verified Edamam path preserves macros and sets nutritionVerified true', async () => {
    const Pipeline = loadPipeline(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            verified: true,
            source: 'edamam+usda',
            nutritionConfidence: 'high',
            macros: { calories: 587, protein: 42, carbs: 45, fat: 28 }
          })
      })
    );

    const result = await Pipeline.verifyRecipe({ ...baseRecipe });
    assert.equal(result.recipe.cal, 587);
    assert.equal(result.recipe.nutritionVerified, true);
    assert.equal(result.verified, true);
    assert.equal(logs[0].source, 'edamam+usda');
    assert.equal(logs[0].verified, true);
    assert.equal(logs[0].confidence, 'high');
    assert.equal(logs[0].fallbackUsed, false);
  });

  test('verified=false with macros keeps provider macros (not category targets)', async () => {
    const Pipeline = loadPipeline(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            verified: false,
            reason: 'validation_failed',
            source: 'edamam',
            nutritionConfidence: 'medium',
            macros: { calories: 720, protein: 48, carbs: 55, fat: 30 }
          })
      })
    );

    const result = await Pipeline.verifyRecipe({ ...baseRecipe }, { fallbackTargets: mealTargets.Lunch });
    assert.equal(result.recipe.cal, 720);
    assert.equal(result.recipe.nutritionVerified, false);
    assert.notEqual(result.recipe.cal, mealTargets.Lunch.cal);
    assert.equal(logs[0].verified, false);
    assert.equal(logs[0].fallbackUsed, false);
  });

  test('provider fallback path (USDA) keeps macros with fallbackUsed true', async () => {
    const Pipeline = loadPipeline(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            verified: false,
            fallback: true,
            source: 'usda',
            nutritionConfidence: 'medium',
            macros: { calories: 510, protein: 38, carbs: 42, fat: 18 }
          })
      })
    );

    const result = await Pipeline.verifyRecipe({ ...baseRecipe }, { fallbackTargets: mealTargets.Lunch });
    assert.equal(result.recipe.cal, 510);
    assert.equal(result.recipe.nutritionSource, 'usda');
    assert.equal(logs[0].fallbackUsed, true);
    assert.equal(logs[0].verified, false);
  });

  test('missing macros uses category slot targets', async () => {
    const Pipeline = loadPipeline(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            verified: false,
            reason: 'missing_calories',
            macros: null
          })
      })
    );

    const result = await Pipeline.verifyRecipe({ ...baseRecipe }, { fallbackTargets: mealTargets.Lunch });
    assert.equal(result.recipe.cal, 650);
    assert.equal(result.recipe.nutritionSource, 'category_targets');
    assert.equal(logs[0].source, 'category_targets');
    assert.equal(logs[0].fallbackUsed, true);
  });

  test('pipeline HTTP failure uses category slot targets', async () => {
    const Pipeline = loadPipeline(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ verified: false, reason: 'edamam_failed' })
      })
    );

    const result = await Pipeline.verifyRecipe({ ...baseRecipe }, { fallbackTargets: mealTargets.Lunch });
    assert.equal(result.recipe.cal, 650);
    assert.equal(result.recipe.nutritionSource, 'category_targets');
  });
});
