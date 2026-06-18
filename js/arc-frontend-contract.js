/**
 * Arc frontend recipe contract — maps verbose / legacy pipeline fields to the
 * compact schema consumed by renderLibrary, renderPlanner, and recipe modals.
 *
 * Canonical render fields: cal, p, c, f, cat, ing, steps
 * Preserved passthrough: name, title, nutritionConfidence, servings, image, tags
 */
(function (global) {
  'use strict';

  var LOG_PREFIX = '[ARC CONTRACT]';

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function safeNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function normPhase(p) {
    var s = String(p || '').trim().toLowerCase();
    if (s === 'prep' || /^prep\b/.test(s)) return 'Prep';
    if (s === 'serve' || /^serve\b/.test(s) || /^plating\b/.test(s) || /^finish\b/.test(s)) return 'Serve';
    return 'Cook';
  }

  function normalizeStepsInput(steps, instructions) {
    var raw = [];
    if (Array.isArray(steps) && steps.length) raw = steps;
    else if (Array.isArray(instructions) && instructions.length) raw = instructions;

    if (!raw.length) return [];

    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var st = raw[i];
      if (typeof st === 'string') {
        var tx = st.trim();
        if (tx) out.push({ phase: 'Cook', instruction: tx });
      } else if (st && typeof st === 'object' && !Array.isArray(st)) {
        var ph = normPhase(st.phase);
        var ins = st.instruction != null ? String(st.instruction)
          : (st.text != null ? String(st.text) : (st.step != null ? String(st.step) : ''));
        ins = ins.trim();
        if (ins) out.push({ phase: ph, instruction: ins });
      }
    }
    return out;
  }

  function normalizeCategory(raw) {
    var catRaw = String(raw || '').toLowerCase();
    if (/breakfast/.test(catRaw)) return 'Breakfast';
    if (/dinner/.test(catRaw)) return 'Dinner';
    if (/snack/.test(catRaw)) return 'Snack';
    return 'Lunch';
  }

  function normalizeIngredientsInput(ing, ingredients) {
    var src = [];
    if (Array.isArray(ing) && ing.length) src = ing;
    else if (Array.isArray(ingredients) && ingredients.length) src = ingredients;
    return src.map(function (x) {
      if (typeof x === 'string') return x;
      if (!isPlainObject(x)) return '';
      return x.original || x.name || x.text || '';
    }).filter(Boolean);
  }

  function hadVerboseMacroFields(r) {
    return (r.calories != null || r.protein != null || r.carbs != null || r.fat != null) &&
      (r.cal == null && r.p == null && r.c == null && r.f == null);
  }

  function hadVerboseShapeFields(r) {
    return !!(r.category || r.mealCategory || r.mealType) ||
      (Array.isArray(r.ingredients) && !Array.isArray(r.ing)) ||
      (Array.isArray(r.instructions) && !Array.isArray(r.steps));
  }

  /**
   * Map verbose / legacy recipe payload → canonical frontend contract.
   * @param {object} recipe
   * @param {{ log?: boolean }} [opts]
   * @returns {object}
   */
  function adaptRecipeToFrontendContract(recipe, opts) {
    opts = opts || {};
    var r = isPlainObject(recipe) ? recipe : {};
    var macros = isPlainObject(r.macros) ? r.macros : {};
    var verboseMapped = hadVerboseMacroFields(r) || hadVerboseShapeFields(r);

    var cal = Math.round(safeNum(r.cal, safeNum(r.calories, safeNum(macros.calories, 0))));
    var p = Math.round(safeNum(r.p, safeNum(r.protein, safeNum(macros.protein, 0))));
    var c = Math.round(safeNum(r.c, safeNum(r.carbs, safeNum(macros.carbs, 0))));
    var f = Math.round(safeNum(r.f, safeNum(r.fat, safeNum(macros.fat, 0))));

    var cat = normalizeCategory(
      r.cat || r.category || r.mealCategory || r.mealType || r.slot || ''
    );

    var ing = normalizeIngredientsInput(r.ing, r.ingredients);
    var steps = normalizeStepsInput(r.steps, r.instructions);

    var out = {
      id: r.id,
      name: r.name || r.title || 'Recipe',
      title: r.title || r.name || 'Recipe',
      cal: cal,
      p: p,
      c: c,
      f: f,
      cat: cat,
      ing: ing,
      steps: steps,
      tags: Array.isArray(r.tags) ? r.tags.slice() : [],
      nutritionConfidence: r.nutritionConfidence || 'medium',
      nutritionVerified: r.nutritionVerified === true,
      nutritionSource: r.nutritionSource ? String(r.nutritionSource) : '',
      servings: Math.max(1, Math.round(safeNum(r.servings, 1))),
      image: r.image || r.imageUrl || r.photo || null,
      time: r.time || '20 min',
      difficulty: r.difficulty || 'Easy',
      price: safeNum(r.price, 6),
      ingQty: isPlainObject(r.ingQty) ? r.ingQty : {},
      spoonacularId: r.spoonacularId != null && r.spoonacularId !== '' ? r.spoonacularId : null,
      ingEdamam: Array.isArray(r.ingEdamam) ? r.ingEdamam.slice() : [],
      ingKeys: Array.isArray(r.ingKeys) ? r.ingKeys.slice() : []
    };

    if (verboseMapped && opts.log !== false) {
      console.log(LOG_PREFIX + ' Verbose payload mapped to canonical schema', {
        name: out.name,
        cal: out.cal,
        cat: out.cat
      });
    }

    if (opts.log !== false) {
      console.log(LOG_PREFIX + ' Recipe normalized successfully', { name: out.name, id: out.id });
    }

    return out;
  }

  /**
   * Ensure required render fields exist; apply safe defaults for partial payloads.
   * @param {object} recipe
   * @param {{ log?: boolean }} [opts]
   * @returns {object}
   */
  function validateFrontendRecipeContract(recipe, opts) {
    opts = opts || {};
    var rec = adaptRecipeToFrontendContract(recipe, opts);

    if (!isFinite(rec.cal)) rec.cal = 0;
    if (!isFinite(rec.p)) rec.p = 0;
    if (!isFinite(rec.c)) rec.c = 0;
    if (!isFinite(rec.f)) rec.f = 0;
    if (!rec.cat) rec.cat = 'Lunch';
    if (!Array.isArray(rec.ing)) rec.ing = [];
    if (!Array.isArray(rec.steps) || !rec.steps.length) {
      rec.steps = [{ phase: 'Cook', instruction: 'Prepare ingredients and cook until done.' }];
    }

    if (opts.log !== false) {
      console.log(LOG_PREFIX + ' Frontend render contract validated', {
        name: rec.name,
        cal: rec.cal,
        p: rec.p,
        cat: rec.cat,
        ingCount: rec.ing.length,
        stepsCount: rec.steps.length
      });
    }

    return rec;
  }

  /**
   * Normalize an array of recipes for render (week pipeline, library, planner).
   * @param {Array} recipesInput
   * @param {{ log?: boolean }} [opts]
   * @returns {Array}
   */
  function normalizeRecipesForRender(recipesInput, opts) {
    opts = opts || {};
    var src = Array.isArray(recipesInput) ? recipesInput : [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      if (!isPlainObject(src[i])) continue;
      out.push(validateFrontendRecipeContract(src[i], { log: opts.log }));
    }
    return out;
  }

  /**
   * Mutate global or scoped recipes array in place before renderLibrary / renderPlanner.
   * @param {Array} recipesRef
   * @returns {Array}
   */
  function ensureRecipesCanonicalBeforeRender(recipesRef) {
    if (!Array.isArray(recipesRef)) return [];
    var normalized = normalizeRecipesForRender(recipesRef, { log: false });
    for (var i = 0; i < recipesRef.length; i++) {
      if (normalized[i]) recipesRef[i] = normalized[i];
    }
    if (normalized.length !== recipesRef.length) {
      recipesRef.length = 0;
      for (var j = 0; j < normalized.length; j++) recipesRef.push(normalized[j]);
    }
    return recipesRef;
  }

  var api = {
    adaptRecipeToFrontendContract: adaptRecipeToFrontendContract,
    validateFrontendRecipeContract: validateFrontendRecipeContract,
    normalizeRecipesForRender: normalizeRecipesForRender,
    ensureRecipesCanonicalBeforeRender: ensureRecipesCanonicalBeforeRender
  };

  global.ArcFrontendContract = api;
})(typeof window !== 'undefined' ? window : globalThis);
