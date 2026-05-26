/**
 * Arc client runtime — config bootstrap, profile mapping, nutrition delegates, cloud merge.
 */
(function (global) {
  'use strict';

  var bootstrapPromise = null;

  function apiBaseUrl() {
    if (global.ArcApiBase && global.ArcApiBase.apiBaseUrl) return global.ArcApiBase.apiBaseUrl();
    if (typeof location !== 'undefined' && location.origin) return String(location.origin).replace(/\/$/, '');
    var cfg = global.ARC_API || {};
    return String(cfg.baseUrl || '').trim().replace(/\/$/, '');
  }

  function apiUrl(path) {
    if (global.ArcApiBase && global.ArcApiBase.apiUrl) return global.ArcApiBase.apiUrl(path);
    return apiBaseUrl() + path;
  }

  /**
   * Map onboarding profile (UP) to Arc Engine input.
   * @param {object} p
   * @returns {object}
   */
  function profileToEngineInput(p) {
    p = p || {};
    var weight = parseFloat(p.weight);
    if (!isFinite(weight) || weight <= 0) weight = 170;

    var heightIn = parseFloat(p.heightInches);
    if (!isFinite(heightIn) || heightIn <= 0) heightIn = 68;

    var age = parseInt(p.age, 10);
    if (!isFinite(age) || age < 14) age = 30;

    var sex = p.sex != null ? String(p.sex).trim().toLowerCase() : 'male';
    var gender = (sex === 'female' || sex === 'woman') ? 'female' : 'male';
    if (sex.indexOf('prefer') !== -1 || sex === 'other') gender = 'male';

    var activity = p.activity != null ? String(p.activity).trim() : 'Moderate';
    var muscleEm = p.muscleGainEmphasis;
    var muscleEmphasis = muscleEm === 'Strength' || muscleEm === 'Size' || muscleEm === 'Athletic performance';

    var pace = Number(p.weightGoalPaceLbWeek);
    if (!isFinite(pace) || pace <= 0) pace = 0.5;

    return {
      goal: p.goal || 'Eat healthier',
      goalPace: pace,
      weight: weight,
      height: heightIn,
      heightUnit: 'in',
      weightUnit: 'lb',
      age: age,
      gender: gender,
      activityLevel: activity,
      muscleEmphasis: muscleEmphasis
    };
  }

  /**
   * @param {object} targets from ArcEngine.generateNutritionTargets
   * @returns {{ protein: number, carbs: number, fat: number }}
   */
  function targetsToUiMacros(targets) {
    targets = targets || {};
    return {
      protein: Math.round(Number(targets.proteinTarget) || 0),
      carbs: Math.round(Number(targets.carbTarget) || 0),
      fat: Math.round(Number(targets.fatTarget) || 0)
    };
  }

  /**
   * @param {object} p profile (UP)
   * @param {number} [calorieOverride]
   * @returns {object}
   */
  function generateNutritionTargets(p, calorieOverride) {
    if (!global.ArcEngine || typeof global.ArcEngine.generateNutritionTargets !== 'function') {
      throw new Error('[Arc] Arc Engine not loaded');
    }
    var input = profileToEngineInput(p);
    var targets = global.ArcEngine.generateNutritionTargets(input);

    if (calorieOverride != null && isFinite(Number(calorieOverride)) && Number(calorieOverride) > 0) {
      var nut = global.ArcEngine.Nutrition;
      var goalKey = global.ArcEngine.Goal.normalizeGoal(input.goal);
      var macros = nut.buildMacroTargets({
        weight: input.weight,
        weightUnit: 'lb',
        height: input.height,
        heightUnit: input.heightUnit,
        age: input.age,
        gender: input.gender,
        activityLevel: input.activityLevel,
        goal: goalKey,
        targetCalories: Math.round(Number(calorieOverride)),
        goalPace: input.goalPace,
        muscleEmphasis: input.muscleEmphasis
      });
      targets = Object.assign({}, targets, {
        targetCalories: macros.targetCalories,
        proteinTarget: macros.protein,
        fatTarget: macros.fat,
        carbTarget: macros.carbs
      });
    }

    return targets;
  }

  function formatPaceLbWeekForCopy(paceLbWeek) {
    var n = Number(paceLbWeek);
    if (!isFinite(n) || n <= 0) n = 0.5;
    n = Math.min(1, Math.max(0.25, n));
    if (n === 1) return '1 lb/week';
    if (n === 0.75) return '0.75 lb/week';
    if (n === 0.5) return '0.5 lb/week';
    if (n === 0.25) return '0.25 lb/week';
    return (Math.round(n * 100) / 100) + ' lb/week';
  }

  function computePhysiologyMetrics(profile) {
    var nut = global.ArcEngine && global.ArcEngine.Nutrition;
    if (!nut) return { bmr: 0, maintenance: 2000, weightKg: 77, heightCm: 170, age: 30, sex: 'male', activityFactor: 1.55 };
    var input = profileToEngineInput(profile);
    var phys = nut.calculateMaintenanceCalories(input);
    return {
      bmr: phys.bmr,
      maintenance: phys.maintenanceCalories,
      weightKg: phys.weightLb * 0.453592,
      heightCm: phys.heightCm,
      age: phys.age,
      sex: input.gender === 'female' ? 'female' : 'male',
      activityFactor: phys.activityFactor
    };
  }

  function computeMaintenanceCalories(profile) {
    return computePhysiologyMetrics(profile).maintenance;
  }

  function computeCalorieRecommendation(maintenance, goalRaw, paceLbWeek, opts) {
    opts = opts || {};
    var draftProfile = {
      goal: goalRaw,
      weightGoalPaceLbWeek: paceLbWeek,
      muscleGainEmphasis: opts.muscleEmphasis,
      weight: (typeof UP !== 'undefined' && UP) ? UP.weight : 170,
      heightInches: (typeof UP !== 'undefined' && UP) ? UP.heightInches : 68,
      age: (typeof UP !== 'undefined' && UP) ? UP.age : 30,
      sex: (typeof UP !== 'undefined' && UP) ? UP.sex : 'Male',
      activity: (typeof UP !== 'undefined' && UP) ? UP.activity : 'Moderate'
    };
    var targets = generateNutritionTargets(draftProfile);
    var m = targets.maintenanceCalories;
    var target = targets.targetCalories;
    var paceFromWeek = global.ArcEngine.Goal.paceToDailyDelta(paceLbWeek);
    var paceLabel = formatPaceLbWeekForCopy(paceLbWeek);
    var adjustmentSummary = target === m
      ? 'No calorie shift for this goal'
      : (target > m ? '+' : '−') + Math.abs(target - m) + ' kcal/day for ~' + paceLabel;

    return {
      maintenance: m,
      target: target,
      rawTarget: target,
      appliedDelta: target - m,
      paceKcalPerDay: paceFromWeek,
      goal: goalRaw,
      adjustmentSummary: adjustmentSummary,
      muscleFloorKcal: null,
      clampNote: ''
    };
  }

  function computeRecommendedCalories(maintenance, goalRaw, paceLbWeek, opts) {
    return computeCalorieRecommendation(maintenance, goalRaw, paceLbWeek, opts).target;
  }

  function calcTDEEForProfile(p) {
    return generateNutritionTargets(p).targetCalories;
  }

  function getMacroTargetsForProfile(p, cals) {
    var calT = Number(cals);
    if (!isFinite(calT) || calT <= 0) {
      calT = generateNutritionTargets(p).targetCalories;
    }
    return targetsToUiMacros(generateNutritionTargets(p, calT));
  }

  function bundleTimestamp(bundle) {
    if (!bundle || typeof bundle !== 'object') return 0;
    var t = bundle.updatedAt || bundle.updated_at;
    if (t) return Date.parse(t) || 0;
    var prof = bundle.profile;
    if (prof && prof.arcUpdatedAt) return Date.parse(prof.arcUpdatedAt) || 0;
    return 0;
  }

  /**
   * Newest state wins (cloud vs local).
   * @param {object|null} localBundle
   * @param {object|null} cloudRow
   * @returns {{ bundle: object, source: string }}
   */
  function mergeProfileState(localBundle, cloudRow) {
    var cloudBundle = null;
    var cloudTs = 0;
    if (cloudRow && cloudRow.profile) {
      cloudBundle = {
        profile: cloudRow.profile,
        app: cloudRow.app_state || {},
        updatedAt: cloudRow.updated_at
      };
      cloudTs = bundleTimestamp(cloudBundle);
    }

    var localTs = bundleTimestamp(localBundle);
    if (cloudBundle && cloudTs >= localTs) {
      return { bundle: cloudBundle, source: 'cloud' };
    }
    if (localBundle && localTs > 0) {
      return { bundle: localBundle, source: 'local' };
    }
    if (cloudBundle) return { bundle: cloudBundle, source: 'cloud' };
    return { bundle: localBundle, source: 'local' };
  }

  function stampBundle(bundle) {
    bundle = bundle || {};
    var iso = new Date().toISOString();
    bundle.updatedAt = iso;
    if (bundle.profile && typeof bundle.profile === 'object') {
      bundle.profile.arcUpdatedAt = iso;
    }
    return bundle;
  }

  function applySupabasePublicConfig(cfg) {
    cfg = cfg || {};
    var sb = cfg.supabase || {};
    var url = String(sb.url || '').trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/$/, '');
    var anonKey = String(sb.anonKey || '').trim();
    if (url && anonKey) {
      global.ARC_SUPABASE = { url: url, anonKey: anonKey };
    } else {
      global.ARC_SUPABASE = { url: '', anonKey: '' };
    }
  }

  function bootstrap() {
    if (bootstrapPromise) return bootstrapPromise;
    var url = apiUrl('/api/config/public');
    bootstrapPromise = fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (resp) {
        return resp.json().then(function (json) {
          return { ok: resp.ok, json: json };
        });
      })
      .then(function (res) {
        var json = res.json || {};
        applySupabasePublicConfig(json);
        return json;
      })
      .catch(function () {
        global.ARC_SUPABASE = global.ARC_SUPABASE || { url: '', anonKey: '' };
        return null;
      });
    return bootstrapPromise;
  }

  var api = {
    bootstrap: bootstrap,
    apiBaseUrl: apiBaseUrl,
    apiUrl: apiUrl,
    profileToEngineInput: profileToEngineInput,
    targetsToUiMacros: targetsToUiMacros,
    generateNutritionTargets: generateNutritionTargets,
    formatPaceLbWeekForCopy: formatPaceLbWeekForCopy,
    computePhysiologyMetrics: computePhysiologyMetrics,
    computeMaintenanceCalories: computeMaintenanceCalories,
    computeCalorieRecommendation: computeCalorieRecommendation,
    computeRecommendedCalories: computeRecommendedCalories,
    calcTDEEForProfile: calcTDEEForProfile,
    getMacroTargetsForProfile: getMacroTargetsForProfile,
    mergeProfileState: mergeProfileState,
    stampBundle: stampBundle,
    bundleTimestamp: bundleTimestamp
  };

  global.ArcRuntime = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
