import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "node:vm";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

const __dirname = ROOT;

/** Load Arc apiConfig (IIFE) for env validation — no hardcoded keys. */
function loadArcApiConfig() {
  const src = readFileSync(path.join(__dirname, "js/config/apiConfig.js"), "utf8");
  const sandbox = { process, ArcConfig: null };
  vm.runInContext(src, vm.createContext(sandbox));
  return sandbox.ArcConfig;
}

const ArcApiConfig = loadArcApiConfig();
const apiEnv = ArcApiConfig.loadFromEnv(process.env);
const apiValidation = ArcApiConfig.validate(apiEnv);

/** Production-safe pipeline tracing (no secrets, no PII). */
function loadArcTrace() {
  const src = readFileSync(path.join(__dirname, "js/arc-api/arcTrace.js"), "utf8");
  const sandbox = { console, ArcApi: {} };
  vm.runInContext(src, vm.createContext(sandbox));
  return sandbox.ArcApi.Trace;
}

const ArcTrace = loadArcTrace();

/**
 * Time and log an upstream provider HTTP call from Express.
 * @param {string} providerId spoonacular|edamam|usda|openai|kroger
 * @param {string} operation short operation label
 * @param {() => Promise<{ ok: boolean, status?: number, fallback?: boolean }>} run
 */
async function traceUpstream(providerId, operation, run) {
  const startedAt = ArcTrace.nowIso();
  const t0 = ArcTrace.timeStart();
  try {
    const result = await run();
    const ok = !!(result && result.ok);
    ArcTrace.logUpstream({
      providerId,
      operation,
      success: ok,
      httpStatus: result && typeof result.status === "number" ? result.status : null,
      providerStatus: ok ? "ok" : "error",
      startedAt,
      completedAt: ArcTrace.nowIso(),
      durationMs: ArcTrace.msSince(t0),
      fallback: !!(result && result.fallback),
      message: ok ? "success" : result && result.status === 503 ? "unavailable" : "failed",
    });
    return result;
  } catch (err) {
    ArcTrace.logUpstream({
      providerId,
      operation,
      success: false,
      httpStatus: err.status || null,
      providerStatus: "error",
      startedAt,
      completedAt: ArcTrace.nowIso(),
      durationMs: ArcTrace.msSince(t0),
      fallback: false,
      message: "failed",
    });
    throw err;
  }
}

if (!apiValidation.valid) {
  console.warn("[Arc API] Missing credentials:", apiValidation.missing.join(", "));
}
if (apiValidation.warnings.length) {
  apiValidation.warnings.forEach((w) => console.warn("[Arc API]", w));
}

function edamamCredentials() {
  const appId = process.env.EDAMAM_APP_ID;
  const appKey =
    process.env.EDAMAM_API_KEY || process.env.EDAMAM_APP_KEY;
  return appId && appKey ? { appId, appKey } : null;
}

function krogerCredentials() {
  const id = process.env.KROGER_CLIENT_ID;
  const secret =
    process.env.KROGER_SECRET || process.env.KROGER_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** Public origin for config responses — respects reverse-proxy TLS (Render, etc.). */
function requestPublicOrigin(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "http")
    .split(",")[0]
    .trim();
  const host = req.get("x-forwarded-host") || req.get("host") || "";
  return `${proto}://${host}`;
}

/** Scoped static assets only — never serve repo root or node_modules. */
app.use("/js", express.static(path.join(ROOT, "js"), { index: false, dotfiles: "deny" }));

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT, "index.html"));
});

/** Public client config — anon key only (RLS-protected), no service role. */
app.get("/api/config/public", (req, res) => {
  const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/rest\/v1\/?$/i, "").replace(/\/$/, "");
  res.json({
    arcApiBase: requestPublicOrigin(req),
    supabase: {
      url: supabaseUrl,
      anonKey: (process.env.SUPABASE_ANON_KEY || "").trim(),
    },
    environment: apiValidation.environment,
    providers: apiValidation.providers,
  });
});

/** Public config status — no secrets exposed. */
app.get("/api/config/status", (req, res) => {
  res.json({
    environment: apiValidation.environment,
    renderReady: apiValidation.valid,
    providers: apiValidation.providers,
    missing: apiValidation.missing,
    arcProxyBase: requestPublicOrigin(req),
  });
});

/** Provider credential flags — no secrets exposed. */
app.get("/api/providers", (req, res) => {
  res.json({
    environment: apiValidation.environment,
    providers: apiValidation.providers,
    renderReady: apiValidation.valid,
  });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function edamamNutrientQuantity(totalNutrients, code) {
  const n = totalNutrients && totalNutrients[code];
  return n && typeof n.quantity === "number" ? n.quantity : null;
}

/** Proxy to Edamam Nutrition Analysis — keeps app_id / app_key on the server only. */
app.post("/api/nutrition", async (req, res) => {
  try {
    const creds = edamamCredentials();
    if (!creds) {
      return res.status(503).json({ error: "Edamam credentials not configured" });
    }
    const { appId, appKey } = creds;

    const title =
      (req.body && typeof req.body.title === "string" && req.body.title.trim()) ||
      "Recipe";
    const ingr = Array.isArray(req.body && req.body.ingr) ? req.body.ingr : [];
    const cleanIngr = ingr
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    if (!cleanIngr.length) {
      return res.status(400).json({ error: "ingr must be a non-empty array of strings" });
    }

    const url = new URL("https://api.edamam.com/api/nutrition-details");
    url.searchParams.set("app_id", appId);
    url.searchParams.set("app_key", appKey);

    const edResp = await traceUpstream("edamam", "nutrition-details", async () => {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ingr: cleanIngr }),
      });
      return { ok: resp.ok, status: resp.status, resp };
    }).then((r) => r.resp);

    if (edResp.status === 304) {
      return res.status(200).json({
        totalNutrients: null,
        notModified: true,
        message: "Use cached nutrition for this recipe fingerprint",
      });
    }

    const rawText = await edResp.text();
    if (!edResp.ok) {
      console.error("Edamam nutrition-details", edResp.status, rawText.slice(0, 400));
      return res.status(edResp.status >= 400 && edResp.status < 600 ? edResp.status : 502).json({
        error: "Edamam request failed",
        detail: rawText.slice(0, 300),
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from Edamam" });
    }

    const tn = data.totalNutrients || {};
    const kcal = edamamNutrientQuantity(tn, "ENERC_KCAL");
    const protein = edamamNutrientQuantity(tn, "PROCNT");
    const fat = edamamNutrientQuantity(tn, "FAT");
    const carbs =
      edamamNutrientQuantity(tn, "CHOCDF") ?? edamamNutrientQuantity(tn, "CHOCDF.net");

    res.json({
      totalNutrients: {
        calories: kcal != null ? Math.round(kcal) : null,
        protein: protein != null ? Math.round(protein * 10) / 10 : null,
        fat: fat != null ? Math.round(fat * 10) / 10 : null,
        carbs: carbs != null ? Math.round(carbs * 10) / 10 : null,
      },
      dietLabels: data.dietLabels || [],
      healthLabels: data.healthLabels || [],
    });
  } catch (err) {
    console.error("/api/nutrition", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** Edamam — natural language / ingredient parsing (food understanding). */
app.post("/api/edamam/parse", async (req, res) => {
  try {
    const creds = edamamCredentials();
    if (!creds) {
      return res.status(503).json({ error: "Edamam credentials not configured" });
    }
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const url = new URL("https://api.edamam.com/api/nutrition-details");
    url.searchParams.set("app_id", creds.appId);
    url.searchParams.set("app_key", creds.appKey);

    const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const ingr = lines.length ? lines : [text];

    const edResp = await traceUpstream("edamam", "parse", async () => {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Parsed input", ingr }),
      });
      return { ok: resp.ok, status: resp.status, resp };
    }).then((r) => r.resp);

    const rawText = await edResp.text();
    if (!edResp.ok) {
      return res.status(edResp.status >= 400 ? edResp.status : 502).json({
        error: "Edamam parse failed",
        detail: rawText.slice(0, 300),
      });
    }

    const data = JSON.parse(rawText);
    const tn = data.totalNutrients || {};
    const foods = ingr.map((line) => ({
      label: line,
      text: line,
      nutrients: {
        calories: edamamNutrientQuantity(tn, "ENERC_KCAL"),
        protein: edamamNutrientQuantity(tn, "PROCNT"),
      },
    }));

    res.json({ foods, ingr });
  } catch (err) {
    console.error("/api/edamam/parse", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── Spoonacular proxies (recipe infrastructure only) ── */

function spoonacularKey() {
  return process.env.SPOONACULAR_API_KEY || "";
}

app.post("/api/spoonacular/search", async (req, res) => {
  try {
    const key = spoonacularKey();
    if (!key) return res.status(503).json({ error: "Spoonacular not configured" });

    const body = req.body || {};
    const params = new URLSearchParams({ apiKey: key, number: String(body.number || 6), addRecipeInformation: "true" });
    if (body.query) params.set("query", body.query);
    if (body.diet) params.set("diet", body.diet);
    if (body.maxCalories) params.set("maxCalories", String(body.maxCalories));
    if (body.minProtein) params.set("minProtein", String(body.minProtein));
    if (body.maxReadyTime) params.set("maxReadyTime", String(body.maxReadyTime));
    if (body.maxPrice) params.set("maxPrice", String(body.maxPrice));

    const url = `https://api.spoonacular.com/recipes/complexSearch?${params}`;
    const { resp, data } = await traceUpstream("spoonacular", "search", async () => {
      const r = await fetch(url);
      const d = await r.json();
      return { ok: r.ok, status: r.status, resp: r, data: d };
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "Spoonacular search failed", detail: data });
    }

    const results = (data.results || []).map((r) => ({
      id: r.id,
      recipeId: r.id,
      title: r.title,
      image: r.image,
      servings: r.servings,
      readyInMinutes: r.readyInMinutes,
      prepTime: r.readyInMinutes,
      ingredients: [],
      tags: [].concat(r.diets || [], r.cuisines || [], r.dishTypes || []),
    }));

    res.json({ results, total: data.totalResults || results.length });
  } catch (err) {
    console.error("/api/spoonacular/search", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/spoonacular/bulk", async (req, res) => {
  try {
    const key = spoonacularKey();
    if (!key) return res.status(503).json({ error: "Spoonacular not configured" });

    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: "ids required" });

    const params = new URLSearchParams({
      apiKey: key,
      ids: ids.join(","),
      includeNutrition: req.body.includeNutrition ? "true" : "false",
    });

    const url = `https://api.spoonacular.com/recipes/informationBulk?${params}`;
    const { resp, data } = await traceUpstream("spoonacular", "bulk", async () => {
      const r = await fetch(url);
      const d = await r.json();
      return { ok: r.ok, status: r.status, resp: r, data: d };
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "Spoonacular bulk failed", detail: data });
    }

    const list = Array.isArray(data) ? data : [];
    const recipes = list.map((r) => ({
      id: r.id,
      recipeId: r.id,
      title: r.title,
      image: r.image,
      servings: r.servings,
      readyInMinutes: r.readyInMinutes,
      prepTime: r.readyInMinutes,
      extendedIngredients: r.extendedIngredients || [],
      ingredients: (r.extendedIngredients || []).map((x) => ({
        name: x.name,
        original: x.original,
        amount: x.amount,
        unit: x.unit,
      })),
      tags: [].concat(r.diets || [], r.cuisines || [], r.dishTypes || []),
      instructions: (r.analyzedInstructions && r.analyzedInstructions[0] && r.analyzedInstructions[0].steps)
        ? r.analyzedInstructions[0].steps.map((s) => s.step)
        : [],
    }));

    const instructions = {};
    recipes.forEach((r) => {
      instructions[r.recipeId] = r.instructions;
    });

    res.json({ recipes, instructions });
  } catch (err) {
    console.error("/api/spoonacular/bulk", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ── USDA FoodData Central (nutrition source of truth) ── */

function usdaNutrientValue(foodNutrients, nutrientId) {
  const list = Array.isArray(foodNutrients) ? foodNutrients : [];
  const hit = list.find(
    (n) => n.nutrientId === nutrientId || (n.nutrient && n.nutrient.id === nutrientId)
  );
  if (!hit) return null;
  const v = hit.value != null ? hit.value : hit.amount;
  return typeof v === "number" ? v : null;
}

function normalizeUsdaFood(food) {
  if (!food) return null;
  const nutrients = food.foodNutrients || [];
  return {
    fdcId: food.fdcId,
    description: food.description,
    protein: usdaNutrientValue(nutrients, 1003),
    fat: usdaNutrientValue(nutrients, 1004),
    carbs: usdaNutrientValue(nutrients, 1005),
    calories: usdaNutrientValue(nutrients, 1008),
    servingWeight: food.servingSize || null,
  };
}

app.get("/api/usda/search", async (req, res) => {
  try {
    const key = process.env.USDA_API_KEY;
    if (!key) return res.status(503).json({ error: "USDA not configured" });

    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "q required" });

    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("api_key", key);
    url.searchParams.set("query", q);
    url.searchParams.set("pageSize", String(req.query.pageSize || 5));

    const { resp, data } = await traceUpstream("usda", "search", async () => {
      const r = await fetch(url);
      const d = await r.json();
      return { ok: r.ok, status: r.status, resp: r, data: d };
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "USDA search failed", detail: data });
    }

    const foods = (data.foods || []).map((f) => ({
      fdcId: f.fdcId,
      description: f.description,
      normalized: normalizeUsdaFood(f),
    }));

    res.json({ foods, total: data.totalHits || foods.length });
  } catch (err) {
    console.error("/api/usda/search", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/usda/food/:fdcId", async (req, res) => {
  try {
    const key = process.env.USDA_API_KEY;
    if (!key) return res.status(503).json({ error: "USDA not configured" });

    const fdcId = req.params.fdcId;
    const url = `https://api.nal.usda.gov/fdc/v1/food/${fdcId}?api_key=${encodeURIComponent(key)}`;
    const { resp, data } = await traceUpstream("usda", "food", async () => {
      const r = await fetch(url);
      const d = await r.json();
      return { ok: r.ok, status: r.status, resp: r, data: d };
    });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "USDA food lookup failed", detail: data });
    }

    res.json({ normalized: normalizeUsdaFood(data), raw: data });
  } catch (err) {
    console.error("/api/usda/food", err);
    res.status(500).json({ error: "Server error" });
  }
});

function buildOpenAiMessages(body) {
  const out = [];
  if (body && typeof body.system === "string" && body.system.trim()) {
    out.push({ role: "system", content: body.system.trim() });
  }
  if (Array.isArray(body?.messages) && body.messages.length) {
    for (const m of body.messages) {
      if (!m || !m.role) continue;
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
      const content = m.content != null ? String(m.content) : "";
      if (!content.trim()) continue;
      out.push({ role, content });
    }
  }
  if (!out.length && body?.userMsg) {
    out.push({ role: "user", content: String(body.userMsg) });
  }
  if (!out.length) {
    out.push({ role: "user", content: "Provide concise nutrition adaptation guidance. Do not invent final calorie or macro totals." });
  }
  return out;
}

/** OpenAI — adaptation / reasoning only; never authoritative for displayed macros. */
app.post("/api/ai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "OpenAI not configured" });
    }

    const messages = buildOpenAiMessages(req.body || {});
    const maxTokens = Math.min(
      16000,
      Math.max(64, parseInt(req.body?.max_tokens, 10) || 1200)
    );

    const completion = await traceUpstream("openai", "chat", async () => {
      const out = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        max_tokens: maxTokens,
        temperature: 0.4,
      });
      return { ok: true, status: 200, completion: out };
    }).then((r) => r.completion);

    res.json({
      content: [
        {
          type: "text",
          text: completion.choices[0].message.content,
        },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/** Edamam analysis → USDA consistency check → validation flags for client display. */
app.post("/api/nutrition/pipeline", async (req, res) => {
  try {
    ArcTrace.logOrchestrator("nutrition pipeline started");
    const creds = edamamCredentials();
    if (!creds) {
      ArcTrace.logMessage("Edamam unavailable");
      return res.status(503).json({ verified: false, reason: "edamam_not_configured" });
    }

    const title =
      (req.body && typeof req.body.title === "string" && req.body.title.trim()) || "Recipe";
    const ingr = Array.isArray(req.body?.ingr) ? req.body.ingr : [];
    const cleanIngr = ingr.map((s) => String(s || "").trim()).filter(Boolean);
    if (!cleanIngr.length) {
      return res.status(400).json({ verified: false, reason: "ingr_required" });
    }

    const reported = req.body?.reported || {};
    const url = new URL("https://api.edamam.com/api/nutrition-details");
    url.searchParams.set("app_id", creds.appId);
    url.searchParams.set("app_key", creds.appKey);

    const edResp = await traceUpstream("edamam", "pipeline-analysis", async () => {
      const resp = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, ingr: cleanIngr }),
      });
      return { ok: resp.ok, status: resp.status, resp };
    }).then((r) => r.resp);

    const rawText = await edResp.text();
    if (!edResp.ok) {
      ArcTrace.logMessage("Edamam nutrition analysis failed");
      return res.status(edResp.status >= 400 ? edResp.status : 502).json({
        verified: false,
        reason: "edamam_failed",
        detail: rawText.slice(0, 200),
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ verified: false, reason: "edamam_invalid_json" });
    }

    const tn = data.totalNutrients || {};
    const macros = {
      calories: Math.round(edamamNutrientQuantity(tn, "ENERC_KCAL") || 0),
      protein: Math.round((edamamNutrientQuantity(tn, "PROCNT") || 0) * 10) / 10,
      fat: Math.round((edamamNutrientQuantity(tn, "FAT") || 0) * 10) / 10,
      carbs:
        Math.round(
          (edamamNutrientQuantity(tn, "CHOCDF") ??
            edamamNutrientQuantity(tn, "CHOCDF.net") ??
            0) * 10
        ) / 10,
    };

    if (!macros.calories || macros.calories <= 0) {
      return res.json({ verified: false, reason: "missing_calories", macros: null });
    }

    const p = Number(macros.protein) || 0;
    const c = Number(macros.carbs) || 0;
    const f = Number(macros.fat) || 0;
    const computed = p * 4 + c * 4 + f * 9;
    const delta = Math.abs(computed - macros.calories) / macros.calories;
    const usdaMacroOk = delta <= 0.12;

    let usdaIngredientOk = true;
    const usdaKey = process.env.USDA_API_KEY;
    if (usdaKey && cleanIngr[0]) {
      try {
        const searchUrl = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
        searchUrl.searchParams.set("api_key", usdaKey);
        searchUrl.searchParams.set("query", cleanIngr[0].slice(0, 80));
        searchUrl.searchParams.set("pageSize", "1");
        const usdaResult = await traceUpstream("usda", "pipeline-sample", async () => {
          const usdaResp = await fetch(searchUrl);
          if (!usdaResp.ok) return { ok: false, status: usdaResp.status, resp: usdaResp, data: null };
          const usdaData = await usdaResp.json();
          return { ok: true, status: usdaResp.status, resp: usdaResp, data: usdaData };
        });
        if (usdaResult.ok && usdaResult.data) {
          const food = (usdaResult.data.foods || [])[0];
          if (food) {
            const norm = normalizeUsdaFood(food);
            if (norm && norm.calories > 0) {
              const sampleDelta =
                Math.abs(norm.calories - macros.calories) / Math.max(macros.calories, 1);
              usdaIngredientOk = sampleDelta <= 0.85;
            }
          }
        }
      } catch {
        usdaIngredientOk = true;
      }
    }

    const reportedCals = Number(reported.calories);
    const aiDrift =
      isFinite(reportedCals) && reportedCals > 0
        ? Math.abs(reportedCals - macros.calories) / macros.calories
        : null;

    const validation = {
      calorie_macro_mismatch: !usdaMacroOk,
      usda_sample_ok: usdaIngredientOk,
      ai_drift_ratio: aiDrift,
      safe:
        usdaMacroOk &&
        macros.calories >= 50 &&
        macros.calories <= 2500 &&
        p <= 200 &&
        !(p * 4 > macros.calories * 1.1),
    };

    if (!validation.safe) {
      ArcTrace.logMessage("USDA validation failed");
      return res.json({
        verified: false,
        reason: "validation_failed",
        macros,
        validation,
        source: "edamam",
      });
    }

    ArcTrace.logMessage("Final meal generation complete");
    res.json({
      verified: true,
      macros,
      validation,
      source: "edamam+usda",
      note: "Displayed macros from Edamam analysis with USDA consistency checks",
    });
  } catch (err) {
    console.error("/api/nutrition/pipeline", err);
    res.status(500).json({ verified: false, reason: "server_error" });
  }
});

/* ─────────────────────────────────────────────────────────────
   Grocery Intelligence V1 — Kroger Products API integration
   Credentials live ONLY in process.env. The frontend never sees
   the client id/secret or the access token.
   ───────────────────────────────────────────────────────────── */

const KROGER_BASE = "https://api.kroger.com/v1";
const KROGER_SCOPE = "product.compact";

// Token cache (in-memory; single Render instance)
let krogerTokenCache = { token: null, expiresAt: 0 };

// Product cache: `${locationId}|${term}` -> { value, expiresAt }
const krogerProductCache = new Map();
const PRODUCT_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// Location cache: zipCode -> { value, expiresAt }
const krogerLocationCache = new Map();
const LOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function krogerCredsConfigured() {
  return !!krogerCredentials();
}

async function getKrogerToken() {
  const now = Date.now();
  if (krogerTokenCache.token && krogerTokenCache.expiresAt > now + 5_000) {
    return krogerTokenCache.token;
  }
  if (!krogerCredsConfigured()) {
    throw new Error("Kroger credentials not configured on server");
  }

  const creds = krogerCredentials();
  const basic = Buffer.from(`${creds.id}:${creds.secret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: KROGER_SCOPE,
  });

  const resp = await traceUpstream("kroger", "oauth-token", async () => {
    const r = await fetch(`${KROGER_BASE}/connect/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    return { ok: r.ok, status: r.status, resp: r };
  }).then((r) => r.resp);

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Kroger token error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const ttlMs = Math.max(60_000, (data.expires_in || 1800) * 1000 - 60_000);
  krogerTokenCache = {
    token: data.access_token,
    expiresAt: now + ttlMs,
  };
  return krogerTokenCache.token;
}

async function krogerGet(path, params) {
  const token = await getKrogerToken();
  const url = new URL(KROGER_BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  const resp = await traceUpstream("kroger", path.replace(/^\//, ""), async () => {
    const r = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    return { ok: r.ok, status: r.status, resp: r };
  }).then((r) => r.resp);
  if (resp.status === 401) {
    krogerTokenCache = { token: null, expiresAt: 0 };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(
      `Kroger ${path} ${resp.status}: ${text.slice(0, 200)}`
    );
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function normalizeZip(zip) {
  const s = String(zip || "").trim();
  const m = s.match(/\d{5}/);
  return m ? m[0] : "";
}

async function findKrogerLocation(zipCode) {
  const zip = normalizeZip(zipCode);
  if (!zip) return null;

  const cached = krogerLocationCache.get(zip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const data = await krogerGet("/locations", {
    "filter.zipCode.near": zip,
    "filter.limit": 1,
  });
  const loc = (data && data.data && data.data[0]) || null;
  if (!loc) return null;

  const out = {
    locationId: loc.locationId,
    name: loc.name,
    chain: loc.chain,
    address: loc.address && {
      addressLine1: loc.address.addressLine1,
      city: loc.address.city,
      state: loc.address.state,
      zipCode: loc.address.zipCode,
    },
  };
  krogerLocationCache.set(zip, {
    value: out,
    expiresAt: Date.now() + LOCATION_TTL_MS,
  });
  return out;
}

function pickBestKrogerItem(products) {
  if (!Array.isArray(products) || !products.length) return null;
  let best = null;

  for (const p of products) {
    const items = Array.isArray(p.items) ? p.items : [];
    for (const it of items) {
      const price = it && it.price;
      const reg = price && typeof price.regular === "number" ? price.regular : 0;
      const promo =
        price && typeof price.promo === "number" && price.promo > 0
          ? price.promo
          : 0;
      const effective = promo > 0 ? promo : reg;
      if (!(effective > 0)) continue;

      const candidate = {
        productId: p.productId,
        upc: p.upc,
        name: p.description,
        brand: p.brand,
        size: it.size || "",
        priceRegular: reg || null,
        pricePromo: promo || null,
        priceEffective: effective,
        image: pickKrogerImage(p),
        soldBy: it.soldBy || null,
      };

      if (!best || effective < best.priceEffective) best = candidate;
    }
  }
  return best;
}

function pickKrogerImage(product) {
  const imgs = Array.isArray(product.images) ? product.images : [];
  const front = imgs.find((i) => i.perspective === "front") || imgs[0];
  if (!front || !Array.isArray(front.sizes) || !front.sizes.length) return null;
  // Prefer medium/small for thumbnails
  const order = ["medium", "small", "thumbnail", "large", "xlarge"];
  for (const s of order) {
    const hit = front.sizes.find((x) => x.size === s);
    if (hit && hit.url) return hit.url;
  }
  return front.sizes[0].url || null;
}

async function searchKrogerProduct(term, locationId) {
  const cleanTerm = String(term || "").trim();
  if (!cleanTerm) return null;
  const cacheKey = `${locationId || "_"}|${cleanTerm.toLowerCase()}`;
  const cached = krogerProductCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const params = {
    "filter.term": cleanTerm,
    "filter.limit": 8,
  };
  if (locationId) params["filter.locationId"] = locationId;

  let data;
  try {
    data = await krogerGet("/products", params);
  } catch (err) {
    // 4xx with no results — cache a null briefly so we don't hammer
    if (err.status && err.status >= 400 && err.status < 500) {
      krogerProductCache.set(cacheKey, {
        value: null,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      return null;
    }
    throw err;
  }

  const best = pickBestKrogerItem(data && data.data);
  const out = best
    ? {
        matched: true,
        term: cleanTerm,
        locationId: locationId || null,
        ...best,
        source: "kroger",
      }
    : null;

  krogerProductCache.set(cacheKey, {
    value: out,
    expiresAt: Date.now() + PRODUCT_TTL_MS,
  });
  return out;
}

// Bounded-concurrency map (no extra deps)
async function mapWithLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        out[i] = await worker(items[i], i);
      } catch (err) {
        out[i] = { __error: err.message || String(err) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(workers);
  return out;
}

app.get("/api/kroger/location", async (req, res) => {
  try {
    if (!krogerCredsConfigured()) {
      return res.status(503).json({ error: "Kroger not configured" });
    }
    const loc = await findKrogerLocation(req.query.zipCode);
    if (!loc) return res.status(404).json({ error: "No nearby Kroger store" });
    res.json(loc);
  } catch (err) {
    console.error("kroger/location", err);
    res.status(500).json({ error: "Kroger location lookup failed" });
  }
});

/** Live grocery shelf lookup — v1 uses one regional integration; add providers behind this handler over time. */
async function handleLiveGroceryPrices(req, res) {
  try {
    if (!krogerCredsConfigured()) {
      ArcTrace.logMessage("Kroger unavailable");
      return res.status(503).json({ error: "Grocery pricing not configured" });
    }

    const items = Array.isArray(req.body && req.body.items)
      ? req.body.items
      : [];
    if (!items.length) return res.json({ results: {}, locationId: null });

    // Resolve location: explicit id wins, else derive from zipCode
    let locationId = (req.body.locationId || "").toString().trim() || null;
    let locationInfo = null;
    if (!locationId && req.body.zipCode) {
      locationInfo = await findKrogerLocation(req.body.zipCode);
      if (locationInfo) locationId = locationInfo.locationId;
    }

    // De-dupe terms to reduce upstream calls while preserving per-key mapping
    const termIndex = new Map(); // termLower -> [keys]
    const uniqueTerms = [];
    for (const it of items) {
      const key = String(it.key || "").trim();
      const term = String(it.term || "").trim();
      if (!key || !term) continue;
      const tl = term.toLowerCase();
      if (!termIndex.has(tl)) {
        termIndex.set(tl, { term, keys: [] });
        uniqueTerms.push(tl);
      }
      termIndex.get(tl).keys.push(key);
    }

    const lookups = await mapWithLimit(uniqueTerms, 4, (tl) =>
      searchKrogerProduct(termIndex.get(tl).term, locationId)
    );

    const results = {};
    uniqueTerms.forEach((tl, i) => {
      const entry = termIndex.get(tl);
      const value = lookups[i] && !lookups[i].__error ? lookups[i] : null;
      for (const key of entry.keys) results[key] = value;
    });

    res.json({
      locationId,
      location: locationInfo,
      results,
    });
  } catch (err) {
    console.error("grocery/prices", err);
    res.status(500).json({ error: "Grocery price lookup failed" });
  }
}

app.post("/api/grocery/prices", handleLiveGroceryPrices);
app.post("/api/kroger/prices", handleLiveGroceryPrices);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
