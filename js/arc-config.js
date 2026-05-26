/**
 * Client config placeholders — API base uses window.location.origin (see arc-api-base.js).
 * Supabase public keys load from GET /api/config/public. Do not commit secrets here.
 */
window.ARC_API = window.ARC_API || { baseUrl: '' };
window.ARC_SUPABASE = window.ARC_SUPABASE || { url: '', anonKey: '' };
