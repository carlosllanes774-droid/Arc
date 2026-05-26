# Arc API Layer (Phase 2)

External **information** providers. Arc Engine (`js/arc-engine/`) owns intelligence, targets, optimization, validation decisions, and execution.

## Load order

```html
<script src="js/config/apiConfig.js"></script>
<script src="js/arc-api/arcCache.js"></script>
<script src="js/arc-api/arcRateLimit.js"></script>
<script src="js/arc-api/arcTrace.js"></script>
<script src="js/arc-api/providers/providerBase.js"></script>
<script src="js/arc-api/spoonacularService.js"></script>
<script src="js/arc-api/edamamService.js"></script>
<script src="js/arc-api/usdaService.js"></script>
<script src="js/arc-api/krogerService.js"></script>
<script src="js/arc-api/openaiService.js"></script>
<script src="js/arc-api/arcValidationService.js"></script>
<script src="js/arc-api/providers/spoonacularProvider.js"></script>
<script src="js/arc-api/providers/edamamProvider.js"></script>
<script src="js/arc-api/providers/usdaProvider.js"></script>
<script src="js/arc-api/providers/openaiProvider.js"></script>
<script src="js/arc-api/providers/krogerProvider.js"></script>
<script src="js/arc-api/apiOrchestrator.js"></script>
```

Optional (before API scripts):

```html
<script>window.ARC_API = { baseUrl: '' };</script>
```

Arc Engine scripts load separately; orchestrator calls `ArcEngine.run()` inside `runAdaptiveMealPipeline`.

## Architecture

| Layer | Role |
|-------|------|
| **Arc Engine** | Targets, meal strategy, portion scaling, adherence |
| **Services** (`*Service.js`) | Provider API calls via server proxy |
| **Providers** (`providers/`) | Thin adapters for orchestrator dispatch |
| **Validation** | `arcValidationService.js` — catch bad data before UI |
| **Orchestrator** | Routing + `runAdaptiveMealPipeline` |

## Provider responsibilities

| Provider | Provides | Does not |
|----------|----------|----------|
| **Spoonacular** | Recipes, metadata, discovery | Macro truth, targets |
| **Edamam** | Parsing, food understanding, recipe nutrition, diet labels | Goal strategy, scaling |
| **USDA** | Verification, macro validation, source of truth | Recipes, pricing |
| **OpenAI** | Adaptation / optimization reasoning | Meals, macro truth |
| **Kroger** | Pricing, availability, substitutions | Nutrition analysis |
| **Supabase** | Memory / storage (via `arc-backend.js`) | Intelligence |

## Adaptive pipeline

```javascript
ArcApi.Orchestrator.runAdaptiveMealPipeline({
  goal: 'Gain weight',
  goalPace: 1,
  weight: 200,
  height: 70,
  age: 28,
  gender: 'male',
  activityLevel: 'Moderate',
  mealQuery: 'high protein dinner',
  zipCode: '90210',
  foodLogText: 'I ate tacos',  // off-plan
  scenario: 'off_plan'
});
```

Flow: Arc Engine → Spoonacular → Edamam → USDA → Validation → OpenAI → Kroger → Portion Scaling.

## Server proxies (credentials server-side only)

Configure `.env` from `.env.example`. Start with `node server.js`.

| Endpoint | Provider |
|----------|----------|
| `GET /api/config/status` | Config health (no secrets) |
| `POST /api/spoonacular/search` | Spoonacular |
| `POST /api/spoonacular/bulk` | Spoonacular |
| `POST /api/nutrition` | Edamam |
| `POST /api/edamam/parse` | Edamam |
| `GET /api/usda/search` | USDA |
| `GET /api/usda/food/:fdcId` | USDA |
| `POST /api/ai` | OpenAI |
| `POST /api/kroger/prices` | Kroger |

## Tests

```bash
npm run test:arc-api
```

## Boundary

```
External APIs → facts (recipes, nutrients, prices, reasoning)
Arc Engine      → strategy (targets, meals, adherence, scaling)
Arc Validation  → trust layer before user-facing output
```
