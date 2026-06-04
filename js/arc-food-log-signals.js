/**
 * Food log → durable adaptive signals (arcAdaptive.foodLogSignals).
 * Extraction only — does not modify calories, macros, or logging UX copy.
 */
(function (global) {
  'use strict';

  var LOG_PREFIX = '[ARC FOOD LOG]';
  var SIGNAL_VERSION = 1;
  var EVIDENCE_CAP = 12;
  var CUISINE_LABELS = {
    mediterranean: 'Mediterranean',
    italian: 'Italian',
    asian: 'Asian',
    japanese: 'Japanese',
    mexican: 'Mexican',
    american: 'American',
    indian: 'Indian',
    'middle eastern': 'Middle Eastern'
  };

  var QUICK_TERMS = [
    'quick', 'fast', 'microwave', '5 min', '10 min', '15 min', 'grab and go', 'grab-and-go',
    'on the go', 'rushed', 'hurry', 'no time to cook', 'didnt cook', "didn't cook"
  ];
  var RESTAURANT_TERMS = [
    'restaurant', 'chipotle', 'mcdonald', 'mcdonalds', 'subway', 'starbucks', 'doordash',
    'door dash', 'uber eats', 'ubereats', 'grubhub', 'postmates', 'drive thru', 'drive-thru',
    'dining out', 'ate out', 'takeout', 'take out', 'take-out', 'delivery', 'panda express',
    'panera', 'wendy', 'taco bell', 'chick fil', 'five guys', 'shake shack', 'sweetgreen',
    'cava', 'noodles and company', 'olive garden', 'cheesecake factory'
  ];
  var PROTEIN_TERMS = [
    'protein', 'protein shake', 'protein bar', 'chicken breast', 'grilled chicken', 'steak',
    'salmon', 'tuna', 'turkey', 'greek yogurt', 'cottage cheese', 'whey', 'eggs', 'egg whites',
    'tofu', 'tempeh', 'lentils', 'edamame'
  ];
  var CONVENIENCE_TERMS = [
    'frozen', 'pre-made', 'premade', 'pre made', 'meal prep', 'canned', 'instant', 'ready to eat',
    'packaged', 'leftover', 'left over', 'store bought', 'store-bought', 'rotisserie'
  ];
  var GROCERY_AVOID_TERMS = [
    'no groceries', 'no cooking', 'didnt shop', "didn't shop", 'nothing at home',
    'empty fridge', 'ordered in', 'ordered food', 'delivery only'
  ];
  var SKIP_BREAKFAST = ['skipped breakfast', 'no breakfast', 'missed breakfast', 'skip breakfast'];
  var SKIP_LUNCH = ['skipped lunch', 'no lunch', 'missed lunch', 'skip lunch'];
  var SKIP_DINNER = ['skipped dinner', 'no dinner', 'missed dinner', 'skip dinner'];
  var BREAKFAST_TERMS = ['breakfast', 'morning', 'oatmeal', 'cereal', 'pancake', 'waffle', 'bagel', 'omelette', 'omelet'];
  var LUNCH_TERMS = ['lunch', 'midday', 'noon'];
  var DINNER_TERMS = ['dinner', 'supper', 'evening meal', 'tonight'];
  var CUISINE_TERMS = {
    mexican: ['mexican', 'taco', 'burrito', 'quesadilla', 'chipotle', 'salsa', 'enchilada'],
    italian: ['italian', 'pasta', 'pizza', 'risotto', 'marinara', 'parmesan', 'lasagna'],
    mediterranean: ['mediterranean', 'hummus', 'falafel', 'gyro', 'tzatziki'],
    japanese: ['japanese', 'sushi', 'ramen', 'teriyaki', 'miso'],
    indian: ['indian', 'curry', 'tikka', 'masala', 'naan', 'biryani'],
    asian: ['asian', 'stir fry', 'pho', 'pad thai', 'dumpling'],
    american: ['burger', 'bbq', 'barbecue', 'mac and cheese'],
    'middle eastern': ['shawarma', 'kebab', 'tahini', 'middle eastern']
  };

  var NUMERIC_SIGNAL_KEYS = [
    'quickMealPreference',
    'restaurantFrequency',
    'breakfastAdherence',
    'lunchAdherence',
    'dinnerAdherence',
    'proteinFocus',
    'conveniencePreference',
    'groceryAvoidance'
  ];

  function clamp01(n) {
    n = Number(n);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function normalizeBlob(text) {
    return String(text || '').toLowerCase().replace(/\s+/g, ' ');
  }

  function termHit(blob, terms) {
    for (var i = 0; i < terms.length; i++) {
      if (blob.indexOf(terms[i]) >= 0) return true;
    }
    return false;
  }

  function termStrength(blob, terms) {
    var hits = 0;
    for (var i = 0; i < terms.length; i++) {
      if (blob.indexOf(terms[i]) >= 0) hits += 1;
    }
    if (!hits) return 0;
    return Math.min(1, 0.52 + hits * 0.18);
  }

  function mealSlotSignals(blob) {
    var breakfast = 0;
    var lunch = 0;
    var dinner = 0;

    if (termHit(blob, SKIP_BREAKFAST)) breakfast = -1;
    else if (termHit(blob, BREAKFAST_TERMS)) breakfast = 1;

    if (termHit(blob, SKIP_LUNCH)) lunch = -1;
    else if (termHit(blob, LUNCH_TERMS)) lunch = 1;

    if (termHit(blob, SKIP_DINNER)) dinner = -1;
    else if (termHit(blob, DINNER_TERMS)) dinner = 1;

    return { breakfast: breakfast, lunch: lunch, dinner: dinner };
  }

  function adherenceFromSlot(slotVal) {
    if (slotVal === 1) return 1;
    if (slotVal === -1) return 0;
    return null;
  }

  function detectCuisineHits(blob) {
    var out = {};
    Object.keys(CUISINE_TERMS).forEach(function (slug) {
      if (termHit(blob, CUISINE_TERMS[slug])) out[slug] = termStrength(blob, CUISINE_TERMS[slug]);
    });
    return out;
  }

  function defaultFoodLogSignals() {
    var base = {
      version: SIGNAL_VERSION,
      updatedAt: null,
      sampleCount: 0,
      confidence: 0,
      quickMealPreference: 0,
      restaurantFrequency: 0,
      breakfastAdherence: 0.5,
      lunchAdherence: 0.5,
      dinnerAdherence: 0.5,
      proteinFocus: 0,
      conveniencePreference: 0,
      groceryAvoidance: 0,
      cuisinePreferences: {},
      recentEvidence: []
    };
    return base;
  }

  /**
   * @param {string} text — user food log message (may include clarify merge)
   * @param {{ aiSignals?: object, hour?: number }} [opts]
   * @returns {{ instantaneous: object, confidence: number, evidence: string[], cuisineHits: object }}
   */
  function extractFoodLogSignals(text, opts) {
    opts = opts || {};
    var blob = normalizeBlob(text);
    var evidence = [];
    var inst = {
      quickMealPreference: termStrength(blob, QUICK_TERMS),
      restaurantFrequency: termStrength(blob, RESTAURANT_TERMS),
      proteinFocus: termStrength(blob, PROTEIN_TERMS),
      conveniencePreference: termStrength(blob, CONVENIENCE_TERMS),
      groceryAvoidance: termStrength(blob, GROCERY_AVOID_TERMS),
      breakfastAdherence: null,
      lunchAdherence: null,
      dinnerAdherence: null
    };

    if (inst.quickMealPreference >= 0.5) evidence.push('quick_or_no_cook');
    if (inst.restaurantFrequency >= 0.5) evidence.push('restaurant_or_delivery');
    if (inst.proteinFocus >= 0.5) evidence.push('protein_mention');
    if (inst.conveniencePreference >= 0.5) evidence.push('convenience_food');
    if (inst.groceryAvoidance >= 0.5) evidence.push('grocery_avoidance');

    var slots = mealSlotSignals(blob);
    inst.breakfastAdherence = adherenceFromSlot(slots.breakfast);
    inst.lunchAdherence = adherenceFromSlot(slots.lunch);
    inst.dinnerAdherence = adherenceFromSlot(slots.dinner);

    if (slots.breakfast === 1) evidence.push('breakfast_logged');
    if (slots.breakfast === -1) evidence.push('breakfast_skipped');
    if (slots.lunch === 1) evidence.push('lunch_logged');
    if (slots.lunch === -1) evidence.push('lunch_skipped');
    if (slots.dinner === 1) evidence.push('dinner_logged');
    if (slots.dinner === -1) evidence.push('dinner_skipped');

    var hour = opts.hour;
    if (hour != null && isFinite(hour)) {
      if (inst.breakfastAdherence == null && hour >= 5 && hour < 11) {
        inst.breakfastAdherence = 0.75;
        evidence.push('morning_time_inferred');
      }
      if (inst.lunchAdherence == null && hour >= 11 && hour < 16) {
        inst.lunchAdherence = 0.75;
        evidence.push('lunch_time_inferred');
      }
      if (inst.dinnerAdherence == null && hour >= 16 && hour < 23) {
        inst.dinnerAdherence = 0.75;
        evidence.push('dinner_time_inferred');
      }
    }

    var cuisineHits = detectCuisineHits(blob);
    Object.keys(cuisineHits).forEach(function (slug) {
      if (cuisineHits[slug] > 0.1) evidence.push('cuisine_' + slug);
    });

    var ai = opts.aiSignals && typeof opts.aiSignals === 'object' ? opts.aiSignals : null;
    if (ai) {
      NUMERIC_SIGNAL_KEYS.forEach(function (key) {
        if (ai[key] == null) return;
        var v = clamp01(ai[key]);
        if (inst[key] == null || inst[key] === undefined) inst[key] = v;
        else inst[key] = clamp01((inst[key] + v) / 2);
      });
      if (ai.cuisinePreferences && typeof ai.cuisinePreferences === 'object') {
        Object.keys(ai.cuisinePreferences).forEach(function (ck) {
          var cv = clamp01(ai.cuisinePreferences[ck]);
          if (cv > 0.2) {
            cuisineHits[String(ck).toLowerCase()] = Math.max(cuisineHits[String(ck).toLowerCase()] || 0, cv);
            evidence.push('ai_cuisine_' + ck);
          }
        });
      }
      evidence.push('ai_signals_merged');
    }

    var confidence = 0.28;
    if (blob.length >= 12) confidence += 0.12;
    if (blob.length >= 28) confidence += 0.08;
    confidence += Math.min(0.35, evidence.length * 0.06);
    if (ai) confidence += 0.18;
    confidence = clamp01(confidence);

    return {
      instantaneous: inst,
      confidence: confidence,
      evidence: evidence,
      cuisineHits: cuisineHits
    };
  }

  function normalizeAiSignalsFromTriage(json) {
    if (!json || typeof json !== 'object') return null;
    var raw = json.signals || json.foodLogSignals;
    if (!raw || typeof raw !== 'object') return null;
    var out = {};
    NUMERIC_SIGNAL_KEYS.forEach(function (key) {
      if (raw[key] != null) out[key] = clamp01(raw[key]);
    });
    if (raw.cuisinePreferences && typeof raw.cuisinePreferences === 'object') {
      out.cuisinePreferences = raw.cuisinePreferences;
    }
    return Object.keys(out).length ? out : null;
  }

  function ensureFoodLogSignals(adaptive) {
    adaptive = adaptive || {};
    if (!adaptive.foodLogSignals || typeof adaptive.foodLogSignals !== 'object') {
      adaptive.foodLogSignals = defaultFoodLogSignals();
    }
    var d = defaultFoodLogSignals();
    var fl = adaptive.foodLogSignals;
    Object.keys(d).forEach(function (k) {
      if (fl[k] == null) fl[k] = d[k];
    });
    if (!fl.cuisinePreferences || typeof fl.cuisinePreferences !== 'object') {
      fl.cuisinePreferences = {};
    }
    if (!Array.isArray(fl.recentEvidence)) fl.recentEvidence = [];
    return fl;
  }

  function blendScalar(prev, next, alpha) {
    if (next == null || !isFinite(next)) return prev;
    return clamp01(prev * (1 - alpha) + clamp01(next) * alpha);
  }

  /**
   * @param {object} adaptive — UP.arcAdaptive (mutated)
   * @param {object} extraction — from extractFoodLogSignals
   * @param {string} source
   * @returns {object} updated foodLogSignals
   */
  function mergeFoodLogSignalsIntoAdaptive(adaptive, extraction, source) {
    adaptive = adaptive || {};
    var fl = ensureFoodLogSignals(adaptive);
    var inst = extraction.instantaneous || {};
    var alpha = clamp01(extraction.confidence * 0.32);
    if (alpha < 0.06) alpha = 0.06;

    NUMERIC_SIGNAL_KEYS.forEach(function (key) {
      var next = inst[key];
      if (key.indexOf('Adherence') >= 0) {
        if (next == null) return;
        fl[key] = blendScalar(fl[key] == null ? 0.5 : fl[key], next, alpha);
        return;
      }
      if (next == null || next <= 0) return;
      fl[key] = blendScalar(fl[key] || 0, next, alpha);
    });

    var cuisineHits = extraction.cuisineHits || {};
    Object.keys(cuisineHits).forEach(function (slug) {
      var hit = clamp01(cuisineHits[slug]);
      if (hit <= 0.1) return;
      var prev = fl.cuisinePreferences[slug] || 0;
      fl.cuisinePreferences[slug] = blendScalar(prev, hit, alpha);
    });

    fl.sampleCount = (fl.sampleCount || 0) + 1;
    fl.updatedAt = new Date().toISOString();
    fl.confidence = blendScalar(fl.confidence || 0, extraction.confidence, 0.4);

    var snippet = String(source || 'log') + ': ' + (extraction.evidence || []).join(',');
    fl.recentEvidence.push(snippet);
    if (fl.recentEvidence.length > EVIDENCE_CAP) {
      fl.recentEvidence = fl.recentEvidence.slice(-EVIDENCE_CAP);
    }

    adaptive.foodLogSignals = fl;
    return fl;
  }

  function topCuisinePreferences(cuisinePrefs, limit) {
    cuisinePrefs = cuisinePrefs || {};
    var pairs = [];
    Object.keys(cuisinePrefs).forEach(function (slug) {
      pairs.push({ slug: slug, score: clamp01(cuisinePrefs[slug]) });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });
    return pairs.slice(0, limit || 3);
  }

  function hasDurableFoodLogSignals(adaptive) {
    var fl = adaptive && adaptive.foodLogSignals;
    if (!fl || !(fl.sampleCount > 0)) return false;
    return (fl.confidence || 0) >= 0.32 || fl.sampleCount >= 2;
  }

  /**
   * Prompt lines for week generation (soft; no calorie/macro edits).
   * @param {object} adaptive
   * @returns {string}
   */
  function buildFoodLogAdaptivePromptBlock(adaptive) {
    var fl = adaptive && adaptive.foodLogSignals;
    if (!hasDurableFoodLogSignals(adaptive)) return '';

    var lines = '\n=== FOOD LOG ADAPTIVE SIGNALS (durable — honor softly) ===\n';
    lines += 'food_log_confidence: ' + clamp01(fl.confidence).toFixed(2) + '\n';
    lines += 'food_log_samples: ' + (fl.sampleCount || 0) + '\n';
    NUMERIC_SIGNAL_KEYS.forEach(function (key) {
      if ((fl[key] || 0) >= 0.38) {
        lines += key + ': ' + clamp01(fl[key]).toFixed(2) + '\n';
      }
    });
    var top = topCuisinePreferences(fl.cuisinePreferences, 3);
    if (top.length) {
      var cuis = top.map(function (p) {
        return (CUISINE_LABELS[p.slug] || p.slug) + ' (' + p.score.toFixed(2) + ')';
      }).join(', ');
      lines += 'cuisinePreferences_from_logs: ' + cuis + '\n';
    }
    lines += 'Use these as soft biases for recipe style only — never override mandatory diet rules or calorie targets.\n';
    return lines;
  }

  function logFoodLogIngestion(extraction, fl) {
    console.log(LOG_PREFIX, {
      confidence: extraction.confidence,
      evidence: extraction.evidence,
      sampleCount: fl.sampleCount,
      quickMealPreference: Number(fl.quickMealPreference.toFixed ? fl.quickMealPreference.toFixed(2) : fl.quickMealPreference),
      restaurantFrequency: Number(fl.restaurantFrequency.toFixed ? fl.restaurantFrequency.toFixed(2) : fl.restaurantFrequency),
      breakfastAdherence: Number(fl.breakfastAdherence.toFixed ? fl.breakfastAdherence.toFixed(2) : fl.breakfastAdherence),
      lunchAdherence: Number(fl.lunchAdherence.toFixed ? fl.lunchAdherence.toFixed(2) : fl.lunchAdherence),
      dinnerAdherence: Number(fl.dinnerAdherence.toFixed ? fl.dinnerAdherence.toFixed(2) : fl.dinnerAdherence),
      proteinFocus: Number(fl.proteinFocus.toFixed ? fl.proteinFocus.toFixed(2) : fl.proteinFocus),
      conveniencePreference: Number(fl.conveniencePreference.toFixed ? fl.conveniencePreference.toFixed(2) : fl.conveniencePreference),
      groceryAvoidance: Number(fl.groceryAvoidance.toFixed ? fl.groceryAvoidance.toFixed(2) : fl.groceryAvoidance),
      cuisinePreferences: fl.cuisinePreferences
    });
  }

  global.ArcFoodLogSignals = {
    SIGNAL_VERSION: SIGNAL_VERSION,
    defaultFoodLogSignals: defaultFoodLogSignals,
    ensureFoodLogSignals: ensureFoodLogSignals,
    extractFoodLogSignals: extractFoodLogSignals,
    normalizeAiSignalsFromTriage: normalizeAiSignalsFromTriage,
    mergeFoodLogSignalsIntoAdaptive: mergeFoodLogSignalsIntoAdaptive,
    buildFoodLogAdaptivePromptBlock: buildFoodLogAdaptivePromptBlock,
    hasDurableFoodLogSignals: hasDurableFoodLogSignals,
    topCuisinePreferences: topCuisinePreferences,
    logFoodLogIngestion: logFoodLogIngestion
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
