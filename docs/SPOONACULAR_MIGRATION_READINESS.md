# Spoonacular Migration Readiness Report

> Pre-implementation review of the Spoonacular week-generation plan from [`SPOONACULAR_AUDIT.md`](SPOONACULAR_AUDIT.md).  
> **No code was modified.** Estimates are based on current codebase behavior and Spoonacular’s published quota model.

---

## Executive summary

| Dimension | Assessment |
|-----------|------------|
| **Technical readiness** | **Conditional go** — BFF routes exist; mapper layer required before calling `applyLibrary()` |
| **Risk to current week gen** | **Medium** — category assignment and dietary filtering are the main regressions |
| **Downstream compatibility** | **High** — `applyWeek` → nutrition → render path unchanged if mapper output matches today’s shape |
| **Quota impact** | **Low per user** (~4–6 Spoonacular points/week gen), **material at scale** on free tier |
| **Latency** | **Likely faster** for library step; total week time dominated by unchanged Edamam pipeline |
| **OpenAI savings** | **~4k–6k input tokens + ~1k–2k output tokens** removed per week generation (library step only) |

---

## 1. Estimates

### 1.1 API usage increase (Spoonacular)

**Current production week generation:** **0** Spoonacular calls from the browser.

**Proposed library step (minimal plan):**

| Call | Count per week gen | Typical params |
|------|-------------------|----------------|
| `POST /api/spoonacular/search` | **3–4** (one per meal category in `built.libraryTargets.perCat`) | `number: 2` per category |
| `POST /api/spoonacular/bulk` | **1** | `ids: [4–8 recipe IDs]` |

**Recipe count by meal pattern** (`computeWeekCoreLibraryTargets`):

| User slots | Categories | Recipes (`total`) |
|------------|------------|-------------------|
| 2 (Lunch + Dinner) | 2 | 4 |
| 3 (B + L + D) | 3 | 6 |
| 4 (+ Snack) | 4 | 8 |
| 5–6 meals | 4 (capped) | 8 max |

**Incremental Spoonacular usage:** **+4–5 HTTP requests** and **+4–8 recipe records** fetched per “Build my week” action.

**Not added by library swap (unchanged):**

- Edamam `/api/nutrition/pipeline` — still **4–8 calls** per week (concurrency 3)
- OpenAI `instruction_enhancement` — **0–N** on recipe modal open (likely **reduced** if bulk instructions map to `steps`)
- Kroger `/api/grocery/prices` — unchanged at shopping render

---

### 1.2 Spoonacular quota impact

Spoonacular bills by **daily points** ([pricing docs](https://spoonacular.com/food-api/pricing)): typically **~1 point per request + ~0.01 points per result** (exact costs vary by endpoint).

**Rough estimate per week generation:**

| Component | Points (estimate) |
|-----------|-------------------|
| 3× search, 2 results each | 3 × (1 + 0.02) ≈ **3.06** |
| 1× bulk, 6 recipes | 1 + 0.06 ≈ **1.06** |
| **Total** | **~4–5 points** |

**Plan capacity (approximate daily week-gens before quota exhaustion):**

| Plan | Daily points | ~Week gens/day |
|------|-------------|----------------|
| Free | 50 | ~10–12 |
| Cook ($29) | 1,500 | ~300+ |
| Culinarian ($79) | 4,500 | ~900+ |

**Scale note:** 100 active users × 2 week builds/day ≈ **800–1000 points/day** — requires Cook tier or higher.

**Compliance note (ToS):** Spoonacular permits indefinite storage of **recipe id, title, image URL only**. **Ingredients, instructions, and nutrition from API responses must not be cached long-term** outside live app use ([API terms](https://spoonacular.com/food-api/terms)). Persisting `UP.weeklyPlan` / `localStorage` recipes with full Spoonacular content may violate terms unless re-fetched or user-owned.

---

### 1.3 OpenAI token reduction

**Removed call:** `callAIWithRetry(..., 2000, applyLibrary, 2, 'week_recipe_library')`

| Token bucket | Current (library step) | After migration |
|--------------|------------------------|-----------------|
| **Input** | `sysMsg` (~150 tokens) + `userMsg` from `appendWeekUserContextBlock` — often **2,500–4,000+ tokens** (debug log truncates at 12,000 chars) | **0** |
| **Output cap** | **2,000** tokens (`openAiTaskTokenLimit('week_recipe_library')`) | **0** |
| **Typical output** | JSON for 4–8 recipes ≈ **800–1,500** tokens | **0** |

**Estimated savings per week generation:** **~4,000–6,000 input tokens** and **~1,000–2,000 output tokens**.

**Not eliminated:**

| Call | When | Tokens (approx) |
|------|------|-----------------|
| `instruction_enhancement` | Modal open if `steps.length ≤ 2` | ~250 out + ~100 in per recipe viewed |
| `optimization` / other | Elsewhere in app | Unchanged |

If bulk instructions produce **≥3 steps**, modal lazy-fetch is skipped → **additional OpenAI savings at UX time** (~250 tokens × recipes opened).

**Net:** **~70–85% reduction** in OpenAI usage attributable to week build; **~40–60%** of total week-path tokens if users open many recipe modals.

---

### 1.4 Expected week generation latency

**Current phases** (`generateWeeklyPlan`):

```
recipes → [OpenAI library] → balancing → [ArcNutritionPipeline] → recipes → grocery → finalize
```

| Phase | Current dominant cost | Expected after migration |
|-------|----------------------|--------------------------|
| **Library** | OpenAI LLM: **5–40 s** typical (server timeout up to **120 s** for `week_recipe_library`) | Spoonacular: **1–4 s** (3–4 parallel searches + 1 bulk) |
| **Balancing / nutrition** | `verifyRecipes` × 4–8, concurrency 3: **4–15 s** | **Unchanged** |
| **Render / finalize** | **<1 s** | **Unchanged** |

**Estimated end-to-end:**

| Metric | Current | After migration |
|--------|---------|-----------------|
| Library step | 5–40 s | 1–4 s |
| Full week gen (incl. nutrition) | **10–55 s** | **6–20 s** |
| P95 failure mode | OpenAI parse/timeout | Spoonacular 503/402 quota, empty search |

**Critical path unchanged:** Edamam + USDA pipeline remains the slowest consistent phase.

---

## 2. Risks to current working week generation

### 2.1 High severity

| Risk | Why | Mitigation |
|------|-----|------------|
| **Missing or wrong `cat`** | `buildDeterministicWeekMealPlan` buckets by `r.cat`. Spoonacular bulk has no category. Default contract mapping → **`Lunch` for all** → breakfast/dinner slots pull wrong pool or fallback to full library rotation | Set `cat` from **search bucket** when mapping; never rely on `dishTypes` alone |
| **`SPOONACULAR_API_KEY` unset** | BFF returns **503**; no fallback to OpenAI in minimal plan | Feature flag + OpenAI fallback path, or block with clear toast |
| **Dietary compliance gap** | OpenAI prompt includes `buildMandatoryDietPrompt` (vegan, allergens, dislikes). Spoonacular only supports **`diet` search param** ( coarse: vegan, vegetarian, etc.) | Map restrictions to Spoonacular `diet`; post-filter by dislikes; keep OpenAI as fallback for strict profiles |
| **Search returns < 4 recipes** | `applyLibrary` hard-fails: *"Core library must include at least 4 recipes"* | Over-fetch (`number: 3`), merge/dedupe IDs, or lower minimum for 2-meal profiles |
| **Duplicate IDs across category searches** | Same recipe in Breakfast + Dinner buckets → reduced library diversity | Dedupe by Spoonacular `id` before bulk |

### 2.2 Medium severity

| Risk | Why | Mitigation |
|------|-----|------------|
| **Ingredient mismatch for Edamam** | Spoonacular `original` lines may differ from OpenAI’s compact lists | Usually fine for Edamam; monitor pipeline failure rate |
| **Missing `ingQty`** | If mapper only passes `ingredients[]` objects without building `ingQty`, modal shows **"—"** for quantities | Build `ingQty` from `amount` + `unit` + `name` |
| **Missing `price`** | Defaults to **$6.00** in `normalizeGeneratedRecipe` | Accept default or derive from search `maxPrice` filter |
| **ToS caching** | Saving full recipes to `localStorage`/Supabase | Store `spoonacularId` + title + image; re-fetch detail on load, or document as session-only |
| **No shared-ingredient optimization** | OpenAI prompt asks to share ingredients across library; Spoonacular search does not | Grocery list may grow; optional curation pass later |

### 2.3 Low severity

| Risk | Why |
|------|-----|
| **`spoonacularId` not preserved** | Nutrition Spoonacular fallback still broken (pre-existing); Edamam path unaffected |
| **`difficulty` missing** | Defaults to **`Easy`** in contract |
| **`time` format** | Defaults **`20 min`** unless mapper sets `(readyInMinutes) + ' min'` |
| **Images** | New capability; render paths ignore `image` today — no break |

---

## 3. Schema analysis

### 3.1 What `applyLibrary()` actually requires

`applyLibrary(err, raw, meta)` does **not** read fields directly. It passes through:

1. **`parseAiObject(err, raw, meta)`** — rejects only `meta.source === 'enhancement'`; accepts **plain object** `raw` without JSON parsing
2. Requires **`raw.recipes`** non-empty array
3. Per recipe (minimal, before `applyWeek`):

```javascript
// After parseAiObject — applyLibrary maps each item:
{
  id: number,           // optional; reassigned to index+1 if missing
  name: string,         // required for display; fallback "Recipe N"
  // All other fields pass through arcAdaptRecipeForRender to applyWeek
}
```

**OpenAI prompt schema** (what the model is told to produce — **`applyLibrary` does not validate these**):

```javascript
{
  "recipes": [{
    "id": 1,
    "name": "Italian Omelette",
    "cat": "Breakfast",           // REQUIRED for meal assignment
    "cal": 380, "p": 28, "c": 12, "f": 22,
    "servings": 2,
    "ing": ["Eggs", "Spinach", "Cheese"],
    "ingQty": { "Eggs": "3 large" },
    "price": 4.5
    // steps explicitly excluded from week prompt
  }]
}
```

**Effective schema after `applyLibrary` + `arcAdaptRecipeForRender`:**

```javascript
{
  id: 1,
  name: "Italian Omelette",
  title: "Italian Oomelette",
  cat: "Breakfast",
  cal: 380, p: 28, c: 12, f: 28,
  ing: ["Eggs", "Spinach", "Cheese"],
  ingQty: { "Eggs": "3 large" },
  steps: [{ phase: "Cook", instruction: "..." }],  // placeholder if empty
  servings: 2,
  price: 4.5,
  time: "20 min",
  difficulty: "Easy",
  tags: [],
  nutritionConfidence: "medium",
  image: null
}
```

---

### 3.2 What Spoonacular bulk returns (BFF shape)

`POST /api/spoonacular/bulk` response from `server.js`:

```javascript
{
  "recipes": [{
    "id": 716429,                    // Spoonacular ID
    "recipeId": 716429,
    "title": "Beef Stir-Fry",
    "image": "https://spoonacular.com/...",
    "servings": 4,
    "readyInMinutes": 25,
    "prepTime": 25,
    "extendedIngredients": [         // raw upstream objects
      { "name": "beef", "amount": 8, "unit": "oz", "original": "8 oz beef sirloin", ... }
    ],
    "ingredients": [
      { "name": "beef", "original": "8 oz beef sirloin", "amount": 8, "unit": "oz" }
    ],
    "tags": ["gluten free", "dinner", "Asian"],
    "instructions": [                  // string[] — step text only
      "Slice the beef thinly...",
      "Heat oil in a wok..."
    ],
    "nutrition": { "calories": 520, "protein": 42, "carbs": 28, "fat": 22 },  // if includeNutrition
    "calories": 520,
    "protein": 42,
    "carbs": 28,
    "fat": 22
  }],
  "instructions": {
    "716429": ["Slice the beef thinly...", "..."]
  }
}
```

**Not present:** `name`, `cat`, `ing`, `ingQty`, `steps`, `price`, `difficulty`, `time` (as string), local `id`.

---

### 3.3 Mapping table (Spoonacular bulk → `applyLibrary` input)

| Target field (`applyLibrary` / contract) | Spoonacular source | Transform required | If unmapped |
|------------------------------------------|-------------------|--------------------|-------------|
| `recipes[]` wrapper | `bulk.recipes` | Wrap array | **Fail** — no library |
| `id` | — | **Assign** local `1…N` (do not use Spoonacular ID as plan ID) | Reassigned in `applyLibrary` |
| `spoonacularId` | `recipeId` / `id` | **Passthrough** (not in contract today; add for fallback fix) | Fallback stays broken |
| `name` | `title` | Copy | Falls back to `"Recipe N"` |
| `cat` | — | **Must set** from search bucket (`Breakfast`, `Lunch`, …) | **Defaults `Lunch`** → assignment broken |
| `cal` | `calories` or `nutrition.calories` | Optional; pipeline overwrites | `0` → filled in `normalizeGeneratedRecipe` from slot targets |
| `p` | `protein` | Optional | Same |
| `c` | `carbs` | Optional | Same |
| `f` | `fat` | Optional | Same |
| `servings` | `servings` | Copy | Default `1` |
| `ing` | `ingredients[].name` or `original` | Map array to strings | **Empty** → pipeline skips verify |
| `ingQty` | `amount` + `unit` + `name` | Build `{ "beef": "8 oz" }` keyed to `ing` names | Modal shows **"—"** |
| `steps` | `instructions[]` | Map to `{ phase: "Cook", instruction: text }[]` | Placeholder → triggers OpenAI `fetchSteps` |
| `price` | — | Default `6.0` or search `maxPrice` heuristic | **$6.00/serving** |
| `time` | `readyInMinutes` | `String(min) + ' min'` | **"20 min"** |
| `difficulty` | — | Default `"Easy"` | **"Easy"** |
| `tags` | `tags` | Copy | `[]` |
| `image` | `image` | Copy | `null` |

**Pass-through to `ArcFrontendContract` without mapper (bulk item dropped directly into `recipes`):**

| Contract field | Auto-maps? | Result |
|----------------|------------|--------|
| `name` ← `title` | Yes | OK |
| `ing` ← `ingredients` | Yes (objects → `original`/`name`) | OK |
| `ingQty` | **No** | Empty |
| `cat` | **No** | **All `Lunch`** |
| `steps` ← `instructions` | Yes (strings → Cook phase) | OK if non-empty |
| `cal/p/c/f` ← `calories/protein/...` | Yes if `includeNutrition: true` | OK |

**Conclusion:** A **mapper function is mandatory** — not for `applyLibrary`’s outer shape, but for **`cat`**, **`ingQty`**, local **`id`**, and optionally **`time`** / **`spoonacularId`**.

---

## 4. Downstream component compatibility

### 4.1 Will these continue working unchanged?

| Component | Code changes needed? | Works if mapper correct? | Notes |
|-----------|---------------------|--------------------------|-------|
| **`buildDeterministicWeekMealPlan`** | **No** | **Yes** | Requires correct `cat` on each recipe; uses local `id` for plan slots |
| **`normalizeWeekPayloadContract`** | **No** | **Yes** | Operates on `{ recipes, plan }` from deterministic builder |
| **`normalizeGeneratedRecipe`** | **No** | **Yes** | Fills missing macros from `built.mt` category targets; preserves mapped fields |
| **`ArcNutritionPipeline.verifyRecipes`** | **No** | **Yes** | Needs non-empty `ing`; benefits from `ingQty`; overwrites macros |
| **`finishWeekPlanAfterNutrition`** | **No** | **Yes** | Assigns `mealPlan`, `UP.weeklyPlan` |
| **`renderLibrary`** | **No** | **Yes** | Reads `name`, `cal`, `p`, `c`, `f`, `price`, `time`, `difficulty`, `cat` |
| **`renderPlanner`** | **No** | **Yes** | Sums `mr.cal`, `mr.price` via `findRecipe(id)` |
| **Recipe modal (`openRM`)** | **No** | **Mostly yes** | Ingredients from `ing`/`ingQty`; steps from `stepCache` or `fetchSteps` |

**Verdict:** **All listed components can remain unchanged** provided the Spoonacular→library mapper emits the same effective shape OpenAI produces today. No changes required inside `applyWeek`, nutrition pipeline, or render functions for a minimal migration.

### 4.2 Behavioral differences (not code breaks)

| Area | Change |
|------|--------|
| **Recipe modal steps** | Bulk often provides **5+ instructions** → `fetchSteps` skipped → **no OpenAI on view** (improvement) |
| **Ingredient count** | Spoonacular recipes may have **10–15+ ingredients** vs OpenAI max 6 → richer modal, heavier grocery aggregation |
| **Library diversity** | Catalog recipes vs personalized AI names — may feel less “custom” but more consistent |
| **Macro display** | Still **Edamam+USDA** after verify — Spoonacular nutrition at bulk stage is discarded if pipeline succeeds |
| **Price display** | Less accurate unless separate pricing strategy added |

---

## 5. Migration readiness checklist

### Ready today (no code)

- [x] BFF routes `POST /api/spoonacular/search` and `/bulk` implemented
- [x] `applyLibrary` accepts arbitrary object `{ recipes: [...] }` via `parseAiObject`
- [x] `ArcFrontendContract` partial auto-mapping from Spoonacular field names
- [x] Downstream week pipeline decoupled from OpenAI at `applyWeek` boundary

### Required before ship (code)

- [ ] **`mapSpoonacularBulkToWeekLibrary(bulk, categoryByRecipeId)`** helper
- [ ] Replace `callAIWithRetry(..., 'week_recipe_library')` with Spoonacular fetch + mapper
- [ ] **`cat` assignment** from per-category search (critical)
- [ ] **`ingQty` construction** from `extendedIngredients`
- [ ] **`spoonacularId` preservation** through `normalizeGeneratedRecipe` (recommended)
- [ ] **OpenAI fallback** when Spoonacular 503/402/empty results
- [ ] **Dedupe** Spoonacular IDs across category searches
- [ ] **Diet restriction mapping** (`UP.restrictions` → search `diet` param)

### Recommended before production scale

- [ ] Quota monitoring via Spoonacular response headers (`X-API-Quota-Left`)
- [ ] ToS-compliant persistence strategy (id/title/image only in cloud)
- [ ] Integration test: mocked `/api/spoonacular/*` → full `generateWeeklyPlan` path
- [ ] Compare Edamam verify success rate: OpenAI vs Spoonacular ingredient lines

---

## 6. Go / no-go recommendation

| Criteria | Status |
|----------|--------|
| API infrastructure | **Go** |
| Schema compatibility with mapper | **Go** |
| Zero-change downstream render path | **Go** |
| Dietary personalization parity | **No-go without fallback** |
| Free-tier quota at scale | **No-go for production traffic** without paid plan |
| Legal/cache compliance | **Review required** before persisting Spoonacular body content |

**Recommendation:** Proceed with **Phase 1 minimal swap** behind a feature flag, **keep OpenAI library as fallback**, and **do not ship** until `cat` + `ingQty` mapper is tested against `buildDeterministicWeekMealPlan` and `ArcNutritionPipeline`.

---

## 7. Reference: call boundary

The smallest swap point remains **`index.html` ~10550**:

```javascript
// Current
callAIWithRetry(built.sysMsg, built.userMsg, 2000, applyLibrary, 2, 'week_recipe_library');

// Proposed (pseudocode — not implemented)
fetchSpoonacularWeekLibrary(built, function (err, payload, meta) {
  applyLibrary(err, payload, meta);
});
```

Everything from **`buildDeterministicWeekMealPlan(weekLibraryRecipes, built.slots)`** onward can remain **byte-identical** if the mapper output matches the OpenAI library shape.

---

*Generated from static codebase analysis. No production code was modified.*
