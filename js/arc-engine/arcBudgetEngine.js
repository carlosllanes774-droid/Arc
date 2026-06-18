/**
 * Arc Budget Engine — grocery constraint tiers for future Kroger/API wiring.
 */
(function (global) {
  'use strict';

  var TIERS = {
    low: {
      id: 'low',
      label: 'Lean week',
      maxCostPerServing: 4.5,
      proteinPreference: ['eggs', 'chicken_thigh', 'beans', 'tofu', 'canned_tuna'],
      allowPremiumCuts: false,
      repeatFriendly: true,
      batchCookBias: 0.85
    },
    moderate: {
      id: 'moderate',
      label: 'Balanced',
      maxCostPerServing: 7,
      proteinPreference: ['chicken', 'turkey', 'fish', 'eggs', 'beef_lean'],
      allowPremiumCuts: true,
      repeatFriendly: true,
      batchCookBias: 0.6
    },
    premium: {
      id: 'premium',
      label: 'Flexible',
      maxCostPerServing: 12,
      proteinPreference: ['salmon', 'steak', 'shrimp', 'organic_poultry'],
      allowPremiumCuts: true,
      repeatFriendly: false,
      batchCookBias: 0.35
    }
  };

  /** Map Arc onboarding budget labels to tier slugs. */
  var ONBOARDING_BUDGET_MAP = {
    Budget: 'low',
    Moderate: 'moderate',
    Flexible: 'premium',
    budget: 'low',
    moderate: 'moderate',
    flexible: 'premium',
    premium: 'premium'
  };

  /**
   * @param {string} tier
   * @returns {string}
   */
  function normalizeTier(tier) {
    if (tier == null) return 'moderate';
    var raw = String(tier).trim();
    if (ONBOARDING_BUDGET_MAP[raw]) return ONBOARDING_BUDGET_MAP[raw];
    var lower = raw.toLowerCase();
    if (ONBOARDING_BUDGET_MAP[lower]) return ONBOARDING_BUDGET_MAP[lower];
    if (TIERS[lower]) return lower;
    return 'moderate';
  }

  /**
   * Build constraints object for grocery optimizers (Kroger, etc.).
   * @param {string} tier
   * @param {{ householdSize?: number, weeklyBudgetUsd?: number }} [opts]
   * @returns {object}
   */
  function getBudgetConstraints(tier, opts) {
    opts = opts || {};
    var key = normalizeTier(tier);
    var base = TIERS[key] || TIERS.moderate;
    var household = Math.max(1, parseInt(opts.householdSize, 10) || 1);

    return {
      tier: base.id,
      label: base.label,
      maxCostPerServing: base.maxCostPerServing,
      proteinPreference: base.proteinPreference.slice(),
      allowPremiumCuts: base.allowPremiumCuts,
      repeatFriendly: base.repeatFriendly,
      batchCookBias: base.batchCookBias,
      householdSize: household,
      weeklyBudgetUsd: opts.weeklyBudgetUsd || null,
      flags: {
        preferStoreBrands: key === 'low',
        allowConvenienceItems: key !== 'low',
        splurgeSlotsPerWeek: key === 'premium' ? 2 : key === 'moderate' ? 1 : 0
      },
      apiReady: {
        kroger: false,
        spoonacular: false,
        edamam: false,
        usda: false
      }
    };
  }

  var api = {
    TIERS: TIERS,
    ONBOARDING_BUDGET_MAP: ONBOARDING_BUDGET_MAP,
    normalizeTier: normalizeTier,
    getBudgetConstraints: getBudgetConstraints
  };

  global.ArcEngine = global.ArcEngine || {};
  global.ArcEngine.Budget = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
