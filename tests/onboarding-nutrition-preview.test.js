/**
 * Onboarding step 4 nutrition preview — single draft profile source of truth.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ENGINE_DIR = path.join(ROOT, 'js', 'arc-engine');
const RUNTIME_JS = path.join(ROOT, 'js', 'arc-runtime.js');

const ENGINE_LOAD_ORDER = [
  'arcNutritionEngine.js',
  'arcGoalEngine.js',
  'arcAthleteEngine.js',
  'arcMealOptimizer.js',
  'arcBudgetEngine.js',
  'arcPortionScaler.js',
  'arcAdherenceEngine.js',
  'arcEngine.js'
];

function loadArcRuntime() {
  const sandbox = {
    console,
    ArcEngine: {},
    ArcRuntime: null,
    UP: {
      weight: '170',
      heightInches: 68,
      age: '30',
      sex: 'Male',
      activity: 'Moderate',
      goal: 'Eat healthier',
      weightGoalPaceLbWeek: 0.5
    }
  };
  const context = vm.createContext(sandbox);
  for (const file of ENGINE_LOAD_ORDER) {
    vm.runInContext(readFileSync(path.join(ENGINE_DIR, file), 'utf8'), context, { filename: file });
  }
  vm.runInContext(readFileSync(RUNTIME_JS, 'utf8'), context, { filename: 'arc-runtime.js' });
  return { ArcRuntime: sandbox.ArcRuntime, UP: sandbox.UP };
}

/** Mirrors nutritionPreviewFromDraft profile shape in index.html */
function draftToProfile(draft) {
  return {
    weight: draft.weight,
    age: String(draft.age),
    sex: draft.sex,
    activity: draft.activity,
    goal: draft.goal,
    weightGoalPaceLbWeek: draft.weightGoalPaceLbWeek,
    muscleGainEmphasis: draft.muscleGainEmphasis,
    heightInches: draft.heightInches,
    height: draft.height
  };
}

function previewFromDraft(ArcRuntime, draft) {
  var profile = draftToProfile(draft);
  var physio = ArcRuntime.computePhysiologyMetrics(profile);
  var calorieRec = ArcRuntime.computeCalorieRecommendation(physio.maintenance, profile.goal, profile.weightGoalPaceLbWeek, {
    profile: profile,
    muscleEmphasis: profile.muscleGainEmphasis
  });
  var target = calorieRec.target;
  var macros = ArcRuntime.getMacroTargetsForProfile(profile, target);
  return {
    maintenance: calorieRec.maintenance,
    target: target,
    macros: macros,
    physio: physio
  };
}

describe('onboarding nutrition preview', () => {
  const { ArcRuntime, UP } = loadArcRuntime();

  test('draft profile drives maintenance, target, and macros (not stale UP)', () => {
    const draft = {
      weight: 150,
      age: 45,
      sex: 'Female',
      activity: 'Sedentary',
      goal: 'Lose weight',
      weightGoalPaceLbWeek: 0.5,
      muscleGainEmphasis: null,
      heightInches: 65,
      height: "5'5\""
    };
    const profile = draftToProfile(draft);
    const preview = previewFromDraft(ArcRuntime, draft);
    const completion = ArcRuntime.generateNutritionTargets(profile);

    assert.equal(preview.maintenance, completion.maintenanceCalories);
    assert.equal(preview.target, completion.targetCalories);
    assert.equal(preview.target, ArcRuntime.calcTDEEForProfile(profile));
    assert.equal(preview.macros.protein, Math.round(completion.proteinTarget));

    const staleUpTargets = ArcRuntime.generateNutritionTargets(UP);
    assert.notEqual(preview.target, staleUpTargets.targetCalories,
      'preview must not match default UP male 170 lb profile');
    assert.notEqual(preview.maintenance, staleUpTargets.maintenanceCalories);
  });

  test('male athlete gain muscle — preview matches completion TDEE', () => {
    const draft = {
      weight: 185,
      age: 22,
      sex: 'Male',
      activity: 'Athlete',
      goal: 'Gain muscle',
      weightGoalPaceLbWeek: 0.5,
      muscleGainEmphasis: 'Strength',
      heightInches: 72,
      height: "6'0\""
    };
    const profile = draftToProfile(draft);
    const preview = previewFromDraft(ArcRuntime, draft);

    assert.equal(preview.target, ArcRuntime.calcTDEEForProfile(profile));
    assert.ok(preview.macros.protein >= 160);
    assert.ok(preview.maintenance > 2500);
    assert.ok(preview.target >= preview.maintenance);
  });

  test('computeCalorieRecommendation with profile ignores UP age/sex/height', () => {
    UP.age = '30';
    UP.sex = 'Male';
    UP.heightInches = 68;
    UP.weight = '170';

    const profile = {
      weight: 190,
      age: '40',
      sex: 'Female',
      activity: 'Light',
      goal: 'Lose weight',
      weightGoalPaceLbWeek: 0.75,
      heightInches: 69,
      height: "5'9\""
    };

    const withProfile = ArcRuntime.computeCalorieRecommendation(null, profile.goal, profile.weightGoalPaceLbWeek, {
      profile: profile
    });
    const expected = ArcRuntime.generateNutritionTargets(profile);

    assert.equal(withProfile.maintenance, expected.maintenanceCalories);
    assert.equal(withProfile.target, expected.targetCalories);

    const withoutProfile = ArcRuntime.computeCalorieRecommendation(null, profile.goal, profile.weightGoalPaceLbWeek, {});
    assert.notEqual(withoutProfile.target, withProfile.target,
      'without opts.profile, UP defaults must not match draft female profile');
  });
});
