/**
 * Arc API Orchestrator — routes information requests; runs adaptive meal pipeline.
 *
 * Flow:
 *   Arc Engine → Spoonacular → Edamam → USDA → Validation → OpenAI → Kroger → Portion Scaling
 *
 * Arc Engine owns targets, optimization, validation decisions, and execution.
 */
(function (global) {
  'use strict';
  var PIPELINE_DEBOUNCE_MS = 1200;
  var pipelineInFlight = new Map();
  var pipelineDebounce = new Map();

  function providers() {
    var p = global.ArcApi && global.ArcApi.Providers;
    if (!p) throw new Error('[Arc API] Load provider modules before apiOrchestrator.js');
    return p;
  }

  function services() {
    return (global.ArcApi && global.ArcApi.Services) || {};
  }

  function validation() {
    return (global.ArcApi && global.ArcApi.Validation) || null;
  }

  function curation() {
    return (global.ArcApi && global.ArcApi.Curation) || null;
  }

  /**
   * @type {Object<string, string>}
   */
  var RESPONSIBILITY_OWNER = {
    recipe_retrieval: 'spoonacular',
    recipe_metadata: 'spoonacular',
    meal_discovery: 'spoonacular',

    ingredient_parsing: 'edamam',
    food_understanding: 'edamam',
    recipe_nutrition_analysis: 'edamam',
    diet_labels: 'edamam',
    food_intelligence: 'edamam',

    nutrition_verification: 'usda',
    macro_validation: 'usda',
    source_of_truth: 'usda',

    adaptation: 'openai',
    optimization: 'openai',
    reasoning: 'openai',

    grocery_pricing: 'kroger',
    availability: 'kroger',
    substitutions: 'kroger'
  };

  /**
   * @type {Object<string, { provider: string, method: string, responsibility: string }>}
   */
  var OPERATIONS = {
    retrieveRecipe: { provider: 'spoonacular', method: 'retrieveRecipe', responsibility: 'recipe_retrieval' },
    getRecipeMetadata: { provider: 'spoonacular', method: 'getRecipeMetadata', responsibility: 'recipe_metadata' },
    discoverMeals: { provider: 'spoonacular', method: 'discoverMeals', responsibility: 'meal_discovery' },
    searchRecipes: { provider: 'spoonacular', method: 'searchRecipes', responsibility: 'meal_discovery' },

    parseIngredients: { provider: 'edamam', method: 'parseIngredients', responsibility: 'ingredient_parsing' },
    parseFoodInput: { provider: 'edamam', method: 'parseFoodInput', responsibility: 'ingredient_parsing' },
    understandFood: { provider: 'edamam', method: 'understandFood', responsibility: 'food_understanding' },
    analyzeRecipeNutrition: { provider: 'edamam', method: 'analyzeRecipeNutrition', responsibility: 'recipe_nutrition_analysis' },
    getDietLabels: { provider: 'edamam', method: 'getDietLabels', responsibility: 'diet_labels' },
    getFoodIntelligence: { provider: 'edamam', method: 'getFoodIntelligence', responsibility: 'food_intelligence' },

    verifyNutrition: { provider: 'usda', method: 'verifyNutrition', responsibility: 'nutrition_verification' },
    validateMacros: { provider: 'usda', method: 'validateMacros', responsibility: 'macro_validation' },
    resolveSourceOfTruth: { provider: 'usda', method: 'resolveSourceOfTruth', responsibility: 'source_of_truth' },

    adapt: { provider: 'openai', method: 'adapt', responsibility: 'adaptation' },
    optimize: { provider: 'openai', method: 'optimize', responsibility: 'optimization' },
    reason: { provider: 'openai', method: 'reason', responsibility: 'reasoning' },

    getGroceryPricing: { provider: 'kroger', method: 'getPricing', responsibility: 'grocery_pricing' },
    checkAvailability: { provider: 'kroger', method: 'checkAvailability', responsibility: 'availability' },
    findSubstitutions: { provider: 'kroger', method: 'findSubstitutions', responsibility: 'substitutions' }
  };

  var PROVIDER_CATALOG = {
    spoonacular: {
      label: 'Spoonacular',
      role: 'Recipe catalog & meal discovery',
      responsibilities: ['recipe_retrieval', 'recipe_metadata', 'meal_discovery'],
      arcDoesNot: ['macro targets', 'meal slot optimization', 'adherence scoring']
    },
    edamam: {
      label: 'Edamam',
      role: 'Food & ingredient intelligence',
      responsibilities: [
        'ingredient_parsing',
        'food_understanding',
        'recipe_nutrition_analysis',
        'diet_labels',
        'food_intelligence'
      ],
      arcDoesNot: ['calorie targets', 'goal strategy', 'portion scaling decisions']
    },
    usda: {
      label: 'USDA FoodData Central',
      role: 'Nutrition verification & truth layer',
      responsibilities: ['nutrition_verification', 'macro_validation', 'source_of_truth'],
      arcDoesNot: ['recipe discovery', 'grocery pricing']
    },
    openai: {
      label: 'OpenAI',
      role: 'Adaptation, optimization language, reasoning',
      responsibilities: ['adaptation', 'optimization', 'reasoning'],
      arcDoesNot: ['TDEE calculation', 'deterministic meal presets', 'budget tiers', 'meal creation']
    },
    kroger: {
      label: 'Kroger',
      role: 'Grocery market data',
      responsibilities: ['grocery_pricing', 'availability', 'substitutions'],
      arcDoesNot: ['nutrition targets', 'recipe nutrition analysis']
    }
  };

  function trace() {
    return global.ArcApi && global.ArcApi.Trace;
  }

  function stableStringify(value) {
    if (value == null) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
      return '[' + value.slice(0, 8).map(stableStringify).join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'recipes' || k === 'plan' || k === 'history' || k === 'raw') continue;
      out.push(JSON.stringify(k) + ':' + stableStringify(value[k]));
    }
    return '{' + out.join(',') + '}';
  }

  function pipelineKey(profile) {
    profile = profile || {};
    return stableStringify({
      goal: profile.goal || null,
      goalPace: profile.goalPace || null,
      weight: profile.weight || null,
      activityLevel: profile.activityLevel || null,
      scenario: profile.scenario || null,
      foodLogText: profile.foodLogText || null,
      mealQuery: profile.mealQuery || null,
      budgetTier: profile.budgetTier || null,
      recipeCount: profile.recipeCount || null
    });
  }

  function dispatch(operationName, input) {
    var op = OPERATIONS[operationName];
    if (!op) {
      return Promise.resolve({
        provider: null,
        responsibility: null,
        status: 'unknown_operation',
        data: null,
        error: 'Unknown operation: ' + operationName,
        arcOwned: false
      });
    }

    var owner = op.provider;
    if (RESPONSIBILITY_OWNER[op.responsibility] !== owner) {
      return Promise.reject(new Error('[Arc API] Responsibility routing mismatch: ' + op.responsibility));
    }

    var p = providers()[owner];
    if (!p || typeof p[op.method] !== 'function') {
      return Promise.resolve({
        provider: owner,
        responsibility: op.responsibility,
        status: 'provider_missing',
        data: null,
        error: 'Provider adapter not loaded: ' + owner,
        arcOwned: false
      });
    }

    return p[op.method](input);
  }

  /**
   * Spoonacular → USDA when Edamam envelope is not ok (client-side; server may already fallback).
   * @returns {Promise<object|null>} provider envelope or null
   */
  function resolveNutritionAfterEdamamFailure(ctx) {
    ctx = ctx || {};
    var S = services();
    var T = trace();
    var recipe = ctx.recipe || {};
    var ingrLines = ctx.ingrLines || [];
    var recipeId = recipe.recipeId || recipe.id;

    if (S.spoonacular && recipeId) {
      return S.spoonacular.getRecipeBulk({ ids: [recipeId], includeNutrition: true }).then(function (r) {
        if (r.status !== 'ok' || !r.data.recipes.length) return tryUsdaFallback();
        var rec = r.data.recipes[0];
        var macros = rec.nutrition || (rec.calories != null
          ? { calories: rec.calories, protein: rec.protein, carbs: rec.carbs, fat: rec.fat }
          : null);
        if (!macros || !macros.calories) return tryUsdaFallback();
        if (T) T.logFallback('spoonacular', 'edamam_failed');
        return {
          provider: 'spoonacular',
          status: 'ok',
          data: {
            normalized: macros,
            source: 'spoonacular',
            nutritionConfidence: 'low',
            fallback: true
          }
        };
      });
    }
    return tryUsdaFallback();

    function tryUsdaFallback() {
      if (!S.usda || !ingrLines.length) return Promise.resolve(null);
      return S.usda.searchIngredient({ query: ingrLines[0], pageSize: 1 }).then(function (sr) {
        if (sr.status !== 'ok' || !sr.data.foods.length) return null;
        return S.usda.getFoodNutrition({ fdcId: sr.data.foods[0].fdcId }).then(function (fn) {
          if (fn.status !== 'ok' || !fn.data.normalized) return null;
          if (T) T.logFallback('usda', 'edamam_failed');
          return {
            provider: 'usda',
            status: 'ok',
            data: {
              normalized: fn.data.normalized,
              source: 'usda',
              nutritionConfidence: 'low',
              fallback: true
            }
          };
        });
      });
    }
  }

  function analyzeAndValidateRecipe(input) {
    input = input || {};
    return dispatch('analyzeRecipeNutrition', input).then(function (nutrition) {
      var macros = nutrition.data && nutrition.data.normalized;
      if (!macros || nutrition.status !== 'ok') {
        return { nutrition: nutrition, validation: null, arcNote: 'Nutrition analysis incomplete — skip USDA validation' };
      }

      var V = validation();
      var preCheck = V ? V.detectImpossibleNutrition(macros) : { safe: true };

      return dispatch('validateMacros', {
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat
      }).then(function (usdaValidation) {
        return {
          nutrition: nutrition,
          validation: usdaValidation,
          preCheck: preCheck,
          arcNote: 'Arc Engine applies targets, scaling, and meal strategy — not external APIs'
        };
      });
    });
  }

  /**
   * Full adaptive meal pipeline — Arc Engine first, APIs provide information.
   * @param {object} profile Arc Engine profile + optional scenario, zipCode, foodLog
   * @returns {Promise<object>}
   */
  function runAdaptiveMealPipeline(profile) {
    profile = profile || {};
    var T = trace();
    var key = pipelineKey(profile);
    var now = Date.now();
    var debounceUntil = pipelineDebounce.get(key) || 0;
    if (pipelineInFlight.has(key)) return pipelineInFlight.get(key);
    if (debounceUntil > now && pipelineInFlight.has('__last:' + key)) {
      return pipelineInFlight.get('__last:' + key);
    }
    if (T) T.logOrchestrator('meal pipeline started');

    var arcResult = null;

    if (global.ArcEngine && typeof global.ArcEngine.run === 'function') {
      arcResult = global.ArcEngine.run(profile);
    } else if (global.ArcEngine && typeof global.ArcEngine.computeTargets === 'function') {
      arcResult = { goal: global.ArcEngine.computeTargets(profile), targets: global.ArcEngine.computeTargets(profile) };
    }

    var targets = arcResult && (arcResult.targets || arcResult.goal) || {};
    var scenario = profile.scenario || inferScenario(profile);
    var S = services();
    var V = validation();

    var finalRecipeCount = Math.max(1, profile.recipeCount || 3);
    var searchFilters = {
      query: profile.mealQuery || 'high protein dinner',
      maxCalories: profile.maxCalories || (targets.targetCalories ? Math.round(targets.targetCalories / (profile.mealsPerDay || 3)) : null),
      diet: profile.diet,
      number: Math.min(20, Math.max(8, finalRecipeCount * 4))
    };

    var flow = (S.spoonacular ? S.spoonacular.searchRecipes(searchFilters) : dispatch('discoverMeals', searchFilters))
      .then(function (recipeSearch) {
        var recipes = (recipeSearch.data && recipeSearch.data.recipes) || [];
        if (!recipes.length && profile.recipe) recipes = [profile.recipe];
        if (!recipes.length) {
          if (T) T.logMessage('Spoonacular no recipes found');
          return buildPipelineResult({
            arcResult: arcResult,
            scenario: scenario,
            recipeSearch: recipeSearch,
            error: 'no_recipe_found',
            degraded: true
          });
        }

        function nutritionForRecipe(recipe) {
          var ingrLines = (recipe.ingredients || []).map(function (i) {
            return i.original || i.name || String(i);
          }).filter(Boolean);

          var edamamPromise = S.edamam
            ? S.edamam.analyzeRecipeNutrition({
              title: recipe.title,
              ingr: ingrLines,
              spoonacularRecipeId: recipe.recipeId || recipe.id
            })
            : dispatch('analyzeRecipeNutrition', {
              title: recipe.title,
              ingr: ingrLines,
              spoonacularRecipeId: recipe.recipeId || recipe.id
            });

          return edamamPromise.then(function (nutrition) {
            var macros = nutrition.data && (nutrition.data.normalized || nutrition.data.totalNutrients);
            if (nutrition.status !== 'ok' || !macros) {
              return resolveNutritionAfterEdamamFailure({
                recipe: recipe,
                ingrLines: ingrLines
              }).then(function (fallbackNutrition) {
                if (!fallbackNutrition) return { recipe: recipe, nutrition: nutrition, macros: null, rejected: 'nutrition_unavailable' };
                return { recipe: recipe, nutrition: fallbackNutrition, macros: fallbackNutrition.data.normalized };
              });
            }
            return { recipe: recipe, nutrition: nutrition, macros: macros };
          });
        }

        function evaluateCandidate(recipe) {
          return nutritionForRecipe(recipe).then(function (evalData) {
            if (!evalData.macros) return evalData;
            var usdaPromise = S.usda ? S.usda.validateMacros(evalData.macros) : dispatch('validateMacros', evalData.macros);
            return usdaPromise.then(function (usdaValidation) {
              var validationReport = V && V.detectImpossibleNutrition
                ? V.detectImpossibleNutrition(Object.assign({}, evalData.macros, { context: 'meal', weightLb: profile.weight }))
                : null;
              var sanityReport = V && V.runNutritionSanityChecks ? V.runNutritionSanityChecks(evalData.macros) : null;
              var valid = (!validationReport || validationReport.safe) && (!sanityReport || sanityReport.valid) &&
                !!(usdaValidation && usdaValidation.status === 'ok' && usdaValidation.data && usdaValidation.data.valid);
              return Object.assign({}, evalData, {
                usdaValidation: usdaValidation,
                validationReport: validationReport,
                sanityReport: sanityReport,
                rejected: valid ? null : 'nutrition_failed_validation'
              });
            });
          });
        }

        function evaluateAll(candidates) {
          var out = [];
          var idx = 0;
          var workers = [];
          var concurrency = 3;
          function worker() {
            var i = idx++;
            if (i >= candidates.length) return Promise.resolve();
            return evaluateCandidate(candidates[i]).then(function (entry) {
              out[i] = entry;
              return worker();
            });
          }
          var wCount = Math.min(concurrency, candidates.length);
          for (var w = 0; w < wCount; w++) workers.push(worker());
          return Promise.all(workers).then(function () { return out; });
        }

        return evaluateAll(recipes).then(function (evaluated) {
          var candidateRecipes = [];
          evaluated.forEach(function (entry) {
            if (!entry || entry.rejected || !entry.macros) return;
            var recipeWithNutrition = Object.assign({}, entry.recipe, {
              nutrition: entry.macros || {},
              calories: entry.macros && entry.macros.calories,
              protein: entry.macros && entry.macros.protein,
              carbs: entry.macros && entry.macros.carbs,
              fat: entry.macros && entry.macros.fat,
              nutritionConfidence: (entry.nutrition && entry.nutrition.data && entry.nutrition.data.nutritionConfidence) || 'medium'
            });
            if (V && V.deriveNutritionTags) {
              var derived = V.deriveNutritionTags(entry.macros || {});
              recipeWithNutrition.nutritionTags = derived.tags;
            }
            candidateRecipes.push(recipeWithNutrition);
          });

          var C = curation();
          var curatedResult = C && C.curateRecipes
            ? C.curateRecipes(candidateRecipes, {
              desiredCount: finalRecipeCount,
              profile: profile,
              scenario: scenario,
              varietyState: profile.varietyState || {}
            })
            : { curated: candidateRecipes.slice(0, finalRecipeCount), rejected: [], varietyState: {} };

          var scoredRecipes = curatedResult.curated.map(function (entry) {
            var merged = Object.assign({}, entry.recipe, {
              recipeQualityScore: entry.recipeQualityScore,
              qualityCategoryScores: entry.categoryScores,
              varietyPenalty: entry.varietyPenalty || 0
            });
            console.log('[ARC CURATION] Recipe scored ' + entry.recipeQualityScore);
            return merged;
          });
          curatedResult.rejected.forEach(function () {
            console.log('[ARC CURATION] Low quality recipe rejected');
          });
          if (scoredRecipes.length) console.log('[ARC CURATION] Variety balancing applied');

          var selectedRecipe = scoredRecipes[0] || null;
          if (!selectedRecipe) {
            return buildPipelineResult({
              arcResult: arcResult,
              scenario: scenario,
              recipeSearch: recipeSearch,
              error: 'no_curated_recipe_found',
              degraded: true
            });
          }

          var selectedEval = null;
          var e;
          for (e = 0; e < evaluated.length; e++) {
            if (evaluated[e] && evaluated[e].recipe && (evaluated[e].recipe.recipeId || evaluated[e].recipe.id) === (selectedRecipe.recipeId || selectedRecipe.id)) {
              selectedEval = evaluated[e];
              break;
            }
          }

          var openaiPromise = pickOpenAiAdaptation(S, scenario, arcResult, profile);
          return openaiPromise.then(function (adaptation) {
            var groceryIngredients = (selectedRecipe.ingredients || []).map(function (ing, idx) {
              return { key: 'ing_' + idx, name: ing.name || ing.original || 'ingredient' };
            });

            var krogerPromise = S.kroger
              ? S.kroger.estimateGroceryCost({
                zipCode: profile.zipCode,
                ingredients: groceryIngredients,
                budgetConstraints: arcResult && arcResult.budget
              })
              : dispatch('getGroceryPricing', { zipCode: profile.zipCode, items: groceryIngredients });

            return krogerPromise.then(function (pricing) {
              if (T && pricing && pricing.status === 'not_configured') {
                T.logMessage('Kroger unavailable');
              }

              var scaledRecipe = null;
              if (global.ArcEngine && global.ArcEngine.PortionScaler && selectedRecipe.nutrition) {
                var slot = arcResult && arcResult.mealStrategy && arcResult.mealStrategy.slots && arcResult.mealStrategy.slots[0];
                var slotTarget = profile.recipeTarget || slot || targets;
                scaledRecipe = global.ArcEngine.PortionScaler.scaleRecipe(selectedRecipe, {
                  calories: slotTarget.calories || slotTarget.targetCalories,
                  protein: slotTarget.protein || slotTarget.proteinTarget,
                  carbs: slotTarget.carbs || slotTarget.carbTarget,
                  fat: slotTarget.fat || slotTarget.fatTarget
                });
                if (V && V.validateServingScaling) {
                  var scalingCheck = V.validateServingScaling(scaledRecipe);
                  if (!scalingCheck.valid && T) T.logMessage('Serving scaling corrected');
                  scaledRecipe.scalingValidation = scalingCheck;
                }
              }

              selectedRecipe.instructions = Array.isArray(selectedRecipe.instructions) ? selectedRecipe.instructions.slice() : [];
              var finalResult = buildPipelineResult({
                arcResult: arcResult,
                scenario: scenario,
                recipeSearch: recipeSearch,
                recipe: selectedRecipe,
                nutrition: selectedEval ? selectedEval.nutrition : null,
                usdaValidation: selectedEval ? selectedEval.usdaValidation : null,
                validationReport: selectedEval ? selectedEval.validationReport : null,
                adaptation: adaptation,
                pricing: pricing,
                scaledRecipe: scaledRecipe,
                nutritionConfidence: selectedRecipe.nutritionConfidence,
                curatedRecipes: scoredRecipes,
                rejectedRecipes: curatedResult.rejected
              });
              finalResult.enhancement = {
                status: 'skipped',
                async: false,
                applied: false
              };

              if (S.openai && S.openai.enhanceRecipePresentation && Array.isArray(selectedRecipe.instructions) && selectedRecipe.instructions.length) {
                finalResult.enhancement = {
                  status: 'pending',
                  async: true,
                  applied: false
                };
                if (T) T.logMessage('Enhancement running async');
                try {
                  Promise.resolve(S.openai.enhanceRecipePresentation({
                    recipe: selectedRecipe,
                    scenario: scenario,
                    profile: { goal: profile.goal, budgetTier: profile.budgetTier }
                  })).then(function (enhancement) {
                    try {
                      if (enhancement && enhancement.status === 'ok' && enhancement.data) {
                        selectedRecipe.title = enhancement.data.enhancedTitle || selectedRecipe.title;
                        selectedRecipe.instructions = enhancement.data.enhancedInstructions || selectedRecipe.instructions;
                        if (scaledRecipe && Array.isArray(scaledRecipe.instructions)) {
                          scaledRecipe.instructions = selectedRecipe.instructions.slice();
                        }
                        notifyEnhancement(profile, {
                          recipeId: selectedRecipe.recipeId || selectedRecipe.id || null,
                          title: selectedRecipe.title,
                          instructions: selectedRecipe.instructions,
                          enhanced: true,
                          scenario: scenario
                        });
                        console.log('[ARC CURATION] Premium instruction enhancement complete');
                        return;
                      }
                      if (T) T.logMessage('Enhancement exception isolated');
                      if (T) T.logMessage('Base instructions preserved');
                    } catch (_) {
                      if (T) T.logMessage('Enhancement exception isolated');
                      if (T) T.logMessage('Base instructions preserved');
                    }
                  }).catch(function (err) {
                    if (T && err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.name === 'APIUserAbortError')) {
                      T.logMessage('Enhancement timeout isolated');
                    }
                    if (T) T.logMessage('Enhancement exception isolated');
                    if (T) T.logMessage('Base instructions preserved');
                  });
                } catch (_) {
                  if (T) T.logMessage('Enhancement exception isolated');
                  if (T) T.logMessage('Base instructions preserved');
                }
              } else {
                if (T) T.logMessage('Enhancement skipped safely');
              }

              if (T) {
                T.logMessage('Base recipe delivery complete');
                T.logMessage('Base meal response preserved');
                T.logMessage('Final meal generation complete');
              }
              return finalResult;
            });
          });
        });
      }).catch(function (err) {
        if (T) T.logOrchestrator('meal pipeline failed');
        throw err;
      }).finally(function () {
        pipelineInFlight.delete(key);
        pipelineDebounce.set(key, Date.now() + PIPELINE_DEBOUNCE_MS);
      });
    pipelineInFlight.set(key, flow);
    pipelineInFlight.set('__last:' + key, flow);
    return flow;
      
  }

  function inferScenario(profile) {
    if (profile.foodLogText) return 'off_plan';
    if (profile.scenario) return profile.scenario;
    if (profile.athlete && profile.athlete.phase === 'offseason') return 'athlete_offseason';
    if (profile.sickWeek) return 'sick_week';
    if (profile.travelWeek) return 'travel';
    if (profile.budgetTier === 'low' || profile.budgetTier === 'Budget') return 'budget';
    return 'performance';
  }

  function notifyEnhancement(profile, payload) {
    profile = profile || {};
    if (typeof profile.onEnhancementUpdate === 'function') {
      try { profile.onEnhancementUpdate(payload); } catch (_) {}
    }
    if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      try {
        global.dispatchEvent(new global.CustomEvent('arc:recipe-enhancement', { detail: payload }));
      } catch (_) {}
    }
  }

  function pickOpenAiAdaptation(S, scenario, arcResult, profile) {
    if (!S.openai) return dispatch('optimize', { prompt: 'scenario:' + scenario, arcContext: arcResult });

    var ctx = { arc: arcResult, profile: { goal: profile.goal, budgetTier: profile.budgetTier } };
    switch (scenario) {
      case 'athlete_offseason': return S.openai.adaptForAthlete({ arcContext: ctx, userNote: profile.userNote });
      case 'sick_week': return S.openai.adaptForIllness({ arcContext: ctx });
      case 'travel': return S.openai.adaptForTravel({ arcContext: ctx });
      case 'budget': return S.openai.adaptForBudget({ arcContext: ctx });
      case 'off_plan': return S.openai.adaptForOffPlanEating({ arcContext: ctx, text: profile.foodLogText });
      default: return S.openai.optimizeNutritionStrategy({ arcContext: ctx });
    }
  }

  function buildPipelineResult(parts) {
    parts = parts || {};
    return {
      version: '2.0.0',
      generatedAt: new Date().toISOString(),
      arcOwned: true,
      blocked: !!parts.blocked,
      degraded: !!parts.degraded,
      error: parts.error || null,
      scenario: parts.scenario,
      arc: parts.arcResult,
      recipeSearch: parts.recipeSearch || null,
      recipe: parts.recipe || null,
      nutrition: parts.nutrition || null,
      nutritionConfidence: parts.nutritionConfidence || (parts.nutrition && parts.nutrition.data && parts.nutrition.data.nutritionConfidence) || null,
      usdaValidation: parts.usdaValidation || null,
      validation: parts.validationReport || null,
      sanity: parts.sanityReport || null,
      adaptation: parts.adaptation || null,
      pricing: parts.pricing || null,
      scaledRecipe: parts.scaledRecipe || null,
      curatedRecipes: parts.curatedRecipes || [],
      rejectedRecipes: parts.rejectedRecipes || [],
      note: 'Arc Engine owns intelligence; external APIs provide information'
    };
  }

  function getProviderRegistry() {
    return Object.keys(PROVIDER_CATALOG).map(function (id) {
      var entry = PROVIDER_CATALOG[id];
      return {
        id: id,
        label: entry.label,
        role: entry.role,
        responsibilities: entry.responsibilities.slice(),
        status: providers()[id] ? 'adapter_loaded' : 'not_loaded',
        arcBoundary: entry.arcDoesNot
      };
    });
  }

  function getIntegrationStatus() {
    var out = {};
    Object.keys(PROVIDER_CATALOG).forEach(function (id) {
      out[id] = {
        status: providers()[id] ? 'adapter_ready' : 'not_loaded',
        service: services()[id] ? 'service_ready' : 'service_missing',
        responsibilities: PROVIDER_CATALOG[id].responsibilities.slice()
      };
    });
    return out;
  }

  var api = {
    RESPONSIBILITY_OWNER: RESPONSIBILITY_OWNER,
    OPERATIONS: OPERATIONS,
    PROVIDER_CATALOG: PROVIDER_CATALOG,
    dispatch: dispatch,
    analyzeAndValidateRecipe: analyzeAndValidateRecipe,
    runAdaptiveMealPipeline: runAdaptiveMealPipeline,
    getProviderRegistry: getProviderRegistry,
    getIntegrationStatus: getIntegrationStatus,

    retrieveRecipe: function (input) { return dispatch('retrieveRecipe', input); },
    getRecipeMetadata: function (input) { return dispatch('getRecipeMetadata', input); },
    discoverMeals: function (input) { return dispatch('discoverMeals', input); },
    searchRecipes: function (input) { return dispatch('searchRecipes', input); },

    parseIngredients: function (input) { return dispatch('parseIngredients', input); },
    parseFoodInput: function (input) { return dispatch('parseFoodInput', input); },
    understandFood: function (input) { return dispatch('understandFood', input); },
    analyzeRecipeNutrition: function (input) { return dispatch('analyzeRecipeNutrition', input); },
    getDietLabels: function (input) { return dispatch('getDietLabels', input); },
    getFoodIntelligence: function (input) { return dispatch('getFoodIntelligence', input); },

    verifyNutrition: function (input) { return dispatch('verifyNutrition', input); },
    validateMacros: function (input) { return dispatch('validateMacros', input); },
    resolveSourceOfTruth: function (input) { return dispatch('resolveSourceOfTruth', input); },

    adapt: function (input) { return dispatch('adapt', input); },
    optimize: function (input) { return dispatch('optimize', input); },
    reason: function (input) { return dispatch('reason', input); },

    getGroceryPricing: function (input) { return dispatch('getGroceryPricing', input); },
    checkAvailability: function (input) { return dispatch('checkAvailability', input); },
    findSubstitutions: function (input) { return dispatch('findSubstitutions', input); }
  };

  global.ArcApi = global.ArcApi || {};
  global.ArcApi.Orchestrator = api;
  global.ArcApi.dispatch = dispatch;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
