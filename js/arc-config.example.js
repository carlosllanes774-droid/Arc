/**
 * Legacy optional override — production loads Supabase from GET /api/config/public
 * (SUPABASE_URL + SUPABASE_ANON_KEY in server .env only). Do not commit secrets.
 */
window.ARC_API = window.ARC_API || { baseUrl: '' };
window.ARC_SUPABASE = window.ARC_SUPABASE || { url: '', anonKey: '' };
