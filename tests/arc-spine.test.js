/**
 * Arc V2.1 spine behavior tests — recovery, reflection, coach, display mode.
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

function loadRecoverySpine(extraUp = {}) {
  const wk = '2026-06-02';
  const sandbox = {
    console,
    DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    UP: {
      recovery: { weekKey: wk, tier: 0, goalReviewSuggested: false, updatedAt: null },
      foodReports: [],
      chaosRecovery: { version: 1, learning: { signalCounts: {}, actionCounts: {} }, days: {} },
      ...extraUp
    },
    ensureChaosRecovery(p) {
      p = p || sandbox.UP;
      if (!p.chaosRecovery) {
        p.chaosRecovery = { version: 1, learning: { signalCounts: {}, actionCounts: {} }, days: {} };
      }
    }
  };
  const ctx = vm.createContext(sandbox);
  const chunks = [
    sliceIndexLines(6756, 6772),
    sliceIndexLines(9484, 9626)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

function loadReflectionSpine(extraUp = {}) {
  const sandbox = {
    console,
    UP: {
      goal: 'Lose weight',
      budget: 'Moderate',
      recovery: { tier: 2 },
      arcAdaptive: { favoriteMealNames: [] },
      ...extraUp
    },
    computeWeeklyReviewMetrics() {
      return {
        weekKey: '2026-06-02',
        breakfastSkips: 4,
        proteinShortDays: 5,
        mealsReplaced: 0,
        likedRecipeNames: ['Salmon Bowl']
      };
    },
    buildWeeklyInsightStrings() {
      return ['You logged most dinners', 'Breakfast stayed open on several mornings'];
    },
    buildRecapLearnedLines() {
      return ['Mornings are your friction point'];
    },
    buildAdaptiveAdjustmentStrings() {
      return [{ title: 'Easier breakfasts', body: 'Keep first meal light and optional.' }];
    },
    syncRecoveryForCurrentWeek() {},
    applySafeProfileDefaults(p) { return p || sandbox.UP; },
    normalizeBudgetValue(v) { return v || ''; },
    ensureArcAdaptive(p) {
      if (!p.arcAdaptive) p.arcAdaptive = { favoriteMealNames: [] };
    }
  };
  const ctx = vm.createContext(sandbox);
  const chunks = [
    sliceIndexLines(7393, 7497)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

function loadCoachSpine(extraUp = {}) {
  const sandbox = {
    console,
    DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    UP: {
      displayMode: 'simple',
      recovery: { tier: 0 },
      coach: { dismissedDay: null, dismissedType: null },
      foodReports: [],
      ...extraUp
    },
    ARC_COPY: { coach: { reassuranceDefault: 'Arc is here with you.' } },
    CHAOS_SIGNAL_IDS: ['ate_out', 'skipped_meal'],
    applySafeProfileDefaults(p) { return p || sandbox.UP; },
    todayKey() { return 'Mon'; },
    getSlots() { return ['Breakfast', 'Lunch', 'Dinner']; },
    buildChaosRecoveryPlan() {
      return { active: false, signals: [], actions: [], reassurance: '', coachLine: '' };
    },
    ensureRecovery(p) {
      p = p || sandbox.UP;
      if (!Array.isArray(p.foodReports)) p.foodReports = [];
    },
    ensureCoach(p) {
      p = p || sandbox.UP;
      if (!p.coach) p.coach = { dismissedDay: null, dismissedType: null };
    },
    ensureRecovery(p) {
      p = p || sandbox.UP;
      if (!Array.isArray(p.foodReports)) p.foodReports = [];
    }
  };
  const ctx = vm.createContext(sandbox);
  const chunks = [
    sliceIndexLines(9215, 9228),
    sliceIndexLines(9234, 9287),
    sliceIndexLines(9360, 9365),
    sliceIndexLines(9412, 9444)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

function loadDisplaySpine(extraUp = {}) {
  const bodyClasses = new Set();
  const sandbox = {
    console,
    UP: { displayMode: 'simple', ...extraUp },
    document: {
      body: {
        classList: {
          toggle(cls, on) {
            if (on) bodyClasses.add(cls);
            else bodyClasses.delete(cls);
          }
        }
      }
    },
    bodyClasses,
    applySafeProfileDefaults(p) { return p || sandbox.UP; },
    applyProgressHubMode() {},
    renderProgressSimplePanel() {},
    el() { return null; }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(sliceIndexLines(9360, 9375), ctx);
  return sandbox;
}

describe('recalculateRecoveryTier', () => {
  test('returns 0 for an empty week', () => {
    const sb = loadRecoverySpine();
    assert.equal(sb.recalculateRecoveryTier('2026-06-02'), 0);
  });

  test('returns 1 when at least one chaos event is present', () => {
    const sb = loadRecoverySpine({
      chaosRecovery: {
        version: 1,
        learning: { signalCounts: {}, actionCounts: {} },
        days: {
          Mon: { events: [{ type: 'ate_out', at: '2026-06-02T18:00:00.000Z' }] }
        }
      }
    });
    assert.equal(sb.recalculateRecoveryTier('2026-06-02'), 1);
  });

  test('returns 2 when load crosses tier-2 threshold', () => {
    const sb = loadRecoverySpine({
      chaosRecovery: {
        version: 1,
        learning: { signalCounts: {}, actionCounts: {} },
        days: {
          Mon: { events: [{ type: 'busy_day', at: '2026-06-02T12:00:00.000Z' }] },
          Tue: { events: [{ type: 'low_energy', at: '2026-06-03T12:00:00.000Z' }] },
          Wed: { events: [{ type: 'skipped_meal', at: '2026-06-04T12:00:00.000Z' }] }
        }
      }
    });
    assert.equal(sb.recalculateRecoveryTier('2026-06-02'), 2);
  });

  test('returns 3 for maintenance load, social saturation, or travel', () => {
    const travel = loadRecoverySpine({
      chaosRecovery: {
        version: 1,
        learning: { signalCounts: {}, actionCounts: {} },
        days: {
          Thu: { events: [{ type: 'travel_day', at: '2026-06-05T08:00:00.000Z' }] }
        }
      }
    });
    assert.equal(travel.recalculateRecoveryTier('2026-06-02'), 3);

    const social = loadRecoverySpine({
      chaosRecovery: {
        version: 1,
        learning: { signalCounts: {}, actionCounts: {} },
        days: {
          Mon: { events: [{ type: 'ate_out', at: '2026-06-02T18:00:00.000Z' }] },
          Tue: { events: [{ type: 'social_event', at: '2026-06-03T18:00:00.000Z' }] },
          Wed: { events: [{ type: 'ate_out', at: '2026-06-04T18:00:00.000Z' }] }
        }
      }
    });
    assert.equal(social.recalculateRecoveryTier('2026-06-02'), 3);
  });

  test('counts heavy food reports toward maintenance tier', () => {
    const reports = [
      { day: 'Mon', at: '2026-06-02T12:00:00', impactClass: 'heavy', confidence: 'C5' },
      { day: 'Tue', at: '2026-06-03T12:00:00', impactClass: 'heavy', confidence: 'C4' },
      { day: 'Wed', at: '2026-06-04T12:00:00', impactClass: 'moderate', confidence: 'C3' }
    ];
    const sb = loadRecoverySpine({ foodReports: reports });
    const wk = sb.plannerWeekKey(new Date(reports[0].at));
    assert.equal(sb.recalculateRecoveryTier(wk), 3);
  });
});

describe('buildWeeklyReflection', () => {
  test('assembles four reflection blocks from week metrics', () => {
    const sb = loadReflectionSpine();
    const mon = new Date(2026, 5, 2);
    const ref = sb.buildWeeklyReflection(mon);
    assert.equal(ref.weekKey, '2026-06-02');
    assert.ok(ref.blocks.happened.length >= 1);
    assert.ok(ref.blocks.learned.length >= 1);
    assert.equal(ref.blocks.changes[0].id, 'easier_breakfasts');
    assert.ok(ref.blocks.staysSame.some((line) => line.includes('goal')));
    assert.equal(ref.weekType, 'adjusted');
  });

  test('marks maintenance week type when recovery tier is 3', () => {
    const sb = loadReflectionSpine({ recovery: { tier: 3 } });
    const ref = sb.buildWeeklyReflection(new Date(2026, 5, 2));
    assert.equal(ref.weekType, 'maintenance');
  });
});

describe('buildCoachResponse', () => {
  test('stays hidden on a normal day with no food report', () => {
    const sb = loadCoachSpine();
    const out = sb.buildCoachResponse({ day: 'Mon' });
    assert.equal(out.visible, false);
    assert.equal(out.source, null);
  });

  test('shows chaos plan when active and not dismissed', () => {
    const sb = loadCoachSpine();
    const out = sb.buildCoachResponse({
      day: 'Mon',
      chaosPlan: {
        active: true,
        signals: ['ate_out'],
        reassurance: 'One meal out is normal.',
        coachLine: 'Keep dinner simple tonight.',
        actions: [{ label: 'Swap dinner', type: 'swap' }]
      }
    });
    assert.equal(out.visible, true);
    assert.equal(out.source, 'event');
    assert.equal(out.headline, 'Keep dinner simple tonight.');
  });

  test('respects dismissal unless maintenance tier forces visibility', () => {
    const sb = loadCoachSpine({
      coach: { dismissedDay: 'Mon', dismissedType: 'ate_out' }
    });
    const hidden = sb.buildCoachResponse({
      day: 'Mon',
      chaosPlan: {
        active: true,
        signals: ['ate_out'],
        reassurance: 'One meal out is normal.',
        coachLine: 'Keep dinner simple tonight.',
        actions: []
      }
    });
    assert.equal(hidden.visible, false);

    sb.UP.recovery.tier = 3;
    const maintenance = sb.buildCoachResponse({
      day: 'Mon',
      chaosPlan: {
        active: true,
        signals: ['ate_out'],
        reassurance: 'One meal out is normal.',
        coachLine: 'Steady week — no chasing.',
        actions: []
      }
    });
    assert.equal(maintenance.visible, true);
    assert.equal(maintenance.maintenance, true);
    assert.equal(maintenance.source, 'maintenance');
  });

  test('shows food report reply in simple mode without advanced copy', () => {
    const sb = loadCoachSpine({
      foodReports: [{
        day: 'Mon',
        at: '2026-06-02T12:00:00.000Z',
        replySimple: 'Sounds like a balanced lunch.',
        replyAdvanced: '~520 kcal estimate — protein on track.'
      }]
    });
    const out = sb.buildCoachResponse({ day: 'Mon' });
    assert.equal(out.visible, true);
    assert.equal(out.source, 'food_report');
    assert.equal(out.headline, 'Sounds like a balanced lunch.');
  });
});

describe('display mode', () => {
  test('defaults to simple unless explicitly advanced', () => {
    const sb = loadDisplaySpine();
    assert.equal(sb.isAdvancedMode(), false);
    sb.UP.displayMode = 'advanced';
    assert.equal(sb.isAdvancedMode(), true);
  });

  test('syncDisplayModeDom toggles body.arc-advanced from UP.displayMode', () => {
    const sb = loadDisplaySpine({ displayMode: 'advanced' });
    sb.syncDisplayModeDom();
    assert.ok(sb.bodyClasses.has('arc-advanced'));

    sb.UP.displayMode = 'simple';
    sb.syncDisplayModeDom();
    assert.ok(!sb.bodyClasses.has('arc-advanced'));
  });
});
