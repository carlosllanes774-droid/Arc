/**
 * Deterministic week meal assignment from AI-generated library.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'index.html');

function sliceIndexLines(start, end) {
  const lines = readFileSync(INDEX_HTML, 'utf8').split('\n');
  return lines.slice(start - 1, end).join('\n');
}

function loadSandbox(extraUp = {}) {
  const sandbox = {
    console,
    UP: { meals: '4', arcWeekPlanner: 'scg', ...extraUp },
    DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    SLOT_SETS: {
      '3': ['Breakfast', 'Lunch', 'Dinner'],
      '4': ['Breakfast', 'Lunch', 'Afternoon snack', 'Dinner']
    },
    BW_STYLE_META: {
      balanced: { repeats: 2 },
      fresh: { repeats: 1 },
      prep: { repeats: 4 }
    },
    mealJournal: {},
    getSlots() {
      return this.SLOT_SETS[String(this.UP.meals || '3')] || this.SLOT_SETS['3'];
    }
  };
  const ctx = vm.createContext(sandbox);
  const chunks = [
    sliceIndexLines(3141, 3580)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

const library = [
  { id: 1, name: 'Mexican Scramble', cat: 'Breakfast' },
  { id: 2, name: 'Chicken Burrito Bowl', cat: 'Lunch' },
  { id: 3, name: 'Teriyaki Salmon with Quinoa', cat: 'Dinner' },
  { id: 4, name: 'Peanut Butter Banana Smoothie', cat: 'Snack' }
];

describe('deterministic week meal assignment', () => {
  test('assigns first recipe per category on Monday (4-meal day)', () => {
    const sandbox = loadSandbox();
    const slots = ['Breakfast', 'Lunch', 'Afternoon snack', 'Dinner'];
    const out = sandbox.buildDeterministicWeekMealPlan(library, slots);
    assert.ok(out);
    assert.equal(out.recipes.length, 4);
    assert.equal(out.plan.Mon.Breakfast, 1);
    assert.equal(out.plan.Mon.Lunch, 2);
    assert.equal(out.plan.Mon['Afternoon snack'], 4);
    assert.equal(out.plan.Mon.Dinner, 3);
  });

  test('SCG varies breakfast across days when multiple recipes exist', () => {
    const sandbox = loadSandbox();
    const lib = library.concat([
      { id: 5, name: 'Greek Yogurt Bowl', cat: 'Breakfast', ing: ['Yogurt', 'Berries'], servings: 4 }
    ]);
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const out = sandbox.buildDeterministicWeekMealPlan(lib, slots, { style: 'balanced', focus: 'balanced' });
    const breakfastIds = new Set(
      sandbox.DAYS.map((day) => out.plan[day].Breakfast)
    );
    assert.ok(breakfastIds.size >= 2, 'SCG should use more than one breakfast across the week');
  });

  test('fills all seven days with library recipe ids only', () => {
    const sandbox = loadSandbox();
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const out = sandbox.buildDeterministicWeekMealPlan(library, slots);
    const allowedIds = new Set(library.map((r) => r.id));
    for (const day of sandbox.DAYS) {
      assert.ok(out.plan[day]);
      for (const slot of slots) {
        assert.ok(allowedIds.has(out.plan[day][slot]), `${day} ${slot} must be a library id`);
      }
    }
  });

  test('defaults to SCG planner when UP.arcWeekPlanner unset', () => {
    const sandbox = loadSandbox({ arcWeekPlanner: undefined });
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const out = sandbox.buildDeterministicWeekMealPlan(library, slots);
    assert.equal(sandbox.resolveArcWeekPlannerMode(), 'scg');
    assert.ok(out.plan.Mon.Breakfast);
  });

  test('legacy planner only when UP.arcWeekPlanner is legacy', () => {
    const sandbox = loadSandbox({ arcWeekPlanner: 'legacy' });
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const lib = library.concat([
      { id: 5, name: 'Greek Yogurt Bowl', cat: 'Breakfast' }
    ]);
    const out = sandbox.buildDeterministicWeekMealPlan(lib, slots);
    assert.equal(sandbox.resolveArcWeekPlannerMode(), 'legacy');
    assert.equal(out.plan.Mon.Breakfast, 1);
    assert.equal(out.plan.Tue.Breakfast, 5);
    assert.equal(out.plan.Wed.Breakfast, 1);
  });

  test('SCG planner returns same output shape and valid library ids', () => {
    const sandbox = loadSandbox({ arcWeekPlanner: 'scg' });
    const lib = [
      { id: 1, name: 'Mexican Scramble', cat: 'Breakfast', ing: ['Eggs', 'Spinach'], servings: 4 },
      { id: 2, name: 'Greek Yogurt Bowl', cat: 'Breakfast', ing: ['Yogurt', 'Berries'], servings: 3 },
      { id: 3, name: 'Chicken Burrito Bowl', cat: 'Lunch', ing: ['Chicken', 'Rice', 'Beans'], servings: 4 },
      { id: 4, name: 'Turkey Wrap', cat: 'Lunch', ing: ['Turkey', 'Tortilla'], servings: 3 },
      { id: 5, name: 'Teriyaki Salmon', cat: 'Dinner', ing: ['Salmon', 'Rice', 'Broccoli'], servings: 4 },
      { id: 6, name: 'Beef Stir-Fry', cat: 'Dinner', ing: ['Beef', 'Broccoli', 'Rice'], servings: 3 }
    ];
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const out = sandbox.buildDeterministicWeekMealPlan(lib, slots, { style: 'balanced' });
    assert.ok(out);
    assert.ok(Array.isArray(out.recipes));
    assert.ok(out.plan);
    assert.equal(Object.keys(out).sort().join(','), 'plan,recipes');
    const allowedIds = new Set(lib.map((r) => r.id));
    for (const day of sandbox.DAYS) {
      for (const slot of slots) {
        assert.ok(allowedIds.has(out.plan[day][slot]), `${day} ${slot}`);
      }
    }
  });

  test('bestResults and noTime vibes use SCG with vibe style/focus', () => {
    const sandbox = loadSandbox();
    const lib = [
      { id: 1, name: 'Eggs', cat: 'Breakfast', ing: ['Eggs'], servings: 4 },
      { id: 2, name: 'Salad', cat: 'Lunch', ing: ['Greens'], servings: 4 },
      { id: 3, name: 'Steak', cat: 'Dinner', ing: ['Beef'], servings: 4 }
    ];
    const slots = ['Breakfast', 'Lunch', 'Dinner'];
    const best = sandbox.buildScgWeekMealPlan(lib, slots, {
      weekVibe: 'bestResults',
      style: 'balanced',
      focus: 'highProtein'
    });
    const quick = sandbox.buildScgWeekMealPlan(lib, slots, {
      weekVibe: 'noTime',
      style: 'balanced',
      focus: 'quick'
    });
    const variety = sandbox.buildScgWeekMealPlan(lib, slots, {
      weekVibe: 'variety',
      style: 'fresh',
      focus: 'balanced'
    });
    assert.equal(best._scgTrace.focus, 'highProtein');
    assert.equal(best._scgTrace.style, 'balanced');
    assert.equal(quick._scgTrace.focus, 'quick');
    assert.equal(variety._scgTrace.style, 'fresh');
    assert.equal(variety._scgTrace.blockLen, 1);
    assert.ok(Array.isArray(best._scgTrace.assignmentTelemetry));
    assert.equal(best._scgTrace.assignmentTelemetry.length, 21);
  });

  test('groups recipes by normalized category', () => {
    const sandbox = loadSandbox();
    const grouped = sandbox.groupLibraryRecipesByCategory([
      { id: 1, name: 'A', cat: 'breakfast' },
      { id: 2, name: 'B', cat: 'Lunch' },
      { id: 3, name: 'C', cat: 'DINNER' },
      { id: 4, name: 'D', cat: 'Morning Snack' }
    ]);
    assert.equal(grouped.Breakfast.length, 1);
    assert.equal(grouped.Lunch.length, 1);
    assert.equal(grouped.Dinner.length, 1);
    assert.equal(grouped.Snack.length, 1);
  });
});
