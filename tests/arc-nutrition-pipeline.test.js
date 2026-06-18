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
        detectImpossibleNutrition: () => ({ safe: true }),
        runNutritionSanityChecks: () => ({ valid: true, issues: [] })
      },
      Trace: {
        logOrchestrator: () => {},
        logFallback: () => {},
        logMessage: () => {},
        pathToProvider: (p) =>
          String(p).indexOf('spoonacular-verify') >= 0 ? 'spoonacular' : 'edamam',
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

  test('spoonacularId routes to spoonacular-verify — not Edamam pipeline', async () => {
    let calledPath = '';
    const Pipeline = loadPipeline((url) => {
      calledPath = url;
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            verified: true,
            source: 'spoonacular',
            nutritionConfidence: 'high',
            skipReason: 'spoonacular_id_present',
            macros: { calories: 520, protein: 40, carbs: 48, fat: 18 }
          })
      });
    });

    const result = await Pipeline.verifyRecipe({
      ...baseRecipe,
      spoonacularId: 716429,
      cal: 520,
      p: 40,
      c: 48,
      f: 18,
      nutritionSource: 'spoonacular'
    });
    assert.equal(calledPath, '/api/nutrition/spoonacular-verify');
    assert.equal(result.recipe.nutritionVerified, true);
    assert.equal(result.recipe.nutritionSource, 'spoonacular');
    const nutLog = logs.find((l) => l && l.source === 'spoonacular');
    assert.ok(nutLog, 'expected spoonacular nutrition outcome log');
    assert.equal(nutLog.skipEdamam, true);
    assert.equal(nutLog.skipUsda, true);
  });

  test('local Spoonacular week macros skip Edamam HTTP', async () => {
    let fetchCalls = 0;
    const Pipeline = loadPipeline(() => {
      fetchCalls += 1;
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });

    const result = await Pipeline.verifyRecipe(
      {
        ...baseRecipe,
        spoonacularId: 716429,
        cal: 480,
        p: 35,
        c: 42,
        f: 16,
        nutritionSource: 'spoonacular'
      },
      { preferLocalSpoonacularMacros: true }
    );
    assert.equal(fetchCalls, 0);
    assert.equal(result.verified, true);
    assert.equal(result.recipe.nutritionSource, 'spoonacular');
    const nutLog = logs.find((l) => l && l.skipReason === 'spoonacular_macros_already_mapped');
    assert.ok(nutLog, 'expected local spoonacular skip log');
    assert.equal(nutLog.skipEdamam, true);
    assert.equal(nutLog.skipUsda, true);
  });

  test('hasSpoonacularSourceId ignores local recipe id', () => {
    const Pipeline = loadPipeline(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    assert.equal(Pipeline.hasSpoonacularSourceId({ id: 1 }), false);
    assert.equal(Pipeline.hasSpoonacularSourceId({ id: 1, spoonacularId: 99 }), true);
    assert.equal(Pipeline.spoonacularRecipeIdFor({ id: 1 }), null);
    assert.equal(Pipeline.spoonacularRecipeIdFor({ spoonacularId: 99 }), 99);
  });
});
