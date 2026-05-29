/**
 * Isolated frontend week-render diagnostic (no production changes).
 * Loads real Index1.html parsing/render helpers in a VM + minimal DOM mock,
 * then simulates applyWeek with static canonical payloads.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INDEX_HTML = path.join(ROOT, 'Index1.html');
const CONTRACT_JS = path.join(ROOT, 'js', 'arc-frontend-contract.js');
const FIXTURE_LOOSE = path.join(__dirname, 'fixtures', 'canonical-week-loose.json');
const FIXTURE_CONTRACT = path.join(__dirname, 'fixtures', 'canonical-week-frontend-contract.json');

function sliceIndexLines(start, end) {
  const lines = readFileSync(INDEX_HTML, 'utf8').split('\n');
  return lines.slice(start - 1, end).join('\n');
}

function createDomMock() {
  const nodes = Object.create(null);
  function ensure(id) {
    if (!nodes[id]) {
      nodes[id] = {
        id,
        innerHTML: '',
        textContent: '',
        style: { display: '' },
        classList: { toggle() {} },
        setAttribute() {},
        addEventListener() {},
        querySelectorAll() {
          return [];
        }
      };
    }
    return nodes[id];
  }
  const document = {
    getElementById(id) {
      return ensure(id);
    },
    querySelectorAll() {
      return [];
    }
  };
  [
    'recipes-list',
    'planner-list',
    'planner-next-bar',
    'pnb-sub',
    'plan-empty',
    'builtfor-card',
    'planner-list-lbl',
    'planner-adapt-card',
    'builtfor-pills',
    'cat-tabs'
  ].forEach(ensure);
  return { document, nodes, ensure };
}

function loadArcFrontendContractInto(sandbox) {
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(CONTRACT_JS, 'utf8'), ctx, { filename: 'arc-frontend-contract.js' });
}

function loadFrontendWeekSandbox() {
  const dom = createDomMock();
  const sandbox = {
    console,
    document: dom.document,
    useCustom: false,
    libView: 'this-week',
    activeCat: 'All',
    recipes: [],
    mealPlan: {},
    mealJournal: {},
    UP: {
      meals: 3,
      region: 'us-midwest',
      tdee: 2000,
      macros: { protein: 150, carbs: 200, fat: 65 },
      mealFeedback: {},
      weeklyPlan: null,
      servingOverrides: {}
    },
    ARC_COPY: {
      empty: { libWeek: 'No week planned yet.', libSaved: 'None saved.', libCat: 'None.' },
      planner: {
        badgeUnder: 'Lighter',
        badgeOver: 'Fuller',
        badgeOk: 'In range',
        notPlanned: 'Not planned',
        addMeal: 'Add meal'
      }
    },
    DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    SLOT_SETS: { '3': ['Breakfast', 'Lunch', 'Dinner'] },
    getSlots() {
      return this.SLOT_SETS[String(this.UP.meals || 3)] || this.SLOT_SETS['3'];
    },
    getCalTarget() {
      return 2000;
    },
    renderBuiltForHeader() {},
    renderToday() {},
    saveSessionState() {},
    openAssign() {},
    setSlotJournal() {},
    recordRecipeSavedEngagement() {},
    saveUserProfile() {}
  };

  const chunks = [
    sliceIndexLines(2761, 3064),
    sliceIndexLines(6750, 6809)
  ];

  loadArcFrontendContractInto(sandbox);
  const context = vm.createContext(sandbox);
  for (const src of chunks) {
    vm.runInContext(src, context);
  }
  sandbox.renderBuiltForHeader = function () {};
  sandbox.updatePlannerBar = function () {};
  sandbox.renderToday = function () {};
  sandbox.renderNutrition = function () {};
  sandbox.openAssign = function () {};
  sandbox.setSlotJournal = function () {};
  sandbox.openRM = function () {};
  sandbox.renderLibrary = function () {
    const listEl = sandbox.document.getElementById('recipes-list');
    const rows = (sandbox.recipes || []).map((r) => r.name + ' · ' + r.cal + ' kcal').join('<br>');
    listEl.innerHTML = rows || '<div class="lib-empty">empty</div>';
  };
  sandbox.renderPlanner = function () {
    const listEl = sandbox.document.getElementById('planner-list');
    const slots = sandbox.getSlots();
    let html = '';
    for (let d = 0; d < sandbox.DAYS.length; d++) {
      const day = sandbox.DAYS[d];
      for (let s = 0; s < slots.length; s++) {
        const rid = sandbox.mealPlan[day] && sandbox.mealPlan[day][slots[s]];
        const r = rid ? sandbox.recipes.find((x) => x.id === rid) : null;
        if (r) html += r.name + ' ';
      }
    }
    listEl.innerHTML = html;
  };
  return sandbox;
}

function buildMealTargets(slots, calT) {
  const n = Math.max(1, slots.length);
  const per = { cal: calT / n, p: 150 / n, c: 200 / n, f: 65 / n };
  return {
    n,
    slots: slots.slice(),
    perSlot: per,
    Breakfast: per,
    Lunch: per,
    Dinner: per,
    Snack: per
  };
}

/**
 * Mirrors generateWeeklyPlan → applyWeek core path (no AI / enhancement).
 */
function simulateApplyWeek(sandbox, rawPayload, opts) {
  opts = opts || {};
  const slots = sandbox.getSlots();
  const built = {
    slots,
    mt: opts.mt || buildMealTargets(slots, sandbox.getCalTarget())
  };

  if (opts.meta && opts.meta.source === 'enhancement') {
    return { ok: false, stage: 'source_guard', reason: 'enhancement_payload_rejected' };
  }

  const parsedIn = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
  const normalized = sandbox.normalizeWeekPayloadContract(parsedIn, built.slots);
  if (!normalized) {
    return { ok: false, stage: 'normalizeWeekPayloadContract', reason: 'no_recipes_or_unreadable_shape' };
  }

  const parsed = { recipes: normalized.recipes, plan: normalized.plan };
  const validRecipes = Array.isArray(parsed.recipes) && parsed.recipes.length;
  const validPlan = parsed.plan && typeof parsed.plan === 'object';
  if (!validRecipes || !validPlan) {
    return { ok: false, stage: 'applyWeek_validation', reason: 'missing_recipes_or_plan' };
  }

  let recipes = sandbox
    .validateRecipesForRender(parsed.recipes)
    .map((r, i) => sandbox.normalizeGeneratedRecipe(r, i, built.mt));
  recipes = sandbox.validateRecipesForRender(recipes);

  sandbox.recipes = recipes;
  const recById = {};
  for (let ri = 0; ri < recipes.length; ri++) recById[recipes[ri].id] = recipes[ri];

  for (let d = 0; d < sandbox.DAYS.length; d++) sandbox.mealPlan[sandbox.DAYS[d]] = {};
  const assignmentCounts = {};
  for (let dd = 0; dd < sandbox.DAYS.length; dd++) {
    const day = sandbox.DAYS[dd];
    const dayPlan = parsed.plan[day] || {};
    for (let ss = 0; ss < built.slots.length; ss++) {
      const slot = built.slots[ss];
      const rid = parseInt(dayPlan[slot], 10);
      if (rid && recById[rid]) {
        sandbox.mealPlan[day][slot] = rid;
        assignmentCounts[rid] = (assignmentCounts[rid] || 0) + 1;
      }
    }
  }

  sandbox.UP.weeklyPlan = {
    builtAt: Date.now(),
    style: 'balanced',
    focus: 'balanced',
    repeatMap: assignmentCounts
  };

  sandbox.libView = 'this-week';
  sandbox.renderLibrary();
  sandbox.renderPlanner();

  const libraryHtml = sandbox.document.getElementById('recipes-list').innerHTML;
  const plannerHtml = sandbox.document.getElementById('planner-list').innerHTML;

  return {
    ok: true,
    recipes,
    normalized,
    libraryHtml,
    plannerHtml,
    fallbackApplied: normalized.fallbackApplied
  };
}

describe('Frontend week render — isolated diagnostic', () => {
  const sandbox = loadFrontendWeekSandbox();
  const contractPayload = JSON.parse(readFileSync(FIXTURE_CONTRACT, 'utf8'));
  const loosePayload = JSON.parse(readFileSync(FIXTURE_LOOSE, 'utf8'));

  test('frontend contract payload normalizes and renders recipe + planner', () => {
    const out = simulateApplyWeek(sandbox, contractPayload);
    assert.equal(out.ok, true, 'expected successful applyWeek simulation');
    assert.equal(out.recipes.length, 1);
    assert.equal(out.recipes[0].name, 'Test Chicken Bowl');
    assert.equal(out.recipes[0].cal, 650);
    assert.ok(out.libraryHtml.includes('Test Chicken Bowl'), 'library should show recipe name');
    assert.ok(out.libraryHtml.includes('650 kcal'), 'library should show calories');
    assert.ok(out.plannerHtml.includes('Test Chicken Bowl'), 'planner should assign recipe to slots');
    assert.ok(!out.libraryHtml.includes('lib-empty'), 'should not show empty-library state');
  });

  test('loose verbose keys map to canonical contract via adapter', () => {
    const out = simulateApplyWeek(sandbox, loosePayload);
    assert.equal(out.ok, true);
    assert.equal(out.recipes[0].name, 'Test Chicken Bowl');
    assert.equal(out.recipes[0].cal, 650, 'calories → cal via arc-frontend-contract');
    assert.equal(out.recipes[0].p, 45, 'protein → p via arc-frontend-contract');
    assert.ok(out.libraryHtml.includes('650 kcal'), 'library shows mapped macros');
    assert.ok(out.fallbackApplied, 'missing plan triggers slot fallback');
  });

  test('enhancement source guard matches production applyWeek behavior', () => {
    const out = simulateApplyWeek(sandbox, contractPayload, { meta: { source: 'enhancement' } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'enhancement_payload_rejected');
  });

  test('empty recipes object fails before render (pipeline gate)', () => {
    const out = simulateApplyWeek(sandbox, { recipes: [], plan: {} });
    assert.equal(out.ok, false);
    assert.equal(out.stage, 'normalizeWeekPayloadContract');
  });
});
