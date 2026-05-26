# Arc Nutrition Intelligence Engine (Phase 1)

Internal, modular nutrition layer for Arc. **No API integrations** in this phase — deterministic Arc logic only.

## Load order (browser)

```html
<script src="js/arc-engine/arcNutritionEngine.js"></script>
<script src="js/arc-engine/arcGoalEngine.js"></script>
<script src="js/arc-engine/arcAthleteEngine.js"></script>
<script src="js/arc-engine/arcMealOptimizer.js"></script>
<script src="js/arc-engine/arcBudgetEngine.js"></script>
<script src="js/arc-engine/arcPortionScaler.js"></script>
<script src="js/arc-engine/arcAdherenceEngine.js"></script>
<script src="js/arc-engine/arcEngine.js"></script>
```

## Usage

```javascript
var strategy = ArcEngine.run({
  goal: 'Gain weight',
  goalPace: 1,
  weight: 200,
  height: 70,
  age: 28,
  gender: 'male',
  activityLevel: 'Moderate',
  budgetTier: 'Moderate'
});
```

## Modules

| File | Namespace | Role |
|------|-----------|------|
| `arcNutritionEngine.js` | `ArcEngine.Nutrition` | Mifflin–St Jeor, macros |
| `arcGoalEngine.js` | `ArcEngine.Goal` | Onboarding → targets |
| `arcAthleteEngine.js` | `ArcEngine.Athlete` | Phase/day modifiers |
| `arcMealOptimizer.js` | `ArcEngine.MealOptimizer` | Meal strategy presets |
| `arcBudgetEngine.js` | `ArcEngine.Budget` | Grocery constraint tiers |
| `arcPortionScaler.js` | `ArcEngine.PortionScaler` | Recipe scaling |
| `arcAdherenceEngine.js` | `ArcEngine.Adherence` | Adherence + signals |
| `arcEngine.js` | `ArcEngine` | Orchestrator |

## Tests

```bash
npm run test:arc-engine
```

## API layer (separate)

External providers live in `js/arc-api/` (`ArcApi.Orchestrator`). Engine `integrations` reflects adapter status when API scripts are loaded.

- **Spoonacular** — recipes & discovery  
- **Edamam** — food/nutrition intelligence  
- **USDA** — verification  
- **OpenAI** — reasoning  
- **Kroger** — grocery data  

Arc Engine owns optimization; APIs supply information.
