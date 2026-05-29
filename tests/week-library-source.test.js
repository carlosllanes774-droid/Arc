/**
 * Week library source selection — Spoonacular default, OpenAI fallback reasons.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

function shouldUseSpoonacularWeekLibrary(up, storageGet) {
  try {
    if (up && up.arcWeekLibrarySource === 'openai') return false;
    if (storageGet && storageGet('arcWeekLibrarySource') === 'openai') return false;
  } catch (e) { /* ignore */ }
  return true;
}

function spoonacularFallbackReason(err, payload) {
  if (err && err.type === 'validation_failed') {
    const vErr = err.validation && err.validation.errors;
    if (Array.isArray(vErr) && vErr.length) {
      return 'spoonacular_validation_failed:' + vErr.join(';');
    }
    return 'spoonacular_validation_failed';
  }
  if (!err && (!payload || !Array.isArray(payload.recipes) || !payload.recipes.length)) {
    return 'empty_spoonacular_payload';
  }
  if (!err) return 'empty_spoonacular_payload';
  const msg = err.message || String(err);
  if (err.status === 402 || /402/.test(msg)) return 'spoonacular_quota_exceeded';
  if (err.status === 503 || /503/.test(msg) || /not configured/i.test(msg)) {
    return 'spoonacular_not_configured';
  }
  if (/bulk failed/i.test(msg)) return 'spoonacular_bulk_failed:' + msg;
  if (/search returned no recipe/i.test(msg)) return 'spoonacular_search_empty';
  if (/network|fetch failed|failed to fetch/i.test(msg)) return 'spoonacular_network_error:' + msg;
  return 'spoonacular_fetch_failed:' + msg;
}

describe('shouldUseSpoonacularWeekLibrary', () => {
  test('defaults to Spoonacular when no override', () => {
    assert.equal(shouldUseSpoonacularWeekLibrary({}, null), true);
    assert.equal(shouldUseSpoonacularWeekLibrary(null, function () { return null; }), true);
  });

  test('legacy spoonacular localStorage flag is not required', () => {
    assert.equal(shouldUseSpoonacularWeekLibrary({}, function () { return null; }), true);
  });

  test('openai override via UP or localStorage', () => {
    assert.equal(shouldUseSpoonacularWeekLibrary({ arcWeekLibrarySource: 'openai' }, null), false);
    assert.equal(
      shouldUseSpoonacularWeekLibrary({}, function (k) {
        return k === 'arcWeekLibrarySource' ? 'openai' : null;
      }),
      false
    );
  });
});

describe('spoonacularFallbackReason', () => {
  test('validation_failed includes error codes', () => {
    const reason = spoonacularFallbackReason({
      type: 'validation_failed',
      validation: { errors: ['recipe_count_below_minimum:3', 'recipe[0]:missing_ing'] }
    }, null);
    assert.ok(reason.indexOf('spoonacular_validation_failed:') === 0);
    assert.ok(reason.indexOf('recipe_count_below_minimum') > 0);
  });

  test('quota and bulk failures map to stable reason codes', () => {
    assert.equal(
      spoonacularFallbackReason(new Error('Spoonacular bulk failed: 402'), null),
      'spoonacular_quota_exceeded'
    );
    assert.equal(
      spoonacularFallbackReason(new Error('Spoonacular bulk failed: 500'), null),
      'spoonacular_bulk_failed:Spoonacular bulk failed: 500'
    );
    assert.equal(
      spoonacularFallbackReason(new Error('Spoonacular search returned no recipe ids'), null),
      'spoonacular_search_empty'
    );
  });

  test('empty payload without err', () => {
    assert.equal(spoonacularFallbackReason(null, { recipes: [] }), 'empty_spoonacular_payload');
  });
});
