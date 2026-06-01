/**
 * Week recipe library targets — budget-aware caps (4–6 budget, 6–8 standard, 8 hard max).
 */
(function (global) {
  'use strict';

  var MIN_RECIPES = 4;
  var MIN_RECIPES_STANDARD = 6;
  var MAX_RECIPES_BUDGET = 6;
  var MAX_RECIPES_STANDARD = 8;
  var MAX_RECIPES_VARIETY = 12;
  var VALID_BUDGETS = { Budget: true, Moderate: true, Flexible: true };
  var REDUCE_PRIORITY = ['Snack', 'Breakfast', 'Lunch', 'Dinner'];
  var GROW_PRIORITY = ['Dinner', 'Lunch', 'Breakfast', 'Snack'];

  function normalizeBudgetProfile(v) {
    var key = v != null ? String(v).trim() : '';
    return VALID_BUDGETS[key] ? key : 'Moderate';
  }

  function slotsToPerCat(slots) {
    slots = slots || [];
    var perCat = {};
    for (var i = 0; i < slots.length; i++) {
      var s = String(slots[i]).toLowerCase();
      if (/breakfast/.test(s)) perCat.Breakfast = 2;
      else if (/lunch/.test(s)) perCat.Lunch = 2;
      else if (/dinner/.test(s)) perCat.Dinner = 2;
      else if (/snack/.test(s)) perCat.Snack = 2;
    }
    if (!Object.keys(perCat).length) perCat.Lunch = 2;
    return perCat;
  }

  function sumPerCat(perCat) {
    var total = 0;
    Object.keys(perCat).forEach(function (k) { total += perCat[k]; });
    return total;
  }

  /**
   * @param {string[]} slots — meal slot names
   * @param {{ budgetProfile?: string, weeklyBudget?: string, varietyMode?: boolean }} [opts]
   * @returns {{ perCat: object, total: number, maxTotal: number, minTotal: number, budgetProfile: string, varietyMode: boolean, profile: string }}
   */
  function computeWeekCoreLibraryTargets(slots, opts) {
    opts = opts || {};
    var budgetProfile = normalizeBudgetProfile(opts.budgetProfile || opts.weeklyBudget);
    var varietyMode = !!opts.varietyMode;
    var isBudget = budgetProfile === 'Budget';
    var maxTotal = varietyMode ? MAX_RECIPES_VARIETY : (isBudget ? MAX_RECIPES_BUDGET : MAX_RECIPES_STANDARD);
    var minTotal = isBudget ? MIN_RECIPES : MIN_RECIPES_STANDARD;

    var perCat = slotsToPerCat(slots);
    var total = sumPerCat(perCat);

    if (total < MIN_RECIPES) {
      Object.keys(perCat).forEach(function (k) {
        perCat[k] = Math.max(perCat[k], 2);
      });
      total = sumPerCat(perCat);
    }

    while (total > maxTotal) {
      var reduced = false;
      for (var ri = 0; ri < REDUCE_PRIORITY.length; ri++) {
        var cat = REDUCE_PRIORITY[ri];
        if (perCat[cat] > 1) {
          perCat[cat]--;
          total--;
          reduced = true;
          if (total <= maxTotal) break;
        }
      }
      if (!reduced) break;
    }

    if (!isBudget && !varietyMode) {
      while (total < minTotal && total < maxTotal) {
        var grown = false;
        for (var gi = 0; gi < GROW_PRIORITY.length; gi++) {
          var gcat = GROW_PRIORITY[gi];
          if (perCat[gcat] != null && perCat[gcat] < 3) {
            perCat[gcat]++;
            total++;
            grown = true;
            if (total >= minTotal) break;
          }
        }
        if (!grown) break;
      }
    }

    return {
      perCat: perCat,
      total: total,
      maxTotal: maxTotal,
      minTotal: minTotal,
      budgetProfile: budgetProfile,
      varietyMode: varietyMode,
      profile: isBudget ? 'budget' : 'standard'
    };
  }

  global.ArcWeekLibraryTargets = {
    MIN_RECIPES: MIN_RECIPES,
    MIN_RECIPES_STANDARD: MIN_RECIPES_STANDARD,
    MAX_RECIPES_BUDGET: MAX_RECIPES_BUDGET,
    MAX_RECIPES_STANDARD: MAX_RECIPES_STANDARD,
    MAX_RECIPES_VARIETY: MAX_RECIPES_VARIETY,
    normalizeBudgetProfile: normalizeBudgetProfile,
    computeWeekCoreLibraryTargets: computeWeekCoreLibraryTargets
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
