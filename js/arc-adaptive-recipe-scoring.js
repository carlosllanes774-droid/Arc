/**
 * Behavior-aware recipe scoring for week assignment and swaps.
 * Additive layer only — does not modify calorie/macro targets, budget, or overlap cores.
 */
(function (global) {
  'use strict';

  var LOG_PREFIX = '[ARC ADAPTIVE]';

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function recipeMinutes(recipe) {
    var m = String(recipe && recipe.time || '').match(/(\d+)\s*min/i);
    if (m) return parseInt(m[1], 10);
    var n = parseInt(String(recipe && recipe.time || '').replace(/[^0-9]/g, ''), 10);
    return isFinite(n) && n > 0 ? n : 35;
  }

  function ingredientOverlap(recipeA, recipeB, overlapFn) {
    if (!recipeA || !recipeB || !overlapFn) return 0;
    return clamp01(overlapFn(recipeA, recipeB));
  }

  function nameOverlap(candidateName, targetName) {
    var a = String(candidateName || '').toLowerCase();
    var b = String(targetName || '').toLowerCase();
    if (!a || !b) return 0;
    if (a === b) return 1;
    var aw = a.split(/\s+/).filter(Boolean);
    var bw = b.split(/\s+/).filter(Boolean);
    var shared = 0;
    for (var i = 0; i < aw.length; i++) {
      if (aw[i].length < 3) continue;
      for (var j = 0; j < bw.length; j++) {
        if (aw[i] === bw[j]) shared += 1;
      }
    }
    return clamp01(shared / Math.max(2, Math.min(aw.length, bw.length)));
  }

  function findRecipeById(recipes, id) {
    id = parseInt(id, 10);
    if (!isFinite(id)) return null;
    for (var i = 0; i < (recipes || []).length; i++) {
      if (recipes[i] && recipes[i].id === id) return recipes[i];
    }
    return null;
  }

  /**
   * @param {object} profile — UP
   * @param {{ mealJournal?: object, recipes?: object[], overlapFn?: function }} [opts]
   */
  function buildAdaptiveScoringContext(profile, opts) {
    opts = opts || {};
    profile = profile || {};
    var recipes = Array.isArray(opts.recipes) ? opts.recipes : [];
    var overlapFn = opts.overlapFn || null;

    var replacedFrom = {};
    var replacedTo = {};
    var events = (profile.arcBehavior && profile.arcBehavior.events) || [];
    for (var ei = 0; ei < events.length; ei++) {
      var ev = events[ei];
      if (!ev || ev.type !== 'meal_replaced') continue;
      var p = ev.payload || {};
      if (p.plannedRid) {
        var pk = String(p.plannedRid);
        replacedFrom[pk] = (replacedFrom[pk] || 0) + 1;
      }
      if (p.actualRid) {
        var ak = String(p.actualRid);
        replacedTo[ak] = (replacedTo[ak] || 0) + 1;
      }
    }

    var journal = opts.mealJournal || {};
    Object.keys(journal).forEach(function (day) {
      var dayJ = journal[day] || {};
      Object.keys(dayJ).forEach(function (slot) {
        var entry = dayJ[slot];
        if (!entry || entry.status !== 'replaced') return;
        if (entry.actualRid) {
          var rk = String(entry.actualRid);
          replacedTo[rk] = (replacedTo[rk] || 0) + 1;
        }
      });
    });

    var likedIds = {};
    var dislikedIds = {};
    var fb = profile.mealFeedback || {};
    function mealFeedbackSentiment(entry) {
      if (entry == null) return 0;
      if (typeof entry === 'number') return entry === 1 ? 1 : (entry === -1 ? -1 : 0);
      if (typeof entry === 'object' && entry.sentiment != null) {
        var s = Number(entry.sentiment);
        return s === 1 ? 1 : (s === -1 ? -1 : 0);
      }
      return 0;
    }
    Object.keys(fb).forEach(function (rid) {
      var sent = mealFeedbackSentiment(fb[rid]);
      if (sent === 1) likedIds[rid] = true;
      else if (sent === -1) dislikedIds[rid] = true;
    });

    var likedNames = [];
    var ad = profile.arcAdaptive || {};
    if (Array.isArray(ad.favoriteMealNames)) likedNames = ad.favoriteMealNames.slice();
    Object.keys(likedIds).forEach(function (rid) {
      var r = findRecipeById(recipes, rid);
      if (r && r.name && likedNames.indexOf(r.name) < 0) likedNames.push(r.name);
    });

    var scores = (profile.arcBehavior && profile.arcBehavior.scores) || {};
    var fl = ad.foodLogSignals || {};

    return {
      overlapFn: overlapFn,
      recipes: recipes,
      replacedFrom: replacedFrom,
      replacedTo: replacedTo,
      likedIds: likedIds,
      dislikedIds: dislikedIds,
      likedNames: likedNames,
      scores: {
        frequentReplace: clamp01(scores.frequentReplace),
        breakfastSkip: clamp01(scores.breakfastSkip),
        quickPrepPref: clamp01(scores.quickPrepPref),
        costSensitivity: clamp01(scores.costSensitivity),
        groceryAvoidance: clamp01(scores.groceryAvoidance),
        lowAdherence: clamp01(scores.lowAdherence)
      },
      flags: {
        prefersQuickMeals: !!ad.prefersQuickMeals,
        prefersQuickLunches: !!ad.prefersQuickLunches,
        prefersLowerComplexity: !!ad.prefersLowerComplexity,
        skipsBreakfastOften: !!ad.skipsBreakfastOften,
        reduceGroceryVariety: !!ad.reduceGroceryVarietySuggest
      },
      foodLog: {
        quickMealPreference: clamp01(fl.quickMealPreference),
        restaurantFrequency: clamp01(fl.restaurantFrequency),
        breakfastAdherence: fl.breakfastAdherence != null ? clamp01(fl.breakfastAdherence) : null,
        lunchAdherence: fl.lunchAdherence != null ? clamp01(fl.lunchAdherence) : null,
        dinnerAdherence: fl.dinnerAdherence != null ? clamp01(fl.dinnerAdherence) : null,
        proteinFocus: clamp01(fl.proteinFocus),
        conveniencePreference: clamp01(fl.conveniencePreference),
        groceryAvoidance: clamp01(fl.groceryAvoidance)
      }
    };
  }

  function pushBreakdown(breakdown, signal, weight, impact, detail) {
    if (!impact) return;
    breakdown.push({
      signal: signal,
      weight: Math.round(weight * 1000) / 1000,
      impact: Math.round(impact * 1000) / 1000,
      detail: detail || ''
    });
  }

  /**
   * @param {object} recipe
   * @param {object} ctx — from buildAdaptiveScoringContext
   * @param {{ slot?: string, slotCat?: string }} [opts]
   * @returns {{ delta: number, breakdown: object[] }}
   */
  function scoreRecipeAdaptiveBehavior(recipe, ctx, opts) {
    opts = opts || {};
    if (!recipe || !ctx) return { delta: 0, breakdown: [] };

    var breakdown = [];
    var delta = 0;
    var overlapFn = ctx.overlapFn;
    var slotCat = opts.slotCat || '';
    var slotLow = String(opts.slot || '').toLowerCase();
    var isBreakfast = /breakfast/i.test(slotCat) || /breakfast/i.test(slotLow);
    var mins = recipeMinutes(recipe);
    var ingCount = (recipe.ing || []).length;
    var cal = Number(recipe.cal) || 0;

    if (ctx.dislikedIds[String(recipe.id)]) {
      var w = 12;
      var imp = -w;
      delta += imp;
      pushBreakdown(breakdown, 'disliked_recipe', w, imp, 'direct_dislike');
    }

    Object.keys(ctx.replacedFrom).forEach(function (rid) {
      var ref = findRecipeById(ctx.recipes, rid);
      if (!ref || !overlapFn) return;
      var sim = ingredientOverlap(recipe, ref, overlapFn);
      if (sim < 0.28) return;
      var w = 5.5 * (0.35 + ctx.scores.frequentReplace);
      var imp = -w * sim;
      delta += imp;
      pushBreakdown(breakdown, 'swap_away_similarity', w, imp, 'similar_to_replaced_' + rid + '_sim_' + sim.toFixed(2));
    });

    Object.keys(ctx.replacedTo).forEach(function (rid) {
      if (String(recipe.id) === rid) {
        var w2 = 3.5;
        var imp2 = w2;
        delta += imp2;
        pushBreakdown(breakdown, 'swap_chosen_recipe', w2, imp2, 'user_picked_before');
        return;
      }
      var ref2 = findRecipeById(ctx.recipes, rid);
      if (!ref2 || !overlapFn) return;
      var sim2 = ingredientOverlap(recipe, ref2, overlapFn);
      if (sim2 < 0.32) return;
      var w3 = 3 * (0.4 + ctx.scores.frequentReplace * 0.5);
      var imp3 = w3 * sim2;
      delta += imp3;
      pushBreakdown(breakdown, 'swap_toward_similarity', w3, imp3, 'similar_to_chosen_' + rid);
    });

    Object.keys(ctx.likedIds).forEach(function (rid) {
      if (String(recipe.id) === rid) {
        var wL = 8;
        delta += wL;
        pushBreakdown(breakdown, 'liked_recipe', wL, wL, 'direct_like');
        return;
      }
      var likedRef = findRecipeById(ctx.recipes, rid);
      if (!likedRef || !overlapFn) return;
      var simL = ingredientOverlap(recipe, likedRef, overlapFn);
      if (simL < 0.3) return;
      var wLs = 4.5;
      var impL = wLs * simL;
      delta += impL;
      pushBreakdown(breakdown, 'liked_similarity', wLs, impL, 'similar_to_liked_' + rid);
    });

    for (var ni = 0; ni < ctx.likedNames.length; ni++) {
      var nm = nameOverlap(recipe.name, ctx.likedNames[ni]);
      if (nm < 0.34) continue;
      var wN = 2.8;
      var impN = wN * nm;
      delta += impN;
      pushBreakdown(breakdown, 'liked_name_affinity', wN, impN, ctx.likedNames[ni]);
    }

    var quickSignal = Math.max(
      ctx.scores.quickPrepPref,
      ctx.flags.prefersQuickMeals ? 0.55 : 0,
      ctx.foodLog.quickMealPreference,
      ctx.foodLog.conveniencePreference * 0.85
    );
    if (quickSignal >= 0.28) {
      var wQ = 4 * quickSignal;
      var quickScore = Math.max(0, 1 - (mins - 12) / 28);
      if (recipe.difficulty === 'Easy') quickScore = Math.min(1, quickScore + 0.2);
      if (ingCount > 0 && ingCount <= 6) quickScore = Math.min(1, quickScore + 0.12);
      var impQ = wQ * quickScore;
      delta += impQ;
      pushBreakdown(breakdown, 'quick_meal_preference', wQ, impQ, mins + 'min_' + ingCount + 'ing');
    }

    var restaurantSignal = Math.max(
      ctx.foodLog.restaurantFrequency,
      ctx.foodLog.conveniencePreference * 0.7,
      ctx.scores.lowAdherence * 0.35
    );
    if (restaurantSignal >= 0.3) {
      var wR = 3.2 * restaurantSignal;
      var convScore = 0;
      if (mins <= 22) convScore += 0.45;
      if (recipe.difficulty === 'Easy') convScore += 0.25;
      if (ingCount > 0 && ingCount <= 7) convScore += 0.2;
      convScore = Math.min(1, convScore);
      var impR = wR * convScore;
      delta += impR;
      pushBreakdown(breakdown, 'restaurant_convenience', wR, impR, 'convenience_fit');
    }

    var skipBreakfast = Math.max(
      ctx.scores.breakfastSkip,
      ctx.flags.skipsBreakfastOften ? 0.55 : 0,
      ctx.foodLog.breakfastAdherence != null && ctx.foodLog.breakfastAdherence < 0.35
        ? (1 - ctx.foodLog.breakfastAdherence) : 0
    );
    if (isBreakfast && skipBreakfast >= 0.3) {
      var wB = 4.2 * skipBreakfast;
      var light = 0;
      if (cal > 0 && cal <= 420) light += 0.35;
      if (mins <= 18) light += 0.35;
      if (recipe.difficulty === 'Easy') light += 0.2;
      if (ingCount > 0 && ingCount <= 5) light += 0.15;
      light = Math.min(1, light);
      var impB = wB * light;
      delta += impB;
      pushBreakdown(breakdown, 'breakfast_skip_lighter', wB, impB, cal + 'cal_' + mins + 'min');
      if (light < 0.2 && cal > 480) {
        var wBh = 2.5 * skipBreakfast;
        var impBh = -wBh;
        delta += impBh;
        pushBreakdown(breakdown, 'breakfast_skip_heavy_penalty', wBh, impBh, 'heavy_breakfast');
      }
    }

    if (ctx.flags.prefersLowerComplexity || ctx.scores.frequentReplace >= 0.32) {
      var wC = 2.5 * Math.max(ctx.scores.frequentReplace, ctx.flags.prefersLowerComplexity ? 0.45 : 0);
      var simp = 0;
      if (mins <= 25) simp += 0.35;
      if (ingCount > 0 && ingCount <= 7) simp += 0.35;
      if (recipe.difficulty === 'Easy') simp += 0.25;
      var impC = wC * Math.min(1, simp);
      delta += impC;
      pushBreakdown(breakdown, 'lower_complexity', wC, impC, 'simplicity');
    }

    if (ctx.foodLog.proteinFocus >= 0.42 && cal > 0) {
      var wP = 3 * ctx.foodLog.proteinFocus;
      var impP = wP * Math.min(1, (Number(recipe.p) || 0) / Math.max(20, cal / 12));
      delta += impP;
      pushBreakdown(breakdown, 'protein_focus', wP, impP, (recipe.p || 0) + 'g_protein');
    }

    return { delta: delta, breakdown: breakdown };
  }

  function logAdaptiveTelemetry(recipe, meta, result) {
    meta = meta || {};
    result = result || { delta: 0, breakdown: [] };
    if (!result.breakdown.length && !result.delta) return;

    console.log(LOG_PREFIX, {
      planner: meta.planner || 'unknown',
      day: meta.day || null,
      slot: meta.slot || null,
      slotCat: meta.slotCat || null,
      recipeId: recipe && recipe.id,
      recipeName: recipe && recipe.name,
      totalAdaptiveDelta: Math.round(result.delta * 1000) / 1000,
      signals: result.breakdown.map(function (b) {
        return {
          signal: b.signal,
          weight: b.weight,
          impact: b.impact,
          detail: b.detail
        };
      })
    });
  }

  global.ArcAdaptiveRecipeScoring = {
    buildAdaptiveScoringContext: buildAdaptiveScoringContext,
    scoreRecipeAdaptiveBehavior: scoreRecipeAdaptiveBehavior,
    logAdaptiveTelemetry: logAdaptiveTelemetry
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
