/**
 * Week library target caps — budget vs standard profiles.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGETS_JS = path.join(__dirname, '..', 'js', 'week-library-targets.js');

function loadTargets() {
  const sandbox = { ArcWeekLibraryTargets: null };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(TARGETS_JS, 'utf8'), ctx, { filename: 'week-library-targets.js' });
  return sandbox.ArcWeekLibraryTargets;
}

describe('computeWeekCoreLibraryTargets', () => {
  const T = loadTargets();

  test('standard profile caps 4-slot week at 8 recipes', () => {
    const slots = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    const result = T.computeWeekCoreLibraryTargets(slots, { budgetProfile: 'Moderate' });
    assert.equal(result.total, 8);
    assert.equal(result.maxTotal, 8);
    assert.equal(result.profile, 'standard');
  });

  test('budget profile caps 4-slot week at 6 recipes', () => {
    const slots = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    const result = T.computeWeekCoreLibraryTargets(slots, { budgetProfile: 'Budget' });
    assert.equal(result.total, 6);
    assert.equal(result.maxTotal, 6);
    assert.equal(result.profile, 'budget');
  });

  test('budget profile keeps 2-slot week at 4 recipes', () => {
    const slots = ['Lunch', 'Dinner'];
    const result = T.computeWeekCoreLibraryTargets(slots, { budgetProfile: 'Budget' });
    assert.equal(result.total, 4);
    assert.ok(result.total <= result.maxTotal);
  });

  test('standard profile grows 2-slot week toward 6 recipes', () => {
    const slots = ['Lunch', 'Dinner'];
    const result = T.computeWeekCoreLibraryTargets(slots, { budgetProfile: 'Flexible' });
    assert.equal(result.total, 6);
    assert.equal(result.perCat.Lunch, 3);
    assert.equal(result.perCat.Dinner, 3);
  });

  test('variety mode allows totals above 8', () => {
    const slots = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    const result = T.computeWeekCoreLibraryTargets(slots, {
      budgetProfile: 'Moderate',
      varietyMode: true
    });
    assert.equal(result.total, 8);
    assert.equal(result.maxTotal, 12);
    assert.equal(result.varietyMode, true);
  });

  test('never exceeds 8 without variety mode', () => {
    const slots = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
    ['Budget', 'Moderate', 'Flexible'].forEach(function (budget) {
      const result = T.computeWeekCoreLibraryTargets(slots, { budgetProfile: budget });
      assert.ok(result.total <= 8, budget + ' total ' + result.total);
    });
  });
});
