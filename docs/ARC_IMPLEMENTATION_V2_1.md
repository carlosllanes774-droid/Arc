# Arc Implementation Specification V2.1

**Status:** Canonical engineering build spec  
**Authority:** Constitution V1, Recovery Capacity Framework V1, Decision Engine V1  
**Supersedes:** Implementation Specification V2 (agent transcript)  
**Primary file:** `index.html` — extraction deferred until post-ship

---

## 1. Purpose

Ship the accepted Arc experience with the fewest moving parts. V2.1 corrects V2 over-engineering: derived recovery tiers, minimal Coach persistence, single food archive, one reflection history.

**Not in scope:** product debate, new features, module extraction pre-80% alignment.

---

## 2. Accepted Product Behavior (Final)

- Unified **Coach** on Today — single card + quick actions
- **Weekly Reflection** replaces recap/review fragmentation (four blocks)
- **Simple mode** default; **Advanced** exposes nutrition details
- **Food reporting** through Coach on Today
- Planner calorie rebalance **deleted**
- Recovery Capacity Framework V1 + Decision Engine V1 govern copy and priority

### Reflection blocks

1. What happened  
2. What Arc learned  
3. What changes next week  
4. What stays the same  

---

## 3. Persisted Profile Shape

```javascript
UP.coach = {
  dismissedDay: null,   // todayKey() when user dismissed card
  dismissedType: null   // event type dismissed (e.g. ate_out)
};

UP.recovery = {
  weekKey: null,
  tier: 0,              // 0–3 only; derived each update
  goalReviewSuggested: false,
  updatedAt: null
};

UP.displayMode = 'simple';  // 'simple' | 'advanced'

UP.foodReports = [];  // max 50 — slim entries only

UP.lastWeeklyReflection = {
  weekKey, generatedAt, weekType, blocks, adjustmentsApplied
};

UP.reflectionHistory = [];  // max 12 — { weekKey, generatedAt, weekType }

// Unchanged inputs (source of truth)
UP.chaosRecovery
UP.arcAdaptive
UP.arcBehavior
```

### Slim food report entry

```javascript
{ at, day, text, impactClass, confidence, cal, proteinG, source }
```

### Deleted persistence

- `arcMoments`
- `weeklyReviewHistory` / `lastWeeklyReview`
- `arcWeeklyRecap` writes
- `logs[]` as primary food archive
- V2 fields: `coachState.*` analytics, `recoveryState` counters (`weekEventLoad`, `socialEventCount`, etc.)

---

## 4. Constants

```javascript
var ARC_RECOVERY = {
  LOAD_MAINTENANCE: 6,
  SOCIAL_MAINTENANCE: 3,
  TIER2_LOAD: 3,
  FOOD_REPORT_HEAVY: 2,
  FOOD_REPORT_MODERATE: 1,
  MAX_FOOD_REPORTS: 50
};

var ARC_DISPLAY_SIMPLE = 'simple';
var ARC_DISPLAY_ADVANCED = 'advanced';
```

---

## 5. Core Functions

### Coach

| Function | Role |
|----------|------|
| `ensureCoach(p)` | Default `UP.coach` |
| `buildCoachResponse(ctx)` | Priority: maintenance (tier≥3) → chaos plan → food report → protein hint only |
| `evaluateEventAndAct(type, opts)` | Single orchestrator; one save; one render |
| `renderCoach(day, response)` | `#coach-card` (alias `#chaos-recovery-card`) |
| `renderCoachQuickActions(day, chaosPlan)` | Quick action chips |
| `dismissCoach(eventType)` | Set dismissal; re-render |

### Recovery (derived)

| Function | Role |
|----------|------|
| `getWeekEvents(weekKey)` | Chaos day events + food reports for week |
| `computeWeekEventLoad(events)` | Load score from events |
| `computeSocialCount(events)` | Social-type count |
| `recalculateRecoveryTier(weekKey)` | Derive tier 0–3; persist to `UP.recovery` |
| `getWeekStatusLabel(tier)` | Chip copy |

### Food

| Function | Role |
|----------|------|
| `processFoodReport(text)` | One AI triage; no `finalizeFoodLogReply` |
| `storeFoodReportEntry(...)` | Inline append + trim |

### Reflection

| Function | Role |
|----------|------|
| `buildWeeklyReflection(anchorMonday)` | Wrap existing metric builders → four blocks |
| `runWeeklyReflectionAndPersist()` | Persist + history + goal review |
| `buildStaysSameLine()` | ~10 lines |

### Display

| Function | Role |
|----------|------|
| `isAdvancedMode()` | `UP.displayMode === 'advanced'` |
| `body.arc-advanced` CSS class | Global hide for nutrition chrome |

---

## 6. Event Flow

```
User tap quick action | food submit
        ↓
evaluateEventAndAct(type, opts)
        ├── chaosRecovery.days[day].events  (existing)
        ├── foodReports[] (if food)
        ├── ingestFoodLogAdaptiveSignals (existing)
        ├── arcBehaviorObserve (once)
        ├── recalculateRecoveryTier(weekKey)
        └── saveUserProfile() once
        ↓
renderToday() → buildCoachResponse() → renderCoach()
```

**Rules:**

- `logChaosSignal` must not call `renderToday` when invoked from `evaluateEventAndAct`
- Coach card hidden on normal days (no proactive adaptive copy on Today)
- Dismissal: same day + same event type stays hidden; new type or new day re-opens
- Maintenance (tier≥3) overrides dismissal once per day

---

## 7. Today DOM Hierarchy

```
#s-today
├── .today-header
├── #week-status-chip          [Phase B]
├── .today-hero-card
├── #coach-card                (id: chaos-recovery-card)
├── #coach-quick-actions       (id: chaos-strip)
├── #reflection-banner         [Phase D]
├── #coach-food-sheet          [Phase C]
└── #today-more-advanced       [Phase E]
```

---

## 8. Reuse (Do Not Replace)

| System | Action |
|--------|--------|
| `buildChaosRecoveryPlan` | Keep |
| `logChaosSignal` | Modify — orchestration only |
| `ingestFoodLogAdaptiveSignals` | Keep |
| `ArcFoodLogSignals` | Keep |
| `computeWeeklyReviewMetrics` | Keep |
| `buildWeeklyInsightStrings` | Keep → reflection happened/learned |
| `buildAdaptiveAdjustmentStrings` | Keep → reflection changes |
| `recap-overlay` DOM | Keep → four-block renderer |
| `mergeMetricsIntoArcAdaptive` | Keep |
| `getEffectiveDailyTargets` | Keep |

---

## 9. Delete List

| Item | Phase |
|------|-------|
| `arc-moment-strip`, `maybeQueueArcMoment*`, `UP.arcMoments` | A |
| `#today-suggestion` as Coach surface | A |
| `getDailyAdaptiveCoachMessage` standalone path | A |
| `finalizeFoodLogReply` | C |
| `computeConsistencyScoreRecap`, recap hero slides | D |
| `renderTodayWeeklyLens` | D |
| `openAdaptModal` + adapt UI | F |
| `weeklyReviewHistory`, `arcWeeklyRecap` writes | D/F |

---

## 10. Build Phases

### Phase A — Coach spine

- `UP.coach`, `ensureCoach`, `buildCoachResponse`, `renderCoach`, `evaluateEventAndAct`, `dismissCoach`
- Merge `#today-suggestion` into Coach card path
- Delete arc-moment strip usage
- Rename user-facing copy Chaos → Coach
- `logChaosSignal`: `skipRender` option

### Phase B — Derived recovery tier

- `getWeekEvents`, `recalculateRecoveryTier`, `#week-status-chip`
- Maintenance copy in `buildCoachResponse`

### Phase C — Food on Today

- `#coach-food-sheet`, `processFoodReport`, slim `UP.foodReports`
- Delete `finalizeFoodLogReply`; Progress reads `foodReports`

### Phase D — Reflection reshape

- `buildWeeklyReflection`, four-block overlay
- `lastWeeklyReflection`, `reflectionHistory`
- Delete consistency/streak slides

### Phase E — Simple/Advanced mode

- `UP.displayMode`, Settings toggle, `body.arc-advanced`

### Phase F — Cleanup + tests

- Adapt modal delete, archive merge, sandbox tests for derivation-based tier

---

## 11. Tests (Phase F)

- `buildCoachResponse` — priority + dismissal
- `recalculateRecoveryTier` — from event fixtures (not counter increments)
- `buildWeeklyReflection` — four blocks from metrics

---

## 12. File Touch Summary

| File | Scope |
|------|-------|
| `index.html` | Primary — all phases |
| `js/arc-food-log-signals.js` | No change |
| `js/arc-adaptive-recipe-scoring.js` | No change |
| `tests/` | Phase F additions |
| `docs/ARC_IMPLEMENTATION_V2_1.md` | This document |
