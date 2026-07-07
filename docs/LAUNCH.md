# Arc launch checklist

Production URL: **https://nutriai-qevt.onrender.com**

## Privacy & Terms — you do NOT need a separate host

Arc serves legal pages from the **same Render app**:

- Privacy: https://nutriai-qevt.onrender.com/legal/privacy
- Terms: https://nutriai-qevt.onrender.com/legal/terms

No GitHub Pages or extra domain required. After deploy, open those URLs to confirm they load.

## Render environment variables

Copy `.env.example` and set in [Render Dashboard](https://dashboard.render.com) → your service → Environment:

| Variable | Required | Notes |
|----------|----------|--------|
| `ARC_FRONTEND_ORIGIN` | Yes | `https://nutriai-qevt.onrender.com` |
| `SUPABASE_URL` | Yes | From Supabase project settings |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | For delete account | Dashboard → API → `service_role` (keep secret) |
| `OPENAI_API_KEY` | Yes | Week generation |
| `SPOONACULAR_API_KEY` | Yes | Recipes |
| `EDAMAM_APP_ID` + `EDAMAM_API_KEY` | Yes | Macro verification |
| `USDA_API_KEY` | Yes | Macro verification |
| `SENTRY_DSN` | Recommended | From sentry.io project settings |
| `ARC_CONTACT_EMAIL` | Recommended | Your support email for Contact button |

## Supabase redirect URLs

Authentication → URL configuration:

- Site URL: `https://nutriai-qevt.onrender.com`
- Redirect URLs: `https://nutriai-qevt.onrender.com/**`

## Sentry setup (Express on Render)

You created a Sentry project — finish with these steps:

1. In Sentry → **Settings → Projects → [your project] → Client Keys (DSN)**
2. Copy the **DSN** (looks like `https://xxx@xxx.ingest.sentry.io/xxx`)
3. In Render → Environment → add `SENTRY_DSN` = that value
4. Redeploy

The npm/yarn instructions on Sentry’s setup page are for installing the SDK — **already done** in this repo (`@sentry/node` in `server.js`). You only need the DSN in Render.

Optional: connect GitHub in Sentry for release tracking (not required for basic crash reporting).

## Auth roadmap

| Provider | Status |
|----------|--------|
| Google | Enabled in Supabase |
| Email | Enabled in Supabase |
| Apple | Hidden until Apple Developer account + `APPLE_AUTH_ENABLED=true` on Render |

## Before Google Play (no Apple account needed)

1. Set all Render env vars above
2. Run `npm test` locally (CI runs on push)
3. Manual test on phone: onboarding → week → Today → Grocery → Coach
4. Add `SUPABASE_SERVICE_ROLE_KEY` and test Delete account
5. Set `ARC_CONTACT_EMAIL` and test Contact
6. Capacitor Android wrap (next phase)

## What changed in this launch prep branch

- Legal pages at `/legal/privacy` and `/legal/terms`
- Account deletion API + Settings button
- Sentry server integration
- CI (GitHub Actions)
- Coach card on Today + week status chip
- Week planner macro-aware scoring (meals closer to calorie targets)
- Apple Sign In stub (hidden until configured)
- `.env.example` for onboarding
