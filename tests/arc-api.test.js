/**
 * Arc API — routing, services, validation, and adaptive pipeline.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, '..', 'js', 'arc-api');
const CONFIG_DIR = path.join(__dirname, '..', 'js', 'config');
const ENGINE_DIR = path.join(__dirname, '..', 'js', 'arc-engine');

const ARC_BASE = path.join(__dirname, '..', 'js', 'arc-api-base.js');

const LOAD_ORDER = [
  'arcCache.js',
  'arcRateLimit.js',
  'providers/providerBase.js',
  'spoonacularService.js',
  'edamamService.js',
  'usdaService.js',
  'krogerService.js',
  'openaiService.js',
  'arcValidationService.js',
  'providers/spoonacularProvider.js',
  'providers/edamamProvider.js',
  'providers/usdaProvider.js',
  'providers/openaiProvider.js',
  'providers/krogerProvider.js',
  'apiOrchestrator.js'
];

const ENGINE_LOAD = [
  'arcNutritionEngine.js',
  'arcGoalEngine.js',
  'arcAthleteEngine.js',
  'arcMealOptimizer.js',
  'arcBudgetEngine.js',
  'arcPortionScaler.js',
  'arcAdherenceEngine.js',
  'arcEngine.js'
];

function loadArcApi(extraSandbox) {
  const sandbox = Object.assign({
    ArcApi: { Providers: {}, Services: {} },
    fetch: extraSandbox && extraSandbox.fetch,
    location: { origin: 'http://localhost:3000' },
    ARC_API: { baseUrl: 'http://localhost:3000' }
  }, extraSandbox || {});
  const context = vm.createContext(sandbox);

  vm.runInContext(readFileSync(path.join(CONFIG_DIR, 'apiConfig.js'), 'utf8'), context, {
    filename: 'apiConfig.js'
  });
  vm.runInContext(readFileSync(ARC_BASE, 'utf8'), context, { filename: 'arc-api-base.js' });

  for (const file of LOAD_ORDER) {
    vm.runInContext(readFileSync(path.join(API_DIR, file), 'utf8'), context, { filename: file });
  }
  return sandbox;
}

function mockFetch(handler) {
  return function (url, opts) {
    return Promise.resolve(handler(url, opts));
  };
}

describe('Arc API config', () => {
  test('validate reports missing keys in empty env', () => {
    const sandbox = loadArcApi({ process: { env: {} } });
    const cfg = sandbox.ArcConfig.loadFromEnv({});
    const v = sandbox.ArcConfig.validate(cfg);
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes('SPOONACULAR_API_KEY'));
    assert.ok(v.missing.includes('USDA_API_KEY'));
  });

  test('validate passes when all required keys present', () => {
    const sandbox = loadArcApi({
      process: {
        env: {
          SPOONACULAR_API_KEY: 'a',
          EDAMAM_APP_ID: 'b',
          EDAMAM_API_KEY: 'c',
          USDA_API_KEY: 'd',
          OPENAI_API_KEY: 'e',
          KROGER_CLIENT_ID: 'f',
          KROGER_SECRET: 'g'
        }
      }
    });
    const cfg = sandbox.ArcConfig.loadFromEnv(sandbox.process.env);
    const v = sandbox.ArcConfig.validate(cfg);
    assert.equal(v.valid, true);
  });
});

describe('Arc API responsibility routing', () => {
  const { ArcApi } = loadArcApi();

  test('registry includes Edamam food intelligence responsibilities', () => {
    const registry = ArcApi.Orchestrator.getProviderRegistry();
    const edamam = registry.find((r) => r.id === 'edamam');
    assert.ok(edamam);
    assert.ok(edamam.responsibilities.includes('recipe_nutrition_analysis'));
    assert.ok(edamam.responsibilities.includes('ingredient_parsing'));
    assert.ok(edamam.arcBoundary.some((b) => b.indexOf('calorie targets') !== -1));
  });

  test('Spoonacular owns meal discovery not nutrition analysis', () => {
    assert.equal(ArcApi.Orchestrator.RESPONSIBILITY_OWNER.meal_discovery, 'spoonacular');
    assert.equal(ArcApi.Orchestrator.RESPONSIBILITY_OWNER.recipe_nutrition_analysis, 'edamam');
    assert.equal(ArcApi.Orchestrator.RESPONSIBILITY_OWNER.macro_validation, 'usda');
    assert.equal(ArcApi.Orchestrator.RESPONSIBILITY_OWNER.adaptation, 'openai');
    assert.equal(ArcApi.Orchestrator.RESPONSIBILITY_OWNER.grocery_pricing, 'kroger');
  });

  test('USDA validateMacros runs heuristic without network', async () => {
    const result = await ArcApi.Orchestrator.validateMacros({
      calories: 600,
      protein: 45,
      carbs: 55,
      fat: 18
    });
    assert.equal(result.provider, 'usda');
    assert.equal(result.status, 'ok');
    assert.equal(result.data.valid, true);
  });

  test('Spoonacular discoverMeals proxies search', async () => {
    const { ArcApi } = loadArcApi({
      fetch: mockFetch((url) => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            results: [{ id: 42, title: 'Salmon bowl', servings: 2, readyInMinutes: 25 }]
          })
      }))
    });

    const result = await ArcApi.Orchestrator.discoverMeals({ query: 'salmon' });
    assert.equal(result.provider, 'spoonacular');
    assert.equal(result.status, 'ok');
    assert.equal(result.data.recipes[0].recipeId, 42);
  });

  test('Edamam parseFoodInput uses /api/edamam/parse', async () => {
    const { ArcApi } = loadArcApi({
      fetch: mockFetch((url) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ foods: [{ label: '2 eggs' }], ingr: ['2 eggs'] })
      }))
    });

    const result = await ArcApi.Orchestrator.parseFoodInput({ text: '2 eggs and toast' });
    assert.equal(result.status, 'ok');
    assert.equal(result.data.foods[0].label, '2 eggs');
  });
});

describe('Arc API validation layer', () => {
  test('detectImpossibleNutrition flags protein exceeding calories', () => {
    const { ArcApi } = loadArcApi();
    const report = ArcApi.Validation.detectImpossibleNutrition({
      calories: 100,
      protein: 80,
      carbs: 0,
      fat: 0
    });
    assert.equal(report.safe, false);
    assert.ok(report.impossible.length > 0);
  });

  test('verifyRecipeCompleteness requires ingredients', () => {
    const { ArcApi } = loadArcApi();
    const r = ArcApi.Validation.verifyRecipeCompleteness({ title: 'Test' });
    assert.equal(r.complete, false);
    assert.ok(r.missing.includes('ingredients'));
  });
});

describe('Arc API Edamam nutrition proxy', () => {
  test('analyzeRecipeNutrition uses /api/nutrition', async () => {
    var called = null;
    const { ArcApi } = loadArcApi({
      fetch: mockFetch((url, opts) => {
        called = { url: url, body: JSON.parse(opts.body) };
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              totalNutrients: { calories: 620, protein: 48, fat: 19, carbs: 58 }
            })
        };
      })
    });

    const result = await ArcApi.Orchestrator.analyzeRecipeNutrition({
      title: 'Chicken bowl',
      ingr: ['6 oz chicken', '1 cup rice']
    });

    assert.ok(called.url.endsWith('/api/nutrition'));
    assert.equal(result.status, 'ok');
    assert.equal(result.data.normalized.calories, 620);
  });
});

describe('Arc API composite pipeline', () => {
  test('analyzeAndValidateRecipe chains Edamam → USDA', async () => {
    const { ArcApi } = loadArcApi({
      fetch: mockFetch(() => ({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            totalNutrients: { calories: 500, protein: 40, carbs: 45, fat: 15 }
          })
      }))
    });

    const out = await ArcApi.Orchestrator.analyzeAndValidateRecipe({
      ingr: ['4 oz tofu', '2 cup greens']
    });

    assert.equal(out.nutrition.provider, 'edamam');
    assert.equal(out.validation.provider, 'usda');
    assert.equal(out.validation.status, 'ok');
    assert.ok(out.arcNote.indexOf('Arc Engine') !== -1);
  });
});

describe('Arc Phase 2 adaptive pipeline (mocked APIs)', () => {
  function loadEngineAndApi() {
    const sandbox = loadArcApi({
      fetch: mockFetch((url, opts) => {
        if (url.indexOf('/api/spoonacular/search') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                results: [
                  {
                    id: 1,
                    recipeId: 1,
                    title: 'Chicken rice bowl',
                    servings: 2,
                    readyInMinutes: 30,
                    ingredients: [
                      { name: 'chicken', original: '6 oz chicken breast' },
                      { name: 'rice', original: '1 cup cooked rice' }
                    ]
                  }
                ]
              })
          };
        }
        if (url.indexOf('/api/nutrition') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                totalNutrients: { calories: 650, protein: 52, fat: 18, carbs: 60 }
              })
          };
        }
        if (url.indexOf('/api/ai') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () => ({
              content: [{ type: 'text', text: 'Prioritize lean protein remainder of day.' }]
            })
          };
        }
        if (url.indexOf('/api/kroger/prices') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () => ({
              results: { ing_0: { priceEffective: 4.5 }, ing_1: { priceEffective: 2.2 } },
              locationId: 'loc1'
            })
          };
        }
        return { ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) };
      })
    });

    const context = vm.createContext(sandbox);
    for (const file of ENGINE_LOAD) {
      vm.runInContext(readFileSync(path.join(ENGINE_DIR, file), 'utf8'), context, { filename: file });
    }
    return sandbox;
  }

  test('200 lb male gain 1 lb/week — reasonable targets in pipeline', async () => {
    const sandbox = loadEngineAndApi();
    const out = await sandbox.ArcApi.Orchestrator.runAdaptiveMealPipeline({
      goal: 'Gain weight',
      goalPace: 1,
      weight: 200,
      height: 70,
      age: 28,
      gender: 'male',
      activityLevel: 'Moderate',
      mealQuery: 'high protein dinner'
    });

    assert.equal(out.arcOwned, true);
    assert.ok(out.arc.goal.targetCalories >= 3000);
    assert.ok(out.arc.goal.proteinTarget >= 160);
    assert.equal(out.nutrition.status, 'ok');
    assert.equal(out.usdaValidation.status, 'ok');
    assert.ok(out.scaledRecipe);
  });

  test('off-plan "I ate tacos" uses Edamam parse path', async () => {
    const sandbox = loadEngineAndApi();
    const out = await sandbox.ArcApi.Orchestrator.runAdaptiveMealPipeline({
      goal: 'Maintain weight',
      weight: 180,
      height: 70,
      age: 30,
      gender: 'male',
      activityLevel: 'Moderate',
      foodLogText: 'I ate tacos',
      scenario: 'off_plan'
    });

    assert.equal(out.scenario, 'off_plan');
    assert.ok(out.adaptation);
  });

  test('Kroger failure falls back to Arc budget estimate', async () => {
    const sandbox = loadEngineAndApi({
      fetch: mockFetch((url) => {
        if (url.indexOf('/api/kroger/prices') !== -1) {
          return { ok: false, status: 503, json: () => Promise.resolve({ error: 'down' }) };
        }
        if (url.indexOf('/api/spoonacular/search') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                results: [
                  {
                    id: 2,
                    recipeId: 2,
                    title: 'Simple eggs',
                    servings: 1,
                    readyInMinutes: 10,
                    ingredients: [{ name: 'eggs', original: '2 eggs' }]
                  }
                ]
              })
          };
        }
        if (url.indexOf('/api/nutrition') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                totalNutrients: { calories: 400, protein: 30, fat: 20, carbs: 10 }
              })
          };
        }
        if (url.indexOf('/api/ai') !== -1) {
          return {
            ok: true,
            status: 200,
            json: () => ({ content: [{ type: 'text', text: 'ok' }] })
          };
        }
        return { ok: false, status: 404, json: () => Promise.resolve({}) };
      })
    });

    const context = vm.createContext(sandbox);
    for (const file of ENGINE_LOAD) {
      vm.runInContext(readFileSync(path.join(ENGINE_DIR, file), 'utf8'), context, { filename: file });
    }

    const out = await sandbox.ArcApi.Orchestrator.runAdaptiveMealPipeline({
      goal: 'Lose weight',
      goalPace: 0.75,
      weight: 200,
      height: 70,
      age: 28,
      gender: 'male',
      activityLevel: 'Moderate',
      budgetTier: 'moderate'
    });

    assert.equal(out.pricing.status, 'ok');
    assert.equal(out.pricing.data.source, 'arc_budget_engine');
  });
});
