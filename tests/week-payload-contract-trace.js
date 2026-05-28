/**
 * Full live-style week payload contract trace (read-only diagnostic).
 * Run: node tests/week-payload-contract-trace.js
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'Index1.html');
const CONTRACT_JS = path.join(ROOT, 'js', 'arc-frontend-contract.js');
const LOOSE = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'canonical-week-loose.json'), 'utf8'));
const CANONICAL = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'canonical-week-frontend-contract.json'), 'utf8'));

const CANONICAL_RENDER_FIELDS = ['cal', 'p', 'c', 'f', 'cat', 'ing', 'steps'];
const VERBOSE_FIELDS = ['calories', 'protein', 'carbs', 'fat', 'category', 'ingredients', 'instructions'];

function sliceLines(start, end) {
  return readFileSync(INDEX, 'utf8').split('\n').slice(start - 1, end).join('\n');
}

function loadSandbox() {
  const sandbox = { console, window: null, UP: { meals: '3' }, recipes: [] };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(CONTRACT_JS, 'utf8'), ctx, { filename: 'arc-frontend-contract.js' });
  const chunks = [
    sliceLines(2616, 2686),
    sliceLines(2761, 3036),
    sliceLines(6478, 6537)
  ];
  for (const src of chunks) vm.runInContext(src, ctx);
  return sandbox;
}

function keysOf(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

function pickRecipeShape(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {};
  const allKeys = keysOf(r);
  for (const k of allKeys) {
    if (k === 'ing' || k === 'ingredients') out[k] = Array.isArray(r[k]) ? r[k].slice(0, 3) : r[k];
    else if (k === 'steps' || k === 'instructions') {
      const arr = Array.isArray(r[k]) ? r[k] : [];
      out[k] = arr.slice(0, 2).map((s) =>
        typeof s === 'string' ? s : { phase: s.phase, instruction: String(s.instruction || '').slice(0, 60) }
      );
    } else if (k === 'macros' && r[k]) out[k] = r[k];
    else if (typeof r[k] === 'object' && r[k] !== null) out[k] = '[object]';
    else out[k] = r[k];
  }
  return out;
}

function auditCanonical(stageName, recipe, opts) {
  opts = opts || {};
  const missing = [];
  const present = [];
  const violations = [];

  for (const f of CANONICAL_RENDER_FIELDS) {
    if (f === 'ing' || f === 'steps') {
      if (!Array.isArray(recipe[f]) || !recipe[f].length) missing.push(f);
      else present.push(f);
    } else if (recipe[f] == null || (typeof recipe[f] === 'number' && !isFinite(recipe[f]))) {
      missing.push(f);
    } else {
      present.push(f);
    }
  }

  if (opts.checkZeros) {
    if (recipe.cal === 0 && (recipe.calories > 0 || recipe.macros?.calories > 0)) {
      violations.push('macros_zero_despite_verbose_or_macros_object');
    }
    if (recipe.p === 0 && (recipe.protein > 0 || recipe.macros?.protein > 0)) {
      violations.push('protein_zero_despite_verbose');
    }
  }

  const verbosePresent = VERBOSE_FIELDS.filter((k) => recipe[k] != null);
  const canonicalPresent = CANONICAL_RENDER_FIELDS.filter((k) => recipe[k] != null);

  return {
    stage: stageName,
    keys: keysOf(recipe),
    presentCanonical: present,
    missingCanonical: missing,
    verboseFieldsStillPresent: verbosePresent,
    canonicalFieldsPresent: canonicalPresent,
    contractValid: missing.length === 0,
    violations
  };
}

/** Mirrors callAI → applyWeek entry: enhancement text vs canonical_backend object */
function simulateCallAiDispatch(backendBody) {
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }
  function hasCanonicalSchemaShape(v) {
    if (!isPlainObject(v)) return false;
    if (v.schema && isPlainObject(v.schema) && String(v.schema.owner || '').toLowerCase() === 'arc_backend') return true;
    if (isPlainObject(v.canonicalMeal) || Array.isArray(v.meals)) return true;
    if (Array.isArray(v.recipes) || isPlainObject(v.plan) || isPlainObject(v.meal_plan)) return true;
    if (isPlainObject(v.week) || isPlainObject(v.data)) return true;
    return false;
  }
  function extractAiResponseText(data) {
    if (!data || data.content == null) return '';
    const c = data.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c) || !c.length) return '';
    return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
  }

  function hasWeekGenerationSchemaShape(v) {
    if (!isPlainObject(v)) return false;
    return Array.isArray(v.recipes) && isPlainObject(v.plan);
  }

  if (hasCanonicalSchemaShape(backendBody)) {
    return { source: 'canonical_backend', raw: backendBody, dispatchNote: 'Object passed through without text extraction' };
  }
  const text = extractAiResponseText(backendBody).trim();
  if (text && backendBody && backendBody.content != null) {
    let nestedParsed = null;
    try {
      nestedParsed = JSON.parse(text);
    } catch (_) {
      nestedParsed = null;
    }
    if (nestedParsed && hasWeekGenerationSchemaShape(nestedParsed)) {
      return {
        source: 'week_generation',
        raw: nestedParsed,
        dispatchNote: 'Nested week JSON in content[].text — classified as week_generation'
      };
    }
  }
  return { source: 'enhancement', raw: text, dispatchNote: 'content[].text extracted — not a valid week schema' };
}

function simulatePreAdapterNormalizeGeneratedRecipe(r, i, mt) {
  const cat = r.cat || r.mealType || r.category || 'Lunch';
  const macros = r.macros && typeof r.macros === 'object' ? r.macros : {};
  function num(v, fb) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  const t = mt.Lunch;
  return {
    id: i + 1,
    name: r.name || r.title || 'Recipe',
    cal: Math.round(num(r.cal, num(macros.calories, t.cal))),
    p: Math.round(num(r.p, num(macros.protein, t.p))),
    c: Math.round(num(r.c, num(macros.carbs, t.c))),
    f: Math.round(num(r.f, num(macros.fat, t.f))),
    cat,
    ing: Array.isArray(r.ing) ? r.ing : [],
    steps: Array.isArray(r.steps) ? r.steps : []
  };
}

function buildMealTargets() {
  const per = { cal: 667, p: 50, c: 67, f: 22 };
  return { Breakfast: per, Lunch: per, Dinner: per, Snack: per, Lunch: per };
}

function printStage(n, label, recipe, audit, extra) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`STAGE ${n}: ${label}`);
  console.log('='.repeat(72));
  console.log(JSON.stringify(pickRecipeShape(recipe), null, 2));
  console.log('\n--- audit ---');
  console.log(JSON.stringify(audit, null, 2));
  if (extra) console.log('\n--- notes ---\n' + extra);
}

function traceVerboseWeekRecipe() {
  const S = loadSandbox();
  const slots = ['Breakfast', 'Lunch', 'Dinner'];
  const mt = buildMealTargets();
  const verboseRecipe = LOOSE.recipes[0];
  const weekJson = { recipes: [verboseRecipe], plan: {} };

  const liveBackendEnvelope = {
    content: [{ type: 'text', text: JSON.stringify(weekJson) }]
  };

  const dispatch = simulateCallAiDispatch(liveBackendEnvelope);
  const stage1Recipe = verboseRecipe;

  printStage(
    1,
    'Raw backend response (live /api/ai envelope → first recipe after dispatch)',
    stage1Recipe,
    auditCanonical('STAGE 1', stage1Recipe, { checkZeros: true }),
    [
      `HTTP body keys: ${keysOf(liveBackendEnvelope).join(', ')}`,
      `callAI dispatch: source=${dispatch.source}`,
      dispatch.dispatchNote,
      dispatch.source === 'enhancement'
        ? 'applyWeek sets err: Enhancement payload cannot be used as canonical week schema — pipeline STOPS before parse if meta.source=enhancement'
        : dispatch.source === 'week_generation'
          ? 'Nested week in content[].text — applyWeek proceeds (meta.source=week_generation)'
          : 'Would pass to parseJSON as object or string'
    ].join('\n')
  );

  let parsed = null;
  let parseNote = '';
  if (dispatch.source === 'enhancement') {
    parsed = S.parseJSON(dispatch.raw);
    parseNote = 'parseJSON on extracted AI text string';
  } else {
    parseNote =
      dispatch.source === 'week_generation'
        ? 'week_generation nested object — parseJSON in applyWeek'
        : 'canonical_backend object — parseJSON in applyWeek';
    parsed = S.parseJSON(dispatch.raw);
  }

  const stage2Recipe = parsed?.recipes?.[0] || null;
  printStage(
    2,
    `Post-parseJSON payload (${parseNote})`,
    stage2Recipe,
    auditCanonical('STAGE 2', stage2Recipe, { checkZeros: true }),
    [
      'parseJSON does NOT rename fields — verbose keys preserved verbatim',
      'Missing canonical: cal,p,c,f,cat,ing,steps — renderer reads these directly',
      `Has verbose: ${VERBOSE_FIELDS.filter((k) => stage2Recipe?.[k] != null).join(', ')}`
    ].join('\n')
  );

  const normalized = S.normalizeWeekPayloadContract(parsed, slots);
  const stage3Recipe = normalized?.recipes?.[0] || null;
  printStage(
    3,
    'Post-normalizeWeekPayloadContract (arcAdaptRecipeForRender inside)',
    stage3Recipe,
    auditCanonical('STAGE 3', stage3Recipe, { checkZeros: true }),
    [
      'arc-frontend-contract maps calories→cal, protein→p, category→cat, ingredients→ing, instructions→steps',
      'Verbose keys may still exist on object if they were copied — adapter output is canonical-only shape'
    ].join('\n')
  );

  let stage4Recipe = S.arcNormalizeRecipesForRender(normalized.recipes, { log: false })
    .map((r, i) => S.normalizeGeneratedRecipe(r, i, mt))[0];
  printStage(
    4,
    'Pre-render payload (arcNormalizeRecipesForRender → normalizeGeneratedRecipe)',
    stage4Recipe,
    auditCanonical('STAGE 4', stage4Recipe, { checkZeros: true }),
    'This is what gets assigned to global recipes[] before finishWeekPlanAfterNutrition'
  );

  S.recipes = [stage4Recipe];
  S.arcEnsureRecipesCanonicalBeforeRender();
  const stage5Recipe = S.recipes[0];
  printStage(
    5,
    'Payload entering renderLibrary / renderPlanner (after arcEnsureRecipesCanonicalBeforeRender)',
    stage5Recipe,
    auditCanonical('STAGE 5', stage5Recipe, { checkZeros: true }),
    'renderLibrary reads r.cal, r.p, r.c, r.f, r.cat, r.ing — renderPlanner sums mr.cal for day totals'
  );

  const legacyPreAdapter = simulatePreAdapterNormalizeGeneratedRecipe(stage2Recipe, 0, mt);
  console.log(`\n${'='.repeat(72)}`);
  console.log('COMPARISON: Pre-adapter normalizeGeneratedRecipe (historical bug path)');
  console.log('='.repeat(72));
  console.log(JSON.stringify(pickRecipeShape(legacyPreAdapter), null, 2));
  console.log(JSON.stringify(auditCanonical('LEGACY', legacyPreAdapter, { checkZeros: true }), null, 2));
}

function traceOrchestratorVerboseRecipe() {
  const orchestratorRecipe = {
    recipeId: 42,
    title: 'Chicken rice bowl',
    name: 'Chicken rice bowl',
    servings: 2,
    calories: 650,
    protein: 52,
    carbs: 60,
    fat: 18,
    nutritionConfidence: 'medium',
    ingredients: [
      { name: 'chicken', original: '6 oz chicken breast' },
      { name: 'rice', original: '1 cup cooked rice' }
    ],
    instructions: ['Cook chicken.', 'Serve over rice.'],
    nutrition: { calories: 650, protein: 52, carbs: 60, fat: 18 }
  };

  const backendAsCanonicalBackend = {
    schema: { owner: 'arc_backend', version: '1.0.0' },
    recipes: [orchestratorRecipe],
    plan: { Mon: { Lunch: 42 } }
  };

  console.log(`\n\n${'#'.repeat(72)}`);
  console.log('# TRACE B: Orchestrator-style verbose recipe via canonical_backend dispatch');
  console.log('#'.repeat(72));

  const dispatch = simulateCallAiDispatch(backendAsCanonicalBackend);
  console.log('\nDispatch:', dispatch.source, '—', dispatch.dispatchNote);

  const S = loadSandbox();
  const parsed = S.parseJSON(dispatch.raw);
  const stage2 = parsed?.recipes?.[0];
  const norm = S.normalizeWeekPayloadContract(parsed, ['Lunch']);
  const stage3 = norm?.recipes?.[0];

  printStage(1, 'Raw orchestrator recipe object (in recipes[0])', orchestratorRecipe,
    auditCanonical('ORCH-1', orchestratorRecipe, { checkZeros: true }),
    'Provider pipeline sets calories/protein/carbs/fat on recipe — NOT cal/p/c/f');

  printStage(2, 'After parseJSON on canonical_backend object', stage2,
    auditCanonical('ORCH-2', stage2, { checkZeros: true }), 'Fields unchanged by parseJSON');

  printStage(3, 'After normalizeWeekPayloadContract', stage3,
    auditCanonical('ORCH-3', stage3, { checkZeros: true }), 'Adapter maps to frontend contract');
}

function printContractMatrix() {
  console.log(`\n\n${'#'.repeat(72)}`);
  console.log('# CONTRACT VIOLATION MATRIX (by stage)');
  console.log('#'.repeat(72));
  const rows = [
    ['Stage', 'cal', 'p', 'cat', 'ing', 'steps', 'Typical failure mode'],
    ['1 Raw AI/recipe JSON', 'MISS', 'MISS', 'MISS*', 'MISS*', 'MISS*', '*verbose: category, ingredients, instructions'],
    ['2 parseJSON', 'MISS', 'MISS', 'MISS', 'MISS', 'MISS', 'No transformation'],
    ['3 normalizeWeekPayloadContract', 'OK', 'OK', 'OK', 'OK', 'OK', 'arc-frontend-contract adapter'],
    ['4 normalizeGeneratedRecipe', 'OK', 'OK', 'OK', 'OK', 'OK', 'Uses canonical fields from stage 3'],
    ['5 renderLibrary/planner', 'OK', 'OK', 'OK', 'OK', 'OK', 'ensureRecipesCanonicalBeforeRender guard'],
    ['LEGACY (no adapter)', 'ZERO', 'ZERO', 'partial', 'EMPTY', 'EMPTY', 'Only read cal/p/ing/steps — ignored calories/protein']
  ];
  for (const r of rows) console.log(r.map((c) => String(c).padEnd(22)).join(''));
}

console.log('WEEK PAYLOAD CONTRACT TRACE — verbose live-style recipe (canonical-week-loose fixture)');
traceVerboseWeekRecipe();
traceOrchestratorVerboseRecipe();
printContractMatrix();

console.log('\n\nPrompt-expected canonical example (reference):');
console.log(JSON.stringify(pickRecipeShape(CANONICAL.recipes[0]), null, 2));
