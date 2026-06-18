/**
 * Food log adaptive signal extraction tests.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_JS = path.join(__dirname, '..', 'js', 'arc-food-log-signals.js');

function loadSignals() {
  const sandbox = { console, ArcFoodLogSignals: null };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(SIGNALS_JS, 'utf8'), ctx, { filename: 'arc-food-log-signals.js' });
  return sandbox.ArcFoodLogSignals;
}

describe('extractFoodLogSignals', () => {
  const Sig = loadSignals();

  test('Chipotle lunch → restaurant, lunch adherence, mexican cuisine', () => {
    var ex = Sig.extractFoodLogSignals('Chipotle burrito bowl for lunch');
    assert.ok(ex.confidence >= 0.35);
    assert.ok(ex.instantaneous.restaurantFrequency >= 0.2);
    assert.equal(ex.instantaneous.lunchAdherence, 1);
    assert.ok(ex.cuisineHits.mexican >= 0.2);
    assert.ok(ex.evidence.indexOf('restaurant_or_delivery') >= 0);
  });

  test('quick protein shake → quick meal + protein focus', () => {
    var ex = Sig.extractFoodLogSignals('Quick protein shake after the gym');
    assert.ok(ex.instantaneous.quickMealPreference >= 0.2);
    assert.ok(ex.instantaneous.proteinFocus >= 0.2);
  });

  test('skipped breakfast → low breakfast adherence', () => {
    var ex = Sig.extractFoodLogSignals('Skipped breakfast, had a big dinner at an Italian restaurant');
    assert.equal(ex.instantaneous.breakfastAdherence, 0);
    assert.equal(ex.instantaneous.dinnerAdherence, 1);
    assert.ok(ex.instantaneous.restaurantFrequency >= 0.2);
    assert.ok(ex.cuisineHits.italian >= 0.2);
  });
});

describe('mergeFoodLogSignalsIntoAdaptive', () => {
  const Sig = loadSignals();

  test('EMA merge increases scores and persists sampleCount', () => {
    var adaptive = { foodLogSignals: Sig.defaultFoodLogSignals() };
    var ex = Sig.extractFoodLogSignals('DoorDash sushi for dinner — no time to cook');
    var fl = Sig.mergeFoodLogSignalsIntoAdaptive(adaptive, ex, 'test');
    assert.equal(fl.sampleCount, 1);
    assert.ok(fl.restaurantFrequency > 0);
    assert.ok(fl.quickMealPreference > 0);
    assert.ok(fl.dinnerAdherence > 0.5);
    assert.ok(fl.confidence > 0);

    var ex2 = Sig.extractFoodLogSignals('Another takeout lunch from Chipotle');
    Sig.mergeFoodLogSignalsIntoAdaptive(adaptive, ex2, 'test2');
    assert.equal(adaptive.foodLogSignals.sampleCount, 2);
    assert.ok(adaptive.foodLogSignals.restaurantFrequency >= fl.restaurantFrequency);
  });

  test('buildFoodLogAdaptivePromptBlock emits durable signals above threshold', () => {
    var adaptive = {};
    for (var i = 0; i < 3; i++) {
      Sig.mergeFoodLogSignalsIntoAdaptive(
        adaptive,
        Sig.extractFoodLogSignals('High protein chicken bowl from Chipotle for lunch', {
          aiSignals: { proteinFocus: 0.9, restaurantFrequency: 0.85 }
        }),
        'test'
      );
    }
    var block = Sig.buildFoodLogAdaptivePromptBlock(adaptive);
    assert.ok(block.indexOf('FOOD LOG ADAPTIVE SIGNALS') >= 0);
    assert.ok(block.indexOf('proteinFocus') >= 0);
    assert.ok(block.indexOf('restaurantFrequency') >= 0);
    assert.ok(block.indexOf('cuisinePreferences_from_logs') >= 0 || block.indexOf('mexican') >= 0);
  });
});

describe('normalizeAiSignalsFromTriage', () => {
  const Sig = loadSignals();

  test('parses optional triage signals object', () => {
    var ai = Sig.normalizeAiSignalsFromTriage({
      log: true,
      reply: 'Nice lunch!',
      signals: {
        quickMealPreference: 0.8,
        restaurantFrequency: 0.9,
        lunchAdherence: 1,
        cuisinePreferences: { mexican: 0.7 }
      }
    });
    assert.equal(ai.quickMealPreference, 0.8);
    assert.equal(ai.restaurantFrequency, 0.9);
    assert.equal(ai.lunchAdherence, 1);
    assert.equal(ai.cuisinePreferences.mexican, 0.7);
  });
});
