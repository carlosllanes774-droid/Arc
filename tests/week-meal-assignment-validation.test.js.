/**
 * Week meal assignment must reference only library recipe names.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'Index1.html');

function sliceIndexLines(start, end) {
  const lines = readFileSync(INDEX_HTML, 'utf8').split('\n');
  return lines.slice(start - 1, end).join('\n');
}

function loadSandbox() {
  const sandbox = {
    console,
    UP: { meals: '3' },
    DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    SLOT_SETS: { '3': ['Breakfast', 'Lunch', 'Dinner'] }
  };
  const ctx = vm.createContext(sandbox);
  const chunks = [
    sliceIndexLines(2761, 2763),
    sliceIndexLines(2801, 2819),
    sliceIndexLines(2922, 3064)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

const library = [
  { id: 1, name: 'Protein-Packed Omelette', cat: 'Breakfast' },
  { id: 2, name: 'Chicken Burrito Bowl', cat: 'Lunch' },
  { id: 3, name: 'Beef Stir-Fry', cat: 'Dinner' },
  { id: 4, name: 'Greek Yogurt Parfait', cat: 'Snack' }
];

describe('week meal assignment library validation', () => {
  test('accepts assignment that uses exact library names', () => {
    const sandbox = loadSandbox();
    const assignment = {
      meal_plan: {
        Mon: {
          Breakfast: 'Protein-Packed Omelette',
          Lunch: 'Chicken Burrito Bowl',
          Dinner: 'Beef Stir-Fry'
        }
      }
    };
    const result = sandbox.validateWeekMealAssignmentAgainstLibrary(library, assignment, ['Breakfast', 'Lunch', 'Dinner']);
    assert.equal(result.ok, true);
    assert.equal(result.unknownRecipes.length, 0);
  });

  test('rejects invented recipe names and lists available library names', () => {
    const sandbox = loadSandbox();
    const logs = [];
    sandbox.console = {
      log(tag, extra) {
        logs.push({ tag, extra });
      }
    };
    const assignment = {
      meal_plan: {
        Mon: {
          Breakfast: 'Protein Pancakes',
          Lunch: 'Chicken Fajita Bowl',
          Dinner: 'Beef Stir-Fry with Vegetables'
        }
      }
    };
    const result = sandbox.validateWeekMealAssignmentAgainstLibrary(library, assignment, ['Breakfast', 'Lunch', 'Dinner']);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unknown_recipes');
    assert.deepEqual(result.availableNames, library.map((r) => r.name));
    assert.ok(result.message.includes('Protein Pancakes'));
    assert.ok(result.message.includes('Chicken Fajita Bowl'));
    assert.ok(result.message.includes('Beef Stir-Fry with Vegetables'));
    assert.ok(result.message.includes('Protein-Packed Omelette'));
    const unknownLogs = logs.filter((l) => l.tag === '[ARC PIPELINE] Assignment references unknown recipe');
    assert.equal(unknownLogs.length, 3);
    assert.deepEqual(unknownLogs[0].extra.availableRecipeNames, library.map((r) => r.name));
  });

  test('buildWeekMealAssignmentPrompt embeds exact allowed names JSON', () => {
    const sandbox = loadSandbox();
    sandbox.buildNutritionEngine = function () {
      return {
        slots: ['Breakfast', 'Lunch', 'Dinner'],
        calT: 2000,
        mealTargets: {},
        macros: {}
      };
    };
    sandbox.appendWeekUserContextBlock = function (u) { return u; };
    const built = sandbox.buildWeekMealAssignmentPrompt({}, library);
    assert.ok(built.userMsg.includes('ALLOWED_RECIPE_NAMES'));
    assert.ok(built.userMsg.includes(JSON.stringify(library.map((r) => r.name))));
    assert.ok(built.sysMsg.includes('ALLOWED_RECIPE_NAMES'));
    assert.ok(built.userMsg.includes('Do NOT output any recipe name outside ALLOWED_RECIPE_NAMES'));
  });
});
