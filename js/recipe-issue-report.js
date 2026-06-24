/**
 * Recipe issue reports — storage adapter (swap-friendly).
 * Tries Supabase table `arc_recipe_issue_reports` when configured; falls back to localStorage.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'arc_recipe_issue_reports';
  var TABLE = 'arc_recipe_issue_reports';

  function persistLocal(report) {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(list)) list = [];
      list.push(report);
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      return Promise.resolve(report);
    } catch (e) {
      return Promise.reject(new Error('storage failed'));
    }
  }

  function persistSupabase(report) {
    var backend = global.ArcBackend;
    if (!backend || typeof backend.isConfigured !== 'function' || !backend.isConfigured()) {
      return Promise.reject(new Error('supabase not configured'));
    }
    var client = typeof backend.getClient === 'function' ? backend.getClient() : null;
    if (!client) return Promise.reject(new Error('no supabase client'));

    var row = {
      user_id: report.userId || null,
      recipe_id: report.recipeId,
      recipe_name: report.recipeName,
      report_text: report.reportText,
      spoonacular_id: report.spoonacularId != null ? report.spoonacularId : null,
      created_at: new Date(report.createdAt).toISOString()
    };

    return client.from(TABLE).insert(row).then(function (res) {
      if (res.error) return Promise.reject(res.error);
      return report;
    });
  }

  /**
   * @param {{ recipeId: *, recipeName: string, reportText: string, userId: *|null, createdAt: number, spoonacularId?: * }} report
   * @returns {Promise<object>}
   */
  function submitRecipeIssueReport(report) {
    if (!report || report.recipeId == null) {
      return Promise.reject(new Error('invalid report'));
    }
    var text = String(report.reportText || '').trim();
    if (!text || text.length > 1000) {
      return Promise.reject(new Error('invalid report text'));
    }

    var normalized = Object.assign({}, report, { reportText: text });

    return persistSupabase(normalized).catch(function () {
      return persistLocal(normalized);
    });
  }

  global.submitRecipeIssueReport = submitRecipeIssueReport;
})(typeof window !== 'undefined' ? window : globalThis);
