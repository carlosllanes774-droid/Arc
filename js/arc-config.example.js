/**
 * API calls use window.location.origin (see js/arc-api-base.js).
 * Supabase loads from GET /api/config/public — set keys in server .env only.
 */
window.ARC_API = window.ARC_API || { baseUrl: '' };
window.ARC_SUPABASE = window.ARC_SUPABASE || { url: '', anonKey: '' };
