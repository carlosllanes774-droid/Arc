/**
 * Spoonacular week recipe library — search, bulk map, validate before applyLibrary.
 */
(function (global) {
  'use strict';

  var LOG_PREFIX = '[ARC SPOONACULAR VALIDATION]';
  var MIN_RECIPES = 4;
  var VALID_CATS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
  var VALID_CAT_SET = { Breakfast: true, Lunch: true, Dinner: true, Snack: true };

  var CATEGORY_QUERIES = {
    Breakfast: 'breakfast high protein',
    Lunch: 'lunch',
    Dinner: 'dinner',
    Snack: 'healthy snack'
  };

  var CUISINE_LOG_PREFIX = '[ARC CUISINE]';

  /** UI chip label → Spoonacular complexSearch cuisine slug (null = query-only). */
  var CUISINE_TO_SPOONACULAR = {
    Mediterranean: 'mediterranean',
    Italian: 'italian',
    Asian: null,
    Japanese: 'japanese',
    Mexican: 'mexican',
    American: 'american',
    Indian: 'indian',
    'Middle Eastern': 'middle eastern'
  };

  /** Keywords used to detect cuisine on mapped recipes (tags, title, ingredients). */
  var CUISINE_DETECT_KEYWORDS = {
    mediterranean: ['mediterranean', 'greek', 'hummus', 'feta', 'tzatziki', 'olive'],
    italian: ['italian', 'pasta', 'marinara', 'parmesan', 'risotto', 'pesto', 'lasagna', 'carbonara'],
    asian: ['asian', 'stir fry', 'soy sauce', 'sesame', 'teriyaki', 'ramen', 'pho'],
    japanese: ['japanese', 'miso', 'sushi', 'teriyaki', 'udon', 'soba', 'ramen'],
    mexican: ['mexican', 'taco', 'tortilla', 'salsa', 'cilantro', 'enchilada', 'burrito', 'queso', 'chipotle'],
    american: ['american', 'burger', 'bbq', 'barbecue', 'mac and cheese', 'cornbread'],
    indian: ['indian', 'curry', 'masala', 'tikka', 'naan', 'dal', 'chutney'],
    'middle eastern': ['middle eastern', 'shawarma', 'falafel', 'tahini', 'harissa', 'pita']
  };

  function normalizeSelectedCuisines(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var label = String(raw[i] || '').trim();
      if (!label || seen[label]) continue;
      seen[label] = true;
      out.push(label);
      if (out.length >= 3) break;
    }
    return out;
  }

  /**
   * @param {string[]} selectedLabels
   * @returns {{ active: boolean, selected: string[], slugs: string[], cuisineParam: string|null, queryTerms: string[] }}
   */
  function resolveCuisineContext(selectedLabels) {
    var selected = normalizeSelectedCuisines(selectedLabels);
    if (!selected.length) {
      return { active: false, selected: [], slugs: [], cuisineParam: null, queryTerms: [] };
    }
    var slugs = [];
    var queryTerms = [];
    var slugSeen = {};
    selected.forEach(function (label) {
      var slug = CUISINE_TO_SPOONACULAR.hasOwnProperty(label)
        ? CUISINE_TO_SPOONACULAR[label]
        : String(label).trim().toLowerCase();
      var queryTerm = slug || String(label).trim().toLowerCase();
      if (queryTerm && queryTerms.indexOf(queryTerm) < 0) queryTerms.push(queryTerm);
      if (slug && !slugSeen[slug]) {
        slugSeen[slug] = true;
        slugs.push(slug);
      }
    });
    return {
      active: true,
      selected: selected,
      slugs: slugs,
      cuisineParam: slugs.length ? slugs.join(',') : null,
      queryTerms: queryTerms
    };
  }

  function detectRecipeCuisines(recipe) {
    var hits = {};
    var parts = [String(recipe && recipe.name || '')];
    (recipe && recipe.tags || []).forEach(function (t) { parts.push(String(t || '')); });
    (recipe && recipe.ing || []).forEach(function (n) { parts.push(String(n || '')); });
    var blob = parts.join(' ').toLowerCase();

    Object.keys(CUISINE_DETECT_KEYWORDS).forEach(function (slug) {
      var terms = CUISINE_DETECT_KEYWORDS[slug];
      for (var i = 0; i < terms.length; i++) {
        if (textContainsTerm(blob, terms[i])) {
          hits[slug] = true;
          break;
        }
      }
    });
    return Object.keys(hits);
  }

  /**
   * @param {object} recipe
   * @param {{ slugs?: string[], queryTerms?: string[] }} cuisineCtx
   * @returns {number} 0–1 match strength
   */
  function recipeCuisineMatchScore(recipe, cuisineCtx) {
    if (!cuisineCtx || !cuisineCtx.active) return 0;
    var detected = detectRecipeCuisines(recipe);
    if (!detected.length) return 0;

    var want = (cuisineCtx.slugs || []).concat(cuisineCtx.queryTerms || []);
    var wantNorm = {};
    want.forEach(function (w) {
      var key = String(w || '').trim().toLowerCase();
      if (key) wantNorm[key] = true;
    });

    var matched = 0;
    for (var i = 0; i < detected.length; i++) {
      if (wantNorm[detected[i]]) matched += 1;
    }
    if (!matched && cuisineCtx.queryTerms && cuisineCtx.queryTerms.length) {
      var blob = recipeSearchableText(recipe);
      for (var qi = 0; qi < cuisineCtx.queryTerms.length; qi++) {
        if (textContainsTerm(blob, cuisineCtx.queryTerms[qi])) {
          matched += 1;
          break;
        }
      }
    }
    if (!matched) return 0;
    return Math.min(1, matched / Math.max(1, (cuisineCtx.slugs || []).length || cuisineCtx.queryTerms.length));
  }

  function buildCategorySearchQuery(cat, cuisineCtx, catIndex) {
    var base = CATEGORY_QUERIES[cat] || String(cat).toLowerCase();
    if (!cuisineCtx || !cuisineCtx.active) return base;

    var terms = cuisineCtx.queryTerms.length ? cuisineCtx.queryTerms : cuisineCtx.slugs;
    if (!terms.length) return base;

    var idx = catIndex != null && isFinite(catIndex) ? Math.abs(parseInt(catIndex, 10) || 0) : 0;
    var primary = terms[idx % terms.length];
    return primary + ' ' + base;
  }

  function summarizeCuisineDistribution(recipes, cuisineCtx) {
    var counts = {};
    (recipes || []).forEach(function (r) {
      var detected = detectRecipeCuisines(r);
      if (!detected.length) {
        counts.unknown = (counts.unknown || 0) + 1;
        return;
      }
      detected.forEach(function (slug) {
        counts[slug] = (counts[slug] || 0) + 1;
      });
    });
    var matched = 0;
    (recipes || []).forEach(function (r) {
      if (recipeCuisineMatchScore(r, cuisineCtx) > 0) matched += 1;
    });
    return { counts: counts, matchedCount: matched, total: (recipes || []).length };
  }

  function logArcCuisineTelemetry(phase, cuisineCtx, stats) {
    if (!cuisineCtx || !cuisineCtx.active) {
      console.log(CUISINE_LOG_PREFIX, phase, {
        selectedCuisines: [],
        candidateCuisines: {},
        finalCuisines: {},
        note: 'no_cuisine_preference'
      });
      return;
    }
    console.log(CUISINE_LOG_PREFIX, phase, {
      selectedCuisines: cuisineCtx.selected,
      spoonacularCuisineParam: cuisineCtx.cuisineParam,
      searchQueryTerms: cuisineCtx.queryTerms,
      candidateCuisines: stats && stats.candidate ? stats.candidate.counts : {},
      candidateMatched: stats && stats.candidate ? stats.candidate.matchedCount : 0,
      candidateTotal: stats && stats.candidate ? stats.candidate.total : 0,
      finalCuisines: stats && stats.final ? stats.final.counts : {},
      finalMatched: stats && stats.final ? stats.final.matchedCount : 0,
      finalTotal: stats && stats.final ? stats.final.total : 0
    });
  }

  function apiUrl(path) {
    if (global.ArcRuntime && global.ArcRuntime.apiUrl) return global.ArcRuntime.apiUrl(path);
    if (typeof global.arcApiPath === 'function') return global.arcApiPath(path);
    return path;
  }

  function postJson(path, body) {
    var baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
    var doFetch = function (headers) {
      return fetch(apiUrl(path), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body || {})
      });
    };
    var req = (global.ArcApiBase && global.ArcApiBase.withAuthHeaders)
      ? global.ArcApiBase.withAuthHeaders(baseHeaders).then(doFetch)
      : doFetch(baseHeaders);
    return req.then(function (resp) {
      return resp.json().then(function (json) {
        return { ok: resp.ok, status: resp.status, json: json };
      });
    });
  }

  /**
   * @param {string[]} [restrictions]
   * @returns {string|undefined}
   */
  /**
   * Canonical Edamam line — prefer Spoonacular original NLP text.
   * @param {object} x extendedIngredients entry
   * @returns {string}
   */
  function edamamLineFromIngredient(x) {
    x = x || {};
    var original = String(x.original || '').trim();
    if (original) return original;
    var name = String(x.name || '').trim();
    var qtyParts = [x.amount, x.unit].filter(function (v) {
      return v != null && v !== '';
    });
    if (qtyParts.length && name) return qtyParts.join(' ').trim() + ' ' + name;
    if (qtyParts.length) return qtyParts.join(' ').trim();
    return name;
  }

  /**
   * Stable key for ingQty when duplicate display names exist.
   * @param {number|string} spId
   * @param {number} index
   * @param {object} x
   * @returns {string}
   */
  function ingredientStableKey(spId, index, x) {
    if (x && x.id != null && x.id !== '') return 'sp_' + spId + '_' + x.id;
    return 'sp_' + spId + '_' + index;
  }

  function mapRestrictionsToSpoonacularDiet(restrictions) {
    if (!Array.isArray(restrictions)) return undefined;
    var lower = restrictions.map(function (r) { return String(r || '').toLowerCase(); });
    if (lower.indexOf('vegan') >= 0) return 'vegan';
    if (lower.indexOf('vegetarian') >= 0) return 'vegetarian';
    if (lower.indexOf('gluten-free') >= 0 || lower.indexOf('gluten free') >= 0) return 'gluten free';
    if (lower.indexOf('ketogenic') >= 0 || lower.indexOf('keto') >= 0) return 'ketogenic';
    if (lower.indexOf('paleo') >= 0) return 'paleo';
    return undefined;
  }

  var DIET_MEAT_TERMS = [
    'chicken', 'beef', 'pork', 'lamb', 'turkey', 'bacon', 'ham', 'sausage', 'steak', 'veal',
    'duck', 'prosciutto', 'salami', 'pepperoni', 'chorizo', 'ground beef', 'ground turkey', 'meatball'
  ];
  var DIET_FISH_TERMS = [
    'fish', 'salmon', 'tuna', 'shrimp', 'cod', 'tilapia', 'anchovy', 'sardine', 'crab', 'lobster',
    'scallop', 'shellfish', 'seafood', 'trout', 'mackerel', 'prawn', 'clam', 'oyster', 'squid', 'calamari'
  ];
  var DIET_DAIRY_TERMS = [
    'milk', 'butter', 'cheese', 'cream', 'whey', 'casein', 'yogurt', 'yoghurt', 'ghee', 'parmesan',
    'mozzarella', 'cheddar', 'cream cheese', 'sour cream', 'ricotta', 'feta', 'lactose', 'half-and-half'
  ];
  var DIET_EGG_TERMS = ['egg', 'eggs', 'albumin', 'mayonnaise', 'mayo', 'meringue'];
  var DIET_ANIMAL_TERMS = ['honey', 'gelatin', 'lard', 'tallow', 'rennet'];
  var DIET_GLUTEN_TERMS = [
    'wheat', 'barley', 'rye', 'flour', 'bread', 'pasta', 'noodle', 'soy sauce', 'seitan', 'bulgur',
    'couscous', 'semolina', 'gluten', 'breadcrumbs', 'crouton', 'spaghetti', 'macaroni', 'tortilla', 'pita'
  ];
  var DIET_NUT_TERMS = [
    'peanut', 'almond', 'walnut', 'cashew', 'pistachio', 'hazelnut', 'pecan', 'macadamia', 'pine nut',
    'pesto', 'praline', 'marzipan', 'nut butter', 'nut milk', 'nut oil'
  ];
  var DIET_HALAL_TERMS = [
    'pork', 'bacon', 'ham', 'prosciutto', 'lard', 'wine', 'beer', 'rum', 'vodka', 'whiskey', 'brandy',
    'sherry', 'liqueur', 'alcohol', 'mirin', 'cooking wine'
  ];
  var DIET_KETO_BAN_TERMS = [
    'sugar', 'rice', 'bread', 'pasta', 'potato', 'corn syrup', 'honey', 'maple syrup', 'oat', 'quinoa',
    'bean', 'lentil', 'chickpea', 'flour', 'tortilla', 'noodle', 'cornstarch', 'molasses'
  ];
  var DIET_PALEO_BAN_TERMS = [
    'grain', 'rice', 'bread', 'pasta', 'bean', 'lentil', 'chickpea', 'peanut', 'soy', 'tofu', 'milk',
    'cheese', 'yogurt', 'cream', 'sugar', 'corn syrup', 'quinoa', 'barley', 'wheat'
  ];

  /**
   * @param {string} raw
   * @returns {string[]}
   */
  function parseDislikes(raw) {
    if (raw == null || raw === '') return [];
    return String(raw)
      .split(/[,;\n]+/)
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return s.length >= 2; });
  }

  function recipeSearchableText(recipe) {
    var parts = [String(recipe.name || '')];
    (recipe.ing || []).forEach(function (n) { parts.push(String(n || '')); });
    return parts.join(' ').toLowerCase();
  }

  function textContainsTerm(text, term) {
    if (!term) return false;
    var t = String(term).trim().toLowerCase();
    if (!t) return false;
    if (text.indexOf(t) >= 0) return true;
    if (t.indexOf(' ') >= 0) return text.indexOf(t) >= 0;
    var re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    return re.test(text);
  }

  /**
   * @param {object} recipe
   * @param {string[]} dislikeTerms
   * @returns {string|null} matched term
   */
  function recipeMatchesDislike(recipe, dislikeTerms) {
    if (!dislikeTerms || !dislikeTerms.length) return null;
    var title = String(recipe.name || '').toLowerCase();
    for (var i = 0; i < dislikeTerms.length; i++) {
      var term = dislikeTerms[i];
      if (textContainsTerm(title, term)) return term;
    }
    for (var j = 0; j < (recipe.ing || []).length; j++) {
      var ing = String(recipe.ing[j] || '').toLowerCase();
      for (var k = 0; k < dislikeTerms.length; k++) {
        if (textContainsTerm(ing, dislikeTerms[k])) return dislikeTerms[k];
      }
    }
    return null;
  }

  function restrictionFlags(restrictions) {
    var flags = {};
    if (!Array.isArray(restrictions)) return flags;
    restrictions.forEach(function (r) {
      var key = String(r || '').trim();
      if (key && key !== 'None') flags[key] = true;
    });
    return flags;
  }

  function firstBannedTerm(blob, terms) {
    for (var i = 0; i < terms.length; i++) {
      if (textContainsTerm(blob, terms[i])) return terms[i];
    }
    return null;
  }

  /**
   * @param {object} recipe
   * @param {string[]} [restrictions]
   * @returns {{ ok: boolean, violations: string[] }}
   */
  function validateRecipeDietCompliance(recipe, restrictions) {
    var flags = restrictionFlags(restrictions);
    var blob = recipeSearchableText(recipe);
    var violations = [];
    var hit;

    if (flags.Vegan) {
      hit = firstBannedTerm(blob, DIET_MEAT_TERMS.concat(DIET_FISH_TERMS, DIET_DAIRY_TERMS, DIET_EGG_TERMS, DIET_ANIMAL_TERMS));
      if (hit) violations.push('vegan:' + hit);
    } else if (flags.Vegetarian) {
      hit = firstBannedTerm(blob, DIET_MEAT_TERMS.concat(DIET_FISH_TERMS));
      if (hit) violations.push('vegetarian:' + hit);
    }

    if (flags['Gluten-free']) {
      hit = firstBannedTerm(blob, DIET_GLUTEN_TERMS);
      if (hit) violations.push('gluten_free:' + hit);
    }

    if (flags['Dairy-free'] && !flags.Vegan) {
      hit = firstBannedTerm(blob, DIET_DAIRY_TERMS);
      if (hit) violations.push('dairy_free:' + hit);
    }

    if (flags['Nut allergy']) {
      hit = firstBannedTerm(blob, DIET_NUT_TERMS);
      if (hit) violations.push('nut_free:' + hit);
    }

    if (flags.Halal) {
      hit = firstBannedTerm(blob, DIET_HALAL_TERMS);
      if (hit) violations.push('halal:' + hit);
    }

    if (flags.Keto) {
      hit = firstBannedTerm(blob, DIET_KETO_BAN_TERMS);
      if (hit) violations.push('keto:' + hit);
    }

    if (flags.Paleo) {
      hit = firstBannedTerm(blob, DIET_PALEO_BAN_TERMS);
      if (hit) violations.push('paleo:' + hit);
    }

    return { ok: violations.length === 0, violations: violations };
  }

  /**
   * V2 nutrition hard rejects — calories, protein, quality, budget (not meal-target matching).
   * @param {object[]} recipes
   * @param {{ budget?: string }} [opts]
   * @returns {{ compliant: object[], rejectedNutrition: object[] }}
   */
  function filterNutritionHardRejects(recipes, opts) {
    opts = opts || {};
    var V2 = global.ArcNutritionV2;
    if (!V2 || !V2.shouldHardRejectRecipe) {
      return { compliant: recipes || [], rejectedNutrition: [] };
    }
    var compliant = [];
    var rejectedNutrition = [];
    (recipes || []).forEach(function (r) {
      var check = V2.shouldHardRejectRecipe(r, { cat: r.cat, budget: opts.budget });
      if (check.rejected) {
        rejectedNutrition.push({
          spoonacularId: r.spoonacularId,
          name: r.name,
          reasons: check.reasons
        });
        return;
      }
      compliant.push(r);
    });
    if (rejectedNutrition.length) {
      console.log('[ARC NUTRITION V2]', {
        rejected: rejectedNutrition.length,
        kept: compliant.length,
        samples: rejectedNutrition.slice(0, 5)
      });
    }
    return { compliant: compliant, rejectedNutrition: rejectedNutrition };
  }

  /**
   * @param {object[]} recipes
   * @param {string[]} [restrictions]
   * @param {string[]} [dislikeTerms]
   * @param {{ budget?: string }} [opts]
   * @returns {{ compliant: object[], rejectedDislikes: object[], rejectedDiet: object[], rejectedNutrition: object[] }}
   */
  function filterCompliantCandidates(recipes, restrictions, dislikeTerms, opts) {
    opts = opts || {};
    var compliant = [];
    var rejectedDislikes = [];
    var rejectedDiet = [];

    (recipes || []).forEach(function (r) {
      var dislikeHit = recipeMatchesDislike(r, dislikeTerms);
      if (dislikeHit) {
        rejectedDislikes.push({
          spoonacularId: r.spoonacularId,
          name: r.name,
          term: dislikeHit
        });
        return;
      }
      var diet = validateRecipeDietCompliance(r, restrictions);
      if (!diet.ok) {
        rejectedDiet.push({
          spoonacularId: r.spoonacularId,
          name: r.name,
          violations: diet.violations
        });
        return;
      }
      compliant.push(r);
    });

    var nutritionFiltered = filterNutritionHardRejects(compliant, opts);
    compliant = nutritionFiltered.compliant;

    if (rejectedDislikes.length) {
      console.log('[ARC DISLIKES FILTER]', {
        rejected: rejectedDislikes.length,
        kept: compliant.length,
        samples: rejectedDislikes.slice(0, 5)
      });
    }

    if (rejectedDiet.length) {
      console.log('[ARC DIET VALIDATION]', {
        rejected: rejectedDiet.length,
        kept: compliant.length,
        samples: rejectedDiet.slice(0, 5)
      });
    }

    return { compliant: compliant, rejectedDislikes: rejectedDislikes, rejectedDiet: rejectedDiet, rejectedNutrition: nutritionFiltered.rejectedNutrition };
  }

  function perCatSelectionShortfall(selected, perCat) {
    var grouped = groupRecipesByCategory(selected);
    var short = {};
    Object.keys(perCat || {}).forEach(function (cat) {
      var need = parseInt(perCat[cat], 10) || 0;
      if (!(need > 0)) return;
      var have = (grouped[cat] || []).length;
      if (have < need) short[cat] = need - have;
    });
    return short;
  }

  function safeRound(v) {
    var n = Number(v);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function categoryTargetsFor(cat, mt) {
    mt = mt || {};
    if (cat === 'Breakfast') return mt.Breakfast || mt.perSlot || {};
    if (cat === 'Dinner') return mt.Dinner || mt.perSlot || {};
    if (cat === 'Snack') return mt.Snack || mt.perSlot || {};
    return mt.Lunch || mt.perSlot || {};
  }

  function macrosFromSpoonacularBulkItem(sp) {
    sp = sp || {};
    if (sp.nutrition && typeof sp.nutrition === 'object') {
      return {
        cal: sp.nutrition.calories,
        p: sp.nutrition.protein,
        c: sp.nutrition.carbs,
        f: sp.nutrition.fat
      };
    }
    return {
      cal: sp.calories,
      p: sp.protein,
      c: sp.carbs,
      f: sp.fat
    };
  }

  function hasPositiveMacros(cal, p, c, f) {
    return Number(cal) > 0 && Number(p) > 0 && Number(c) > 0 && Number(f) > 0;
  }

  /**
   * @param {object} recipe — week-library recipe (mutated)
   * @param {object} sp — bulk recipe row
   * @param {object} [mealTargets] — built.mt from week generation
   */
  function applyNutritionToWeekLibraryRecipe(recipe, sp, mealTargets) {
    var raw = macrosFromSpoonacularBulkItem(sp);
    var cal = safeRound(raw.cal);
    var p = safeRound(raw.p);
    var c = safeRound(raw.c);
    var f = safeRound(raw.f);

    if (hasPositiveMacros(cal, p, c, f)) {
      recipe.cal = cal;
      recipe.p = p;
      recipe.c = c;
      recipe.f = f;
      recipe.nutritionSource = 'spoonacular';
      recipe.nutritionVerified = false;
      recipe.nutritionConfidence = 'low';
      console.log('[ARC SPOONACULAR] nutrition mapped', {
        name: recipe.name,
        spoonacularId: recipe.spoonacularId,
        cal: cal,
        p: p
      });
      return;
    }

    var t = categoryTargetsFor(recipe.cat, mealTargets);
    recipe.cal = safeRound(t.cal);
    recipe.p = safeRound(t.p);
    recipe.c = safeRound(t.c);
    recipe.f = safeRound(t.f);
    recipe.nutritionSource = 'category_targets';
    recipe.nutritionVerified = false;
    recipe.nutritionConfidence = 'low';
    console.log('[ARC SPOONACULAR] category target nutrition fallback', {
      name: recipe.name,
      cat: recipe.cat,
      spoonacularId: recipe.spoonacularId,
      cal: recipe.cal,
      p: recipe.p
    });
  }

  /**
   * @param {object} bulk — BFF /api/spoonacular/bulk response
   * @param {object} categoryBySpoonacularId — spoonacular id → meal category
   * @param {object} [mealTargets] — built.mt for category fallback when nutrition missing
   * @returns {{ recipes: object[] }}
   */
  function mapSpoonacularBulkToWeekLibrary(bulk, categoryBySpoonacularId, mealTargets) {
    categoryBySpoonacularId = categoryBySpoonacularId || {};
    var list = bulk && Array.isArray(bulk.recipes) ? bulk.recipes : [];
    var recipes = [];
    var localId = 0;

    for (var i = 0; i < list.length; i++) {
      var sp = list[i] || {};
      var spId = sp.recipeId != null ? sp.recipeId : sp.id;
      var catKey = spId != null ? String(spId) : '';
      var cat = categoryBySpoonacularId[catKey] || categoryBySpoonacularId[spId] || '';

      var ingRaw = sp.extendedIngredients || sp.ingredients || [];
      var ingNames = [];
      var ingKeys = [];
      var ingQty = {};
      var ingEdamam = [];
      for (var j = 0; j < ingRaw.length; j++) {
        var x = ingRaw[j] || {};
        var name = String(x.name || x.original || '').trim();
        if (!name) continue;
        var ingKey = ingredientStableKey(spId, j, x);
        var qtyParts = [x.amount, x.unit].filter(function (v) {
          return v != null && v !== '';
        });
        var qtyDisplay = qtyParts.length ? qtyParts.join(' ').trim() : '';
        var edamamLine = edamamLineFromIngredient(x);

        ingNames.push(name);
        ingKeys.push(ingKey);
        ingEdamam.push(edamamLine);
        ingQty[ingKey] = qtyDisplay;
        if (!Object.prototype.hasOwnProperty.call(ingQty, name)) {
          ingQty[name] = qtyDisplay || String(x.original || '').trim();
        }
      }

      var steps = (sp.instructions || []).map(function (txt) {
        return { phase: 'Cook', instruction: String(txt) };
      });

      localId += 1;
      console.log('[ARC SPOONACULAR] recipeId mapping', { localId: localId, spoonacularId: spId });
      var recipe = {
        id: localId,
        spoonacularId: spId,
        name: String(sp.title || sp.name || '').trim(),
        cat: cat,
        ing: ingNames,
        ingKeys: ingKeys,
        ingEdamam: ingEdamam,
        ingQty: ingQty,
        steps: steps,
        instructionSource: steps.length > 0 ? 'spoonacular' : undefined,
        servings: sp.servings || 2,
        time: String(sp.readyInMinutes != null ? sp.readyInMinutes : (sp.prepTime || 25)) + ' min',
        image: sp.image || null,
        tags: Array.isArray(sp.tags) ? sp.tags.slice() : [],
        price: 6.0
      };
      applyNutritionToWeekLibraryRecipe(recipe, sp, mealTargets);
      recipes.push(recipe);
    }

    return { recipes: recipes };
  }

  /**
   * @param {object[]} recipes
   * @returns {{ ok: boolean, errors: string[], recipes: object[] }}
   */
  function validateSpoonacularWeekLibrary(recipes) {
    var errors = [];
    recipes = Array.isArray(recipes) ? recipes : [];

    if (recipes.length < MIN_RECIPES) {
      errors.push('recipe_count_below_minimum:' + recipes.length);
    }

    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i] || {};
      var label = 'recipe[' + i + ']';

      if (!r.cat || !VALID_CAT_SET[r.cat]) {
        errors.push(label + ':invalid_or_missing_cat');
      }
      if (!r.name || !String(r.name).trim()) {
        errors.push(label + ':missing_name');
      }
      if (!Array.isArray(r.ing) || !r.ing.length) {
        errors.push(label + ':missing_ing');
      }
      if (r.spoonacularId == null || r.spoonacularId === '') {
        errors.push(label + ':missing_spoonacularId');
      }
    }

    var ok = errors.length === 0;
    console.log(LOG_PREFIX, {
      ok: ok,
      recipeCount: recipes.length,
      errors: errors
    });

    return { ok: ok, errors: errors, recipes: recipes };
  }

  function ingredientKey(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function ingredientKeySet(recipe) {
    var keys = {};
    (recipe.ing || []).forEach(function (n) {
      var k = ingredientKey(n);
      if (k) keys[k] = 1;
    });
    return keys;
  }

  /** Jaccard overlap on canonical ingredient keys (0–1). */
  function ingredientOverlapScore(recipeA, recipeB) {
    if (!recipeA || !recipeB) return 0;
    var a = ingredientKeySet(recipeA);
    var b = ingredientKeySet(recipeB);
    var inter = 0;
    var union = 0;
    var k;
    for (k in a) {
      union++;
      if (b[k]) inter++;
    }
    for (k in b) {
      if (!a[k]) union++;
    }
    return union ? inter / union : 0;
  }

  function avgOverlapWithSelected(recipe, selected) {
    if (!selected.length) return 0;
    var sum = 0;
    for (var i = 0; i < selected.length; i++) {
      sum += ingredientOverlapScore(recipe, selected[i]);
    }
    return sum / selected.length;
  }

  function uniqueIngredientCount(recipes) {
    var keys = {};
    (recipes || []).forEach(function (r) {
      (r.ing || []).forEach(function (n) {
        var k = ingredientKey(n);
        if (k) keys[k] = 1;
      });
    });
    return Object.keys(keys).length;
  }

  function computeLibraryOverlapSummary(recipes) {
    recipes = recipes || [];
    var pairSum = 0;
    var pairCount = 0;
    for (var i = 0; i < recipes.length; i++) {
      for (var j = i + 1; j < recipes.length; j++) {
        pairSum += ingredientOverlapScore(recipes[i], recipes[j]);
        pairCount++;
      }
    }
    return {
      weekAverage: pairCount ? Math.round((pairSum / pairCount) * 1000) / 1000 : 0,
      pairCount: pairCount
    };
  }

  function groupRecipesByCategory(recipes) {
    var grouped = { Breakfast: [], Lunch: [], Dinner: [], Snack: [] };
    (recipes || []).forEach(function (r) {
      var cat = r && r.cat && VALID_CAT_SET[r.cat] ? r.cat : 'Lunch';
      grouped[cat].push(r);
    });
    return grouped;
  }

  /**
   * Greedy subset selection — prefer ingredient overlap and fewer unique items (budget).
   * @param {object[]} recipes — full candidate pool after bulk map
   * @param {object} perCat — category → count
   * @param {{ isBudget?: boolean, preferOverlap?: boolean }} [opts]
   * @returns {{ recipes: object[], overlap: object, uniqueIngredients: number }}
   */
  function selectOverlapOptimizedLibrary(recipes, perCat, opts) {
    opts = opts || {};
    var preferOverlap = opts.preferOverlap !== false;
    var isBudget = !!opts.isBudget;
    var varietyMode = !!opts.varietyMode;
    var preferProtein = !!opts.preferProtein;
    var cuisineCtx = opts.cuisineCtx && opts.cuisineCtx.active ? opts.cuisineCtx : null;
    var wOverlap = preferOverlap ? 6.0 : 2.0;
    var wSimplicity = isBudget ? 2.5 : 0.75;
    var wProtein = preferProtein ? 4.0 : 0;
    var wCuisine = cuisineCtx ? 5.5 : 0;
    var grouped = groupRecipesByCategory(recipes);
    var selected = [];
    var pickedIds = {};
    var categoryOrder = ['Dinner', 'Lunch', 'Breakfast', 'Snack'];

    categoryOrder.forEach(function (cat) {
      var need = perCat && perCat[cat] ? parseInt(perCat[cat], 10) : 0;
      if (!(need > 0)) return;
      var pool = (grouped[cat] || []).slice();
      var catSelected = [];

      for (var n = 0; n < need; n++) {
        var best = null;
        var bestScore = -Infinity;
        for (var pi = 0; pi < pool.length; pi++) {
          var candidate = pool[pi];
          var spKey = candidate.spoonacularId != null ? String(candidate.spoonacularId) : '';
          if (spKey && pickedIds[spKey]) continue;

          var overlap = avgOverlapWithSelected(candidate, selected.concat(catSelected));
          var ingCount = (candidate.ing || []).length;
          var simplicity = Math.max(0, 10 - ingCount) / 10;
          var score;
          if (varietyMode) {
            score = wSimplicity * simplicity - 4.0 * overlap;
          } else {
            score = wOverlap * overlap + wSimplicity * simplicity;
          }

          if (preferProtein) {
            var cal = Number(candidate.cal) || 0;
            if (cal > 0) {
              var proteinDensity = (Number(candidate.p) || 0) / cal;
              score += wProtein * proteinDensity;
            }
          }

          if (wCuisine > 0) {
            score += wCuisine * recipeCuisineMatchScore(candidate, cuisineCtx);
          }

          if (score > bestScore || (score === bestScore && best && candidate.spoonacularId < best.spoonacularId)) {
            best = candidate;
            bestScore = score;
          } else if (!best) {
            best = candidate;
            bestScore = score;
          }
        }

        if (!best) break;
        catSelected.push(best);
        if (best.spoonacularId != null) pickedIds[String(best.spoonacularId)] = true;
      }

      selected = selected.concat(catSelected);
    });

    selected.forEach(function (r, idx) {
      r.id = idx + 1;
    });

    return {
      recipes: selected,
      overlap: computeLibraryOverlapSummary(selected),
      uniqueIngredients: uniqueIngredientCount(selected)
    };
  }

  function searchCandidatePoolSize(perCatCount, built) {
    var base = Math.max(parseInt(perCatCount, 10) || 2, 2);
    var mult = 3;
    if (built && built.cuisineCtx && built.cuisineCtx.active) mult = Math.max(mult, 4);
    if (built && built.libraryTargets && built.libraryTargets.varietyMode) mult = 4;
    if (built && built.dislikes && String(built.dislikes).trim()) mult = Math.max(mult, 5);
    if (built && Array.isArray(built.restrictions) && built.restrictions.filter(function (r) {
      return r && r !== 'None';
    }).length) {
      mult = Math.max(mult, 5);
    }
    return Math.min(Math.max(base * mult, 8), 24);
  }

  function mergeCategoryMaps(groups) {
    var categoryBySpoonacularId = {};
    var ids = [];
    var seen = {};

    (groups || []).forEach(function (group) {
      var map = group.categoryBySpoonacularId || {};
      Object.keys(map).forEach(function (id) {
        if (!seen[id]) {
          seen[id] = true;
          ids.push(Number(id) || id);
          categoryBySpoonacularId[id] = map[id];
        }
      });
    });

    return { ids: ids, categoryBySpoonacularId: categoryBySpoonacularId };
  }

  function searchCategory(cat, count, built, searchOpts) {
    searchOpts = searchOpts || {};
    var mt = built && built.mt ? built.mt : {};
    var perSlot = mt.perSlot || { cal: 600 };
    var weekMode = built && built.weekMode ? built.weekMode : {};
    var cuisineCtx = built && built.cuisineCtx ? built.cuisineCtx : null;
    var diet = mapRestrictionsToSpoonacularDiet(built && built.restrictions);
    var poolSize = searchCandidatePoolSize(count, built);
    if (searchOpts.poolBoost) poolSize = Math.min(poolSize + searchOpts.poolBoost, 24);

    var catIndex = searchOpts.catIndex != null ? searchOpts.catIndex : 0;
    var body = {
      query: buildCategorySearchQuery(cat, cuisineCtx, catIndex),
      diet: diet,
      maxCalories: Math.round((Number(perSlot.cal) || 600) * 1.15),
      number: poolSize
    };

    if (cuisineCtx && cuisineCtx.active && cuisineCtx.cuisineParam) {
      body.cuisine = cuisineCtx.cuisineParam;
    }

    if (weekMode.maxReadyTime) body.maxReadyTime = weekMode.maxReadyTime;
    if (weekMode.preferProtein) {
      var slotTarget = categoryTargetsFor(cat, mt);
      var minP = Math.round((Number(slotTarget.p) || 30) * 0.85);
      if (minP > 0) body.minProtein = minP;
      if (cat === 'Breakfast' || cat === 'Lunch' || cat === 'Dinner') {
        body.query = buildCategorySearchQuery(cat, cuisineCtx, catIndex) + ' high protein';
      }
    }

    return postJson('/api/spoonacular/search', body).then(function (res) {
      var categoryBySpoonacularId = {};
      var ids = [];
      var exclude = searchOpts.excludeIds || {};
      if (!res.ok) {
        return { cat: cat, ids: ids, categoryBySpoonacularId: categoryBySpoonacularId, status: res.status };
      }
      var results = (res.json && res.json.results) || [];
      results.forEach(function (x) {
        var id = x.recipeId != null ? x.recipeId : x.id;
        if (id == null) return;
        var key = String(id);
        if (exclude[key]) return;
        ids.push(id);
        categoryBySpoonacularId[key] = cat;
      });
      return { cat: cat, ids: ids, categoryBySpoonacularId: categoryBySpoonacularId };
    });
  }

  function mergeRecipesBySpoonacularId(existing, incoming) {
    var byId = {};
    (existing || []).forEach(function (r) {
      if (r && r.spoonacularId != null) byId[String(r.spoonacularId)] = r;
    });
    (incoming || []).forEach(function (r) {
      if (r && r.spoonacularId != null) byId[String(r.spoonacularId)] = r;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; });
  }

  /**
   * Search, bulk-map, filter, select — with top-up passes when compliance filters shrink the pool.
   * @param {object} built
   * @param {object} perCat
   * @returns {Promise<{ selection: object, mappedCount: number, attempts: number }>}
   */
  function buildCompliantWeekLibrary(built, perCat) {
    built.cuisineCtx = resolveCuisineContext(built.cuisines);
    if (built.cuisineCtx.active) {
      logArcCuisineTelemetry('search_start', built.cuisineCtx, null);
    }
    var restrictions = built.restrictions || [];
    var dislikeTerms = parseDislikes(built.dislikes);
    var targets = built.libraryTargets || {};
    var selectionOpts = {
      isBudget: targets.profile === 'budget',
      preferOverlap: !targets.varietyMode,
      varietyMode: !!targets.varietyMode,
      preferProtein: !!(built.weekMode && built.weekMode.preferProtein),
      cuisineCtx: built.cuisineCtx
    };
    var triedIds = {};
    var compliantPool = [];
    var attempts = 0;
    var maxAttempts = 4;

    function markTried(ids) {
      (ids || []).forEach(function (id) {
        if (id != null) triedIds[String(id)] = true;
      });
    }

    function runPass(poolBoost) {
      attempts += 1;
      var catsToSearch = Object.keys(perCat);
      if (poolBoost > 0) {
        var short = perCatSelectionShortfall(
          selectOverlapOptimizedLibrary(compliantPool, perCat, selectionOpts).recipes,
          perCat
        );
        catsToSearch = Object.keys(short).length ? Object.keys(short) : catsToSearch;
      }

      return Promise.all(catsToSearch.map(function (cat, catIdx) {
        return searchCategory(cat, perCat[cat], built, {
          excludeIds: triedIds,
          poolBoost: poolBoost,
          catIndex: catIdx
        });
      })).then(function (groups) {
        var merged = mergeCategoryMaps(groups);
        markTried(merged.ids);
        if (!merged.ids.length) {
          return {
            selection: selectOverlapOptimizedLibrary(compliantPool, perCat, selectionOpts),
            mappedCount: compliantPool.length,
            compliantPool: compliantPool.slice()
          };
        }
        return postJson('/api/spoonacular/bulk', {
          ids: merged.ids,
          includeNutrition: true
        }).then(function (bulkRes) {
          if (!bulkRes.ok) {
            throw new Error('Spoonacular bulk failed: ' + bulkRes.status);
          }
          var mapped = mapSpoonacularBulkToWeekLibrary(
            bulkRes.json,
            merged.categoryBySpoonacularId,
            built.mt
          );
          var filtered = filterCompliantCandidates(mapped.recipes, restrictions, dislikeTerms, {
            budget: built.budget || (built.libraryTargets && built.libraryTargets.budgetProfile)
          });
          compliantPool = mergeRecipesBySpoonacularId(compliantPool, filtered.compliant);
          var selection = selectOverlapOptimizedLibrary(compliantPool, perCat, selectionOpts);
          return {
            selection: selection,
            mappedCount: compliantPool.length,
            compliantPool: compliantPool.slice()
          };
        });
      });
    }

    function loop(poolBoost) {
      return runPass(poolBoost).then(function (result) {
        var short = perCatSelectionShortfall(result.selection.recipes, perCat);
        var shortKeys = Object.keys(short);
        if (!shortKeys.length && result.selection.recipes.length >= MIN_RECIPES) {
          return {
            selection: result.selection,
            mappedCount: result.mappedCount,
            compliantPool: compliantPool.slice(),
            attempts: attempts
          };
        }
        if (attempts >= maxAttempts) {
          return {
            selection: result.selection,
            mappedCount: result.mappedCount,
            compliantPool: compliantPool.slice(),
            attempts: attempts
          };
        }
        console.log('[ARC DISLIKES FILTER]', {
          action: 'fetch_replacements',
          attempt: attempts,
          shortfall: short,
          poolSize: result.mappedCount
        });
        return loop((poolBoost || 0) + 4);
      });
    }

    return loop(0);
  }

  /**
   * Fetch Spoonacular library; validate before callback. Invalid libraries never reach applyLibrary.
   * @param {object} built — from buildWeekRecipeLibraryPrompt (+ restrictions)
   * @param {function(err: *, payload: {recipes: object[]}|null, meta: object)} callback
   */
  function fetchSpoonacularWeekLibrary(built, callback) {
    built = built || {};
    callback = typeof callback === 'function' ? callback : function () {};

    var perCat = built.libraryTargets && built.libraryTargets.perCat
      ? built.libraryTargets.perCat
      : { Lunch: 2 };
    var categories = Object.keys(perCat);

    if (!categories.length) {
      callback({
        type: 'validation_failed',
        validation: validateSpoonacularWeekLibrary([])
      }, null, { source: 'spoonacular' });
      return;
    }

    buildCompliantWeekLibrary(built, perCat)
      .then(function (result) {
        var selection = result.selection;
        var targets = built.libraryTargets || {};
        var restrictions = built.restrictions || [];
        var dislikeTerms = parseDislikes(built.dislikes);

        var cuisineCtx = resolveCuisineContext(built.cuisines);
        built.cuisineCtx = cuisineCtx;

        var finalFiltered = filterCompliantCandidates(selection.recipes, restrictions, dislikeTerms, {
          budget: built.budget || (built.libraryTargets && built.libraryTargets.budgetProfile)
        });
        var selectionOptsFinal = {
          isBudget: targets.profile === 'budget',
          preferOverlap: !targets.varietyMode,
          varietyMode: !!targets.varietyMode,
          preferProtein: !!(built.weekMode && built.weekMode.preferProtein),
          cuisineCtx: cuisineCtx
        };
        selection = selectOverlapOptimizedLibrary(finalFiltered.compliant, perCat, selectionOptsFinal);

        logArcCuisineTelemetry('week_library_complete', cuisineCtx, {
          candidate: summarizeCuisineDistribution(result.compliantPool || finalFiltered.compliant, cuisineCtx),
          final: summarizeCuisineDistribution(selection.recipes, cuisineCtx)
        });

        var preOverlap = computeLibraryOverlapSummary(selection.recipes);
        var preUnique = uniqueIngredientCount(selection.recipes);
        console.log('[ARC SPOONACULAR] library overlap selection', {
          profile: targets.profile || 'standard',
          budgetProfile: targets.budgetProfile || null,
          varietyMode: !!targets.varietyMode,
          preferProtein: !!(built.weekMode && built.weekMode.preferProtein),
          maxReadyTime: built.weekMode && built.weekMode.maxReadyTime,
          candidateCount: result.mappedCount,
          selectedCount: selection.recipes.length,
          uniqueIngredients: preUnique,
          overlap: preOverlap.weekAverage,
          complianceAttempts: result.attempts
        });

        var validation = validateSpoonacularWeekLibrary(selection.recipes);
        if (!validation.ok) {
          callback({
            type: 'validation_failed',
            validation: validation
          }, null, { source: 'spoonacular', validationErrors: validation.errors });
          return;
        }
        callback(null, { recipes: selection.recipes }, {
          source: 'spoonacular',
          librarySelection: {
            candidateCount: result.mappedCount,
            uniqueIngredientsBefore: preUnique,
            uniqueIngredientsAfter: preUnique,
            overlapBefore: preOverlap.weekAverage,
            overlapAfter: selection.overlap.weekAverage,
            profile: targets.profile || 'standard',
            complianceAttempts: result.attempts
          }
        });
      })
      .catch(function (err) {
        callback(err || new Error('Spoonacular week library fetch failed'), null, { source: 'spoonacular' });
      });
  }

  global.ArcSpoonacularWeekLibrary = {
    MIN_RECIPES: MIN_RECIPES,
    VALID_CATS: VALID_CATS.slice(),
    edamamLineFromIngredient: edamamLineFromIngredient,
    ingredientStableKey: ingredientStableKey,
    ingredientOverlapScore: ingredientOverlapScore,
    selectOverlapOptimizedLibrary: selectOverlapOptimizedLibrary,
    computeLibraryOverlapSummary: computeLibraryOverlapSummary,
    uniqueIngredientCount: uniqueIngredientCount,
    mapSpoonacularBulkToWeekLibrary: mapSpoonacularBulkToWeekLibrary,
    applyNutritionToWeekLibraryRecipe: applyNutritionToWeekLibraryRecipe,
    macrosFromSpoonacularBulkItem: macrosFromSpoonacularBulkItem,
    validateSpoonacularWeekLibrary: validateSpoonacularWeekLibrary,
    mapRestrictionsToSpoonacularDiet: mapRestrictionsToSpoonacularDiet,
    parseDislikes: parseDislikes,
    recipeMatchesDislike: recipeMatchesDislike,
    validateRecipeDietCompliance: validateRecipeDietCompliance,
    filterNutritionHardRejects: filterNutritionHardRejects,
    filterCompliantCandidates: filterCompliantCandidates,
    fetchSpoonacularWeekLibrary: fetchSpoonacularWeekLibrary,
    normalizeSelectedCuisines: normalizeSelectedCuisines,
    resolveCuisineContext: resolveCuisineContext,
    buildCategorySearchQuery: buildCategorySearchQuery,
    detectRecipeCuisines: detectRecipeCuisines,
    recipeCuisineMatchScore: recipeCuisineMatchScore,
    summarizeCuisineDistribution: summarizeCuisineDistribution
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
