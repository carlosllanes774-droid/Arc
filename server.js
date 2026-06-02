import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { existsSync, readFileSync, writeFileSync } from "fs";
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

function loadEdamamHelpers() {
  const src = readFileSync(path.join(__dirname, "js/arc-api/edamamHelpers.js"), "utf8");
  const sandbox = { console, ArcApi: {}, process, ARC_PIPELINE_TRACE_VERBOSE: process.env.ARC_PIPELINE_TRACE_VERBOSE };
  vm.runInContext(src, vm.createContext(sandbox));
  return sandbox.ArcApi.Edamam;
}

const EdamamHelpers = loadEdamamHelpers();

function loadArcValidation() {
  const src = readFileSync(path.join(__dirname, "js/arc-api/arcValidationService.js"), "utf8");
  const sandbox = { ArcApi: {} };
  vm.runInContext(src, vm.createContext(sandbox));
  return sandbox.ArcApi.Validation;
}

const ArcValidation = loadArcValidation();

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
  const appId = (process.env.EDAMAM_APP_ID || "").trim();
  const appKey = (process.env.EDAMAM_API_KEY || "").trim();
  if (!appId || !appKey) {
    if (process.env.EDAMAM_APP_KEY) {
      ArcTrace.logMessage("Edamam auth rejected");
    }
    return null;
  }
  return appId && appKey ? { appId, appKey } : null;
}

function arcPipelineLog(message, extra) {
  if (extra && Object.keys(extra).length) {
    console.log(`[ARC PIPELINE] ${message}`, extra);
    return;
  }
  console.log(`[ARC PIPELINE] ${message}`);
}

const OPENAI_TIMEOUT_MS = 8000;
const OPENAI_WEEK_GENERATION_TIMEOUT_MS = 120000;
const OPENAI_CACHE_TTL_MS = 20 * 60 * 1000;
const openAiResponseCache = new Map();
const openAiInFlight = new Map();

function stableStringify(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  const out = [];
  for (const key of keys) out.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
  return `{${out.join(",")}}`;
}

function getCachedOpenAiResponse(key) {
  const cached = openAiResponseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    openAiResponseCache.delete(key);
    return null;
  }
  return cached.value;
}

function setCachedOpenAiResponse(key, value, ttlMs) {
  openAiResponseCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function hasLikelyConcatenatedPayloads(raw) {
  if (typeof raw !== "string") return false;
  return /}\s*{/.test(raw) || /]\s*\[/.test(raw);
}

function hasLikelyIncompleteJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return true;
  try {
    JSON.parse(raw);
    return false;
  } catch (_err) {
    return true;
  }
}

function hasLikelyMergedPayloadFragments(raw) {
  if (typeof raw !== "string") return false;
  return /"content"\s*:\s*\[[\s\S]*"content"\s*:\s*\[/.test(raw);
}

function hasLikelyDuplicatedObjects(raw) {
  if (typeof raw !== "string") return false;
  return /}\s*,\s*{/.test(raw) && /"type"\s*:\s*"text"[\s\S]*"type"\s*:\s*"text"/.test(raw);
}

function debugSendAiJson(res, payload, sourceLabel) {
  const raw = JSON.stringify(payload);
  const rawLength = raw.length;
  const trimmed = raw.trim();
  const endsCorrectly = trimmed.endsWith("}") || trimmed.endsWith("]");
  const multipleConcatenatedPayloads = hasLikelyConcatenatedPayloads(raw);
  const incompleteJson = hasLikelyIncompleteJson(raw);
  const mergedPayloadFragments = hasLikelyMergedPayloadFragments(raw);
  const duplicatedObjects = hasLikelyDuplicatedObjects(raw);
  const hasPartialArrays = incompleteJson && /\[[^\]]*$/.test(raw);
  const enhancementPayloadMergedIncorrectly = !!(
    payload &&
    typeof payload === "object" &&
    (payload.enhancementFallback || sourceLabel === "enhancement_fallback") &&
    (multipleConcatenatedPayloads || mergedPayloadFragments || duplicatedObjects)
  );

  writeFileSync(path.join(__dirname, "arc-debug-response.json"), raw, "utf8");

  console.log("[ARC DEBUG] exact response source:", sourceLabel);
  console.log("[ARC DEBUG] exact response length:", rawLength);
  console.log("[ARC DEBUG] exact response raw:", raw);
  console.log("[ARC DEBUG] validation:", {
    validJsonStringifyOutput: typeof raw === "string",
    payloadEndsCorrectly: endsCorrectly,
    containsMultipleConcatenatedPayloads: multipleConcatenatedPayloads,
    containsIncompleteJson: incompleteJson,
    hasPartialArrays,
    hasMergedPayloadFragments: mergedPayloadFragments,
    hasDuplicatedObjects: duplicatedObjects,
    enhancementPayloadMergedIncorrectly,
  });

  return res.type("application/json").send(raw);
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

/** Authoritative browser UI — tests and docs reference Index1.html (not index.html). */
const ARC_UI_HTML = path.join(ROOT, "Index.html");
if (!existsSync(ARC_UI_HTML)) {
  console.error("[Arc] Missing UI entry:", ARC_UI_HTML);
}

/** Scoped static assets only — never serve repo root or node_modules. */
app.use("/js", express.static(path.join(ROOT, "js"), { index: false, dotfiles: "deny" }));
app.use("/assets", express.static(path.join(ROOT, "assets"), { index: false, dotfiles: "deny" }));

function sendArcUi(_req, res) {
  res.sendFile(ARC_UI_HTML);
}

app.get("/", sendArcUi);
app.get("/Index.html", sendArcUi);
app.get("/Index1.html", sendArcUi);

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

function macrosFromEdamamData(data) {
  const tn = (data && data.totalNutrients) || {};
  const kcal = edamamNutrientQuantity(tn, "ENERC_KCAL");
  const protein = edamamNutrientQuantity(tn, "PROCNT");
  const fat = edamamNutrientQuantity(tn, "FAT");
  const carbs =
    edamamNutrientQuantity(tn, "CHOCDF") ?? edamamNutrientQuantity(tn, "CHOCDF.net");
  return {
    calories: kcal != null ? Math.round(kcal) : null,
    protein: protein != null ? Math.round(protein * 10) / 10 : null,
    fat: fat != null ? Math.round(fat * 10) / 10 : null,
    carbs: carbs != null ? Math.round(carbs * 10) / 10 : null,
  };
}

function edamamNutritionUrl(creds) {
  const url = new URL(EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT);
  url.searchParams.set("app_id", creds.appId);
  url.searchParams.set("app_key", creds.appKey);
  return url;
}

/**
 * POST Edamam nutrition-details with normalized { title, ingr }.
 * @returns {Promise<{ ok: boolean, status: number, data?: object, rawText?: string, failureKind?: string }>}
 */
async function callEdamamNutritionDetails(creds, title, cleanIngr, operation) {
  const payloadCheck = EdamamHelpers.validateEdamamPayload({ title, ingr: cleanIngr });
  if (!payloadCheck.valid) {
    arcPipelineLog("Invalid payload detected", {
      operation,
      endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
      authRejected: false,
      endpointMismatch: false,
      statusCode: 400,
    });
    EdamamHelpers.logEdamamFailure(ArcTrace, "payload", {
      httpStatus: 400,
      endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
      operation,
      payloadValid: false,
      payloadReason: payloadCheck.reason,
      ingredientCount: cleanIngr.length,
    });
    return { ok: false, status: 400, failureKind: "payload", payloadError: payloadCheck.reason };
  }

  const url = edamamNutritionUrl(creds);
  const edResp = await traceUpstream("edamam", operation, async () => {
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, ingr: cleanIngr }),
    });
    return { ok: resp.ok, status: resp.status, resp };
  }).then((r) => r.resp);

  if (edResp.status === 304) {
    return { ok: true, status: 304, notModified: true };
  }

  const rawText = await edResp.text();
  if (!edResp.ok) {
    const failureKind = EdamamHelpers.classifyEdamamFailure(edResp.status, rawText);
    const endpointMismatch = failureKind === "endpoint";
    const authRejected = failureKind === "auth";
    arcPipelineLog(
      authRejected ? "Edamam auth rejected" : endpointMismatch ? "Edamam endpoint mismatch" : "Edamam request rejected",
      {
        operation,
        endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
        authRejected,
        endpointMismatch,
        statusCode: edResp.status,
      }
    );
    EdamamHelpers.logEdamamFailure(ArcTrace, failureKind, {
      httpStatus: edResp.status,
      endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
      operation,
      payloadValid: true,
      ingredientCount: cleanIngr.length,
      bodyPreview: EdamamHelpers.sanitizeEdamamBody(rawText, 300),
    });
    return { ok: false, status: edResp.status, failureKind, rawText };
  }

  try {
    return { ok: true, status: edResp.status, data: JSON.parse(rawText) };
  } catch {
    arcPipelineLog("Invalid payload detected", {
      operation,
      endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
      authRejected: false,
      endpointMismatch: false,
      statusCode: 502,
    });
    return { ok: false, status: 502, failureKind: "other", rawText };
  }
}

function spoonacularNutrientsFromRecipe(recipe) {
  const nutrients = recipe && recipe.nutrition && recipe.nutrition.nutrients;
  if (!Array.isArray(nutrients) || !nutrients.length) return null;
  const find = (name) => nutrients.find((n) => n && n.name === name);
  const cal = find("Calories");
  const protein = find("Protein");
  const fat = find("Fat");
  const carbs = find("Carbohydrates");
  const calories = cal && typeof cal.amount === "number" ? Math.round(cal.amount) : null;
  if (!calories || calories <= 0) return null;
  return {
    calories,
    protein: protein && typeof protein.amount === "number" ? Math.round(protein.amount * 10) / 10 : 0,
    fat: fat && typeof fat.amount === "number" ? Math.round(fat.amount * 10) / 10 : 0,
    carbs: carbs && typeof carbs.amount === "number" ? Math.round(carbs.amount * 10) / 10 : 0,
  };
}

async function fetchSpoonacularNutrition(recipeId) {
  const key = spoonacularKey();
  if (!key || !recipeId) return null;
  const params = new URLSearchParams({
    apiKey: key,
    ids: String(recipeId),
    includeNutrition: "true",
  });
  const url = `https://api.spoonacular.com/recipes/informationBulk?${params}`;
  try {
    const { resp, data } = await traceUpstream("spoonacular", "nutrition-fallback", async () => {
      const r = await fetch(url);
      const d = await r.json();
      return { ok: r.ok, status: r.status, resp: r, data: d, fallback: true };
    });
    if (!resp.ok) return null;
    const list = Array.isArray(data) ? data : [];
    return spoonacularNutrientsFromRecipe(list[0]);
  } catch {
    return null;
  }
}

function usdaMatchWeight(query, description) {
  const q = String(query || "").toLowerCase();
  const d = String(description || "").toLowerCase();
  if (!q || !d) return 0;
  const qTokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!qTokens.length) return 0;
  let overlap = 0;
  for (const token of qTokens) {
    if (d.includes(token)) overlap += 1;
  }
  return overlap / qTokens.length;
}

function parseIngredientWeightHint(line) {
  const s = String(line || "").toLowerCase();
  const num = parseFloat((s.match(/(\d+(\.\d+)?)/) || [])[1] || "1");
  if (s.includes("oz")) return Math.max(0.25, num * 28.35);
  if (s.includes("g ")) return Math.max(0.25, num);
  if (s.includes("kg")) return Math.max(0.25, num * 1000);
  if (s.includes("lb")) return Math.max(0.25, num * 453.6);
  if (s.includes("tbsp")) return Math.max(0.25, num * 14);
  if (s.includes("tsp")) return Math.max(0.25, num * 5);
  if (s.includes("cup")) return Math.max(0.25, num * 120);
  return Math.max(0.25, num * 50);
}

async function aggregateUsdaNutritionFromIngredients(ingr) {
  const usdaKey = process.env.USDA_API_KEY;
  if (!usdaKey || !ingr.length) return null;

  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let countedWeight = 0;
  const lines = ingr.slice(0, 8);

  for (const line of lines) {
    try {
      const searchUrl = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
      searchUrl.searchParams.set("api_key", usdaKey);
      searchUrl.searchParams.set("query", line.slice(0, 80));
      searchUrl.searchParams.set("pageSize", "4");
      const usdaResult = await traceUpstream("usda", "nutrition-fallback", async () => {
        const usdaResp = await fetch(searchUrl);
        if (!usdaResp.ok) return { ok: false, status: usdaResp.status, data: null, fallback: true };
        const usdaData = await usdaResp.json();
        return { ok: true, status: usdaResp.status, data: usdaData, fallback: true };
      });
      const foods = usdaResult.ok && usdaResult.data ? (usdaResult.data.foods || []) : [];
      if (!foods.length) continue;
      const bestFood = foods
        .map((f) => ({ food: f, score: usdaMatchWeight(line, f.description) }))
        .sort((a, b) => b.score - a.score)[0];
      const norm = bestFood && bestFood.food ? normalizeUsdaFood(bestFood.food) : null;
      if (norm && norm.calories > 0) {
        const weightHint = parseIngredientWeightHint(line);
        const scoreWeight = Math.max(0.3, bestFood.score || 0.3);
        const factor = (weightHint / 100) * scoreWeight;
        totals.calories += norm.calories * factor;
        totals.protein += (norm.protein || 0) * factor;
        totals.carbs += (norm.carbs || 0) * factor;
        totals.fat += (norm.fat || 0) * factor;
        countedWeight += factor;
      }
    } catch {
      /* continue other ingredients */
    }
  }

  if (!countedWeight) return null;
  return {
    calories: Math.round(totals.calories),
    protein: Math.round(totals.protein * 10) / 10,
    carbs: Math.round(totals.carbs * 10) / 10,
    fat: Math.round(totals.fat * 10) / 10,
  };
}

/**
 * Spoonacular (recipe id) → USDA (ingredient lines). Never throws.
 */
function edamamDiagnosticLog(message, detail) {
  if (detail && typeof detail === "object") {
    console.log(`[ARC EDAMAM] ${message}`, detail);
    return;
  }
  console.log(`[ARC EDAMAM] ${message}`);
}

async function nutritionFallbackAfterEdamam({ ingr, spoonacularRecipeId }) {
  edamamDiagnosticLog("spoonacular fallback recipe id", {
    spoonacularRecipeId: spoonacularRecipeId != null ? spoonacularRecipeId : null,
  });
  const spoonMacros = await fetchSpoonacularNutrition(spoonacularRecipeId);
  if (spoonMacros && spoonMacros.calories > 0) {
    ArcTrace.logFallback("spoonacular", "edamam_failed");
    arcPipelineLog("Nutrition confidence LOW");
    edamamDiagnosticLog("fallback nutrition source", { source: "spoonacular" });
    return { macros: spoonMacros, source: "spoonacular", provider: "spoonacular" };
  }

  const usdaMacros = await aggregateUsdaNutritionFromIngredients(ingr);
  if (usdaMacros && usdaMacros.calories > 0) {
    ArcTrace.logFallback("usda", "edamam_failed");
    arcPipelineLog("USDA reconciliation success");
    arcPipelineLog("Nutrition confidence MEDIUM");
    edamamDiagnosticLog("fallback nutrition source", { source: "usda" });
    return { macros: usdaMacros, source: "usda", provider: "usda" };
  }

  edamamDiagnosticLog("fallback nutrition source", { source: null });
  return null;
}

function determineNutritionConfidence(source, usdaValidated) {
  if (source === "edamam+usda" && usdaValidated) return "high";
  if (source === "usda" || (source === "edamam" && usdaValidated)) return "medium";
  return "low";
}

/** Proxy to Edamam Nutrition Analysis — keeps app_id / app_key on the server only. */
app.post("/api/nutrition", async (req, res) => {
  try {
    const creds = edamamCredentials();
    if (!creds) {
      return res.status(503).json({ error: "Edamam credentials not configured" });
    }

    const title =
      (req.body && typeof req.body.title === "string" && req.body.title.trim()) ||
      "Recipe";
    const rawIngr = Array.isArray(req.body && req.body.ingr) ? req.body.ingr : [];
    const cleanIngr = EdamamHelpers.normalizeIngredientLines(rawIngr);
    if (!cleanIngr.length) {
      EdamamHelpers.logEdamamFailure(ArcTrace, "payload", {
        httpStatus: 400,
        endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
        operation: "nutrition-details",
        payloadValid: false,
        payloadReason: "ingr must be a non-empty array of strings",
        ingredientCount: 0,
      });
      return res.status(400).json({ error: "ingr must be a non-empty array of strings" });
    }

    const result = await callEdamamNutritionDetails(creds, title, cleanIngr, "nutrition-details");

    if (result.payloadError) {
      return res.status(400).json({ error: result.payloadError });
    }

    if (result.notModified) {
      return res.status(200).json({
        totalNutrients: null,
        notModified: true,
        message: "Use cached nutrition for this recipe fingerprint",
      });
    }

    if (!result.ok) {
      const fallback = await nutritionFallbackAfterEdamam({
        ingr: cleanIngr,
        spoonacularRecipeId: req.body && req.body.spoonacularRecipeId,
      });
      if (fallback) {
        const confidence = fallback.source === "usda" ? "medium" : "low";
        arcPipelineLog(`Nutrition confidence ${confidence.toUpperCase()}`);
        return res.json({
          totalNutrients: fallback.macros,
          source: fallback.source,
          fallback: true,
          nutritionConfidence: confidence,
          dietLabels: [],
          healthLabels: [],
        });
      }
      return res.status(result.status >= 400 && result.status < 600 ? result.status : 502).json({
        error: "Edamam request failed",
        detail: EdamamHelpers.sanitizeEdamamBody(result.rawText, 300),
        failureKind: result.failureKind,
      });
    }

    const macros = macrosFromEdamamData(result.data);
    res.json({
      totalNutrients: macros,
      dietLabels: result.data.dietLabels || [],
      healthLabels: result.data.healthLabels || [],
      source: "edamam",
      nutritionConfidence: "high",
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

    const lines = text.split(/\n+/).map((s) => EdamamHelpers.normalizeIngredientLine(s)).filter(Boolean);
    const ingr = EdamamHelpers.normalizeIngredientLines(lines.length ? lines : [text]);

    const result = await callEdamamNutritionDetails(creds, "Parsed input", ingr, "parse");
    if (result.payloadError) {
      return res.status(400).json({ error: result.payloadError });
    }
    if (!result.ok) {
      return res.status(result.status >= 400 ? result.status : 502).json({
        error: "Edamam parse failed",
        detail: EdamamHelpers.sanitizeEdamamBody(result.rawText, 300),
        failureKind: result.failureKind,
      });
    }

    const tn = result.data.totalNutrients || {};
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
    const recipes = list.map((r) => {
      const nutrition = spoonacularNutrientsFromRecipe(r);
      return {
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
        nutrition: nutrition || undefined,
        calories: nutrition && nutrition.calories,
        protein: nutrition && nutrition.protein,
        carbs: nutrition && nutrition.carbs,
        fat: nutrition && nutrition.fat,
      };
    });

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
    out.push({ role: "system", content: body.system.trim().slice(0, 700) });
  }
  if (Array.isArray(body?.messages) && body.messages.length) {
    for (const m of body.messages.slice(-4)) {
      if (!m || !m.role) continue;
      const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
      const content = m.content != null ? String(m.content).slice(0, 2500) : "";
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

function openAiTaskTokenLimit(taskType) {
  const task = String(taskType || "optimization").toLowerCase();
  if (task === "week_generation") return 6000;
  if (task === "week_recipe_library") return 2000;
  if (task === "week_meal_assignment") return 1200;
  if (task === "instruction_enhancement") return 250;
  if (task === "tagging" || task === "classification" || task === "optimization_classification") return 90;
  return 220;
}

function openAiTaskTimeoutMs(taskType) {
  const task = String(taskType || "optimization").toLowerCase();
  if (task === "week_generation" || task === "week_recipe_library" || task === "week_meal_assignment") {
    return OPENAI_WEEK_GENERATION_TIMEOUT_MS;
  }
  return OPENAI_TIMEOUT_MS;
}

/** OpenAI — adaptation / reasoning only; never authoritative for displayed macros. */
app.post("/api/ai", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ error: "OpenAI not configured" });
    }

    const body = req.body || {};
    const messages = buildOpenAiMessages(body);
    const taskType = body.taskType || "optimization";
    const taskCap = openAiTaskTokenLimit(taskType);
    const requested = parseInt(body?.max_tokens, 10);
    const maxTokens = Math.max(64, Math.min(taskCap, Number.isFinite(requested) ? requested : taskCap));
    const timeoutMs = openAiTaskTimeoutMs(taskType);
    arcPipelineLog("timeout policy applied", { taskType, timeoutMs });
    const cacheKey = stableStringify({ taskType, maxTokens, messages });

    const cached = getCachedOpenAiResponse(cacheKey);
    if (cached) {
      arcPipelineLog("OpenAI cached response used", { durationMs: 0, taskType });
      return debugSendAiJson(res, cached, "cache_hit");
    }

    if (openAiInFlight.has(cacheKey)) {
      const shared = await openAiInFlight.get(cacheKey);
      arcPipelineLog("OpenAI cached response used", { durationMs: 0, taskType, deduped: true });
      return debugSendAiJson(res, shared, "inflight_shared");
    }

    const run = (async () => {
      const started = Date.now();
      arcPipelineLog("OpenAI request started", { taskType, maxTokens });
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);
      try {
        const completion = await traceUpstream("openai", "chat", async () => {
          const out = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages,
            max_tokens: maxTokens,
            temperature: 0.2,
          }, { signal: abortController.signal });
          return { ok: true, status: 200, completion: out };
        }).then((r) => r.completion);
        const choice = completion.choices?.[0] || {};
        const finishReason = choice.finish_reason || null;
        const fullText = String(choice.message?.content || "");
        const SLICE_CAP = 4000;
        const slicedText = fullText.slice(0, SLICE_CAP);
        const payload = {
          content: [
            {
              type: "text",
              text: slicedText,
            },
          ],
          _meta: {
            finish_reason: finishReason,
            hit_token_limit: finishReason === "length",
            usage: completion.usage || null,
            max_tokens_requested: Number.isFinite(requested) ? requested : null,
            max_tokens_applied: maxTokens,
            content_length_before_slice: fullText.length,
            content_truncated_by_slice: fullText.length > SLICE_CAP,
          },
        };
        const rawText = payload.content[0].text;
        arcPipelineLog("OpenAI text enhancement payload received", {
          taskType,
          textLength: rawText.length,
          finishReason,
          hitTokenLimit: finishReason === "length",
          contentLengthBeforeSlice: fullText.length,
          contentTruncatedBySlice: fullText.length > SLICE_CAP,
          maxTokensApplied: maxTokens,
          maxTokensRequested: Number.isFinite(requested) ? requested : null,
          usage: completion.usage || null
        });
        if (Number.isFinite(requested) && requested > maxTokens) {
          arcPipelineLog("OpenAI max_tokens capped by task limit", {
            taskType,
            requested,
            applied: maxTokens,
            taskCap
          });
        }
        let serializablePayload = payload;
        try {
          serializablePayload = JSON.parse(JSON.stringify(payload, function (_key, value) {
            if (value === undefined) return null;
            if (typeof value === "function") return null;
            return value;
          }));
          arcPipelineLog("Backend response validated", {
            taskType,
            serializable: true,
            hasUndefined: false
          });
        } catch (e) {
          arcPipelineLog("Backend response validated", {
            taskType,
            serializable: false,
            error: e && e.message ? e.message : "serialization_failed"
          });
          serializablePayload = {
            content: [{ type: "text", text: rawText || "" }]
          };
        }
        setCachedOpenAiResponse(cacheKey, serializablePayload, OPENAI_CACHE_TTL_MS);
        arcPipelineLog("OpenAI response received", { durationMs: Date.now() - started, taskType });
        return serializablePayload;
      } finally {
        clearTimeout(timeout);
      }
    })();

    openAiInFlight.set(cacheKey, run);
    try {
      const payload = await run;
      return debugSendAiJson(res, payload, "live_openai");
    } finally {
      openAiInFlight.delete(cacheKey);
    }
  } catch (err) {
    const failedTask = String((req.body && req.body.taskType) || "optimization").toLowerCase();
    if (err && (err.name === "AbortError" || err.code === "ABORT_ERR" || err.name === "APIUserAbortError")) {
      arcPipelineLog("OpenAI timeout fallback triggered", {
        taskType: failedTask,
        timeoutMs: openAiTaskTimeoutMs(failedTask),
      });
      return debugSendAiJson(res, {
        content: [{ type: "text", text: "fallback: timeout; continue pipeline" }],
        timeoutFallback: true,
      }, "timeout_fallback");
    }
    if (failedTask === "instruction_enhancement") {
      arcPipelineLog("OpenAI enhancement fallback triggered", { reason: err && err.name ? err.name : "request_failed" });
      return debugSendAiJson(res, {
        content: [{ type: "text", text: "fallback: enhancement unavailable; preserve base instructions" }],
        enhancementFallback: true,
      }, "enhancement_fallback");
    }
    if (process.env.ARC_DEBUG_OPENAI === "1") {
      console.error(err);
    } else {
      arcPipelineLog("OpenAI fallback response used", { reason: err && err.name ? err.name : "request_failed" });
    }
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * Macro + Arc sanity checks without Edamam or USDA (Spoonacular-only verify path).
 * @param {{ calories: number, protein: number, carbs: number, fat: number }} macros
 * @returns {{ safe: boolean, validation: object, sanity: object }}
 */
function arcValidateSpoonacularMacros(macros) {
  const p = Number(macros.protein) || 0;
  const c = Number(macros.carbs) || 0;
  const f = Number(macros.fat) || 0;
  const computed = p * 4 + c * 4 + f * 9;
  const delta = Math.abs(computed - macros.calories) / Math.max(macros.calories, 1);
  const usdaMacroOk = delta <= 0.12;
  const validation = {
    calorie_macro_mismatch: !usdaMacroOk,
    usda_sample_ok: true,
    ai_drift_ratio: null,
    safe:
      usdaMacroOk &&
      macros.calories >= 50 &&
      macros.calories <= 2500 &&
      p <= 200 &&
      !(p * 4 > macros.calories * 1.1),
  };
  const sanity = ArcValidation && ArcValidation.runNutritionSanityChecks
    ? ArcValidation.runNutritionSanityChecks(macros)
    : { valid: validation.safe, issues: [] };
  return { safe: validation.safe && sanity.valid, validation, sanity };
}

/** Spoonacular recipe nutrition + Arc validation — Edamam and USDA are not called. */
app.post("/api/nutrition/spoonacular-verify", async (req, res) => {
  try {
    ArcTrace.logOrchestrator("spoonacular nutrition verify started");
    const spoonacularRecipeId = req.body?.spoonacularRecipeId || null;
    if (spoonacularRecipeId == null || spoonacularRecipeId === "") {
      return res.status(400).json({ verified: false, reason: "spoonacular_id_required" });
    }

    arcPipelineLog("Spoonacular verify — skipping Edamam/USDA", {
      spoonacularRecipeId,
      reason: "spoonacular_id_present",
    });

    let macros = await fetchSpoonacularNutrition(spoonacularRecipeId);
    const clientMacros = req.body?.macros;
    if ((!macros || !macros.calories) && clientMacros && Number(clientMacros.calories) > 0) {
      macros = {
        calories: Math.round(Number(clientMacros.calories)),
        protein: Math.round(Number(clientMacros.protein) || 0),
        carbs: Math.round(Number(clientMacros.carbs) || 0),
        fat: Math.round(Number(clientMacros.fat) || 0),
      };
      arcPipelineLog("Spoonacular verify using client macros (bulk fetch unavailable)", {
        spoonacularRecipeId,
      });
    }

    if (!macros || !macros.calories || macros.calories <= 0) {
      return res.json({
        verified: false,
        reason: "spoonacular_nutrition_unavailable",
        macros: null,
        source: "spoonacular",
        skipReason: "spoonacular_fetch_empty",
      });
    }

    const check = arcValidateSpoonacularMacros(macros);
    if (!check.safe) {
      arcPipelineLog("Spoonacular nutrition validation failed", {
        spoonacularRecipeId,
        issues: check.sanity.issues || [],
      });
      return res.json({
        verified: false,
        reason: check.sanity.valid ? "validation_failed" : "sanity_check_failed",
        macros,
        validation: check.validation,
        sanity: check.sanity,
        source: "spoonacular",
        nutritionConfidence: "medium",
        skipReason: "spoonacular_id_present",
      });
    }

    const derivedTags = ArcValidation && ArcValidation.deriveNutritionTags
      ? ArcValidation.deriveNutritionTags({
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        fiber: Number(req.body?.fiber) || 0,
      })
      : { tags: [], rules: {} };
    const tagCheck = ArcValidation && ArcValidation.validateRecipeTags
      ? ArcValidation.validateRecipeTags(req.body?.tags || [], {
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        fiber: Number(req.body?.fiber) || 0,
      })
      : { validTags: [], rejectedTags: [] };

    arcPipelineLog("Nutrition confidence HIGH", { source: "spoonacular", spoonacularRecipeId });
    ArcTrace.logMessage("Spoonacular nutrition verified — Edamam/USDA skipped");
    res.json({
      verified: true,
      macros,
      validation: check.validation,
      sanity: check.sanity,
      source: "spoonacular",
      fallback: false,
      nutritionConfidence: "high",
      nutritionTags: derivedTags.tags,
      validatedTags: tagCheck.validTags,
      rejectedTags: tagCheck.rejectedTags,
      skipReason: "spoonacular_id_present",
      note: "Macros from Spoonacular with Arc validation — Edamam and USDA not called",
    });
  } catch (err) {
    console.error("/api/nutrition/spoonacular-verify", err);
    res.status(500).json({ verified: false, reason: "server_error" });
  }
});

/** Edamam analysis → USDA consistency check → validation flags for client display. */
app.post("/api/nutrition/pipeline", async (req, res) => {
  try {
    ArcTrace.logOrchestrator("nutrition pipeline started");
    const creds = edamamCredentials();
    const title =
      (req.body && typeof req.body.title === "string" && req.body.title.trim()) || "Recipe";
    const rawIngr = Array.isArray(req.body?.ingr) ? req.body.ingr : [];
    const cleanIngr = EdamamHelpers.normalizeIngredientLines(rawIngr);
    const spoonacularRecipeId = req.body?.spoonacularRecipeId || req.body?.recipeId || null;
    edamamDiagnosticLog("ingredient lines sent", {
      title,
      spoonacularRecipeId: spoonacularRecipeId != null ? spoonacularRecipeId : null,
      lineCount: cleanIngr.length,
      lines: cleanIngr.slice(0, 12),
    });
    if (!cleanIngr.length) {
      EdamamHelpers.logEdamamFailure(ArcTrace, "payload", {
        httpStatus: 400,
        endpoint: EdamamHelpers.EDAMAM_NUTRITION_ENDPOINT,
        operation: "pipeline-analysis",
        payloadValid: false,
        payloadReason: "ingr_required",
        ingredientCount: 0,
      });
      return res.status(400).json({ verified: false, reason: "ingr_required" });
    }

    const reported = req.body?.reported || {};

    let macros = null;
    let nutritionSource = "edamam";
    let nutritionConfidence = "high";
    let usedFallback = false;

    if (!creds) {
      ArcTrace.logMessage("Edamam unavailable");
      const fb = await nutritionFallbackAfterEdamam({ ingr: cleanIngr, spoonacularRecipeId });
      if (!fb) {
        return res.status(503).json({ verified: false, reason: "edamam_not_configured" });
      }
      macros = fb.macros;
      nutritionSource = fb.source;
      nutritionConfidence = fb.source === "usda" ? "medium" : "low";
      usedFallback = true;
    } else {
      const result = await callEdamamNutritionDetails(creds, title, cleanIngr, "pipeline-analysis");
      if (result.payloadError) {
        return res.status(400).json({ verified: false, reason: "ingr_invalid", detail: result.payloadError });
      }
      if (!result.ok) {
        const fb = await nutritionFallbackAfterEdamam({ ingr: cleanIngr, spoonacularRecipeId });
        if (fb) {
          macros = fb.macros;
          nutritionSource = fb.source;
          nutritionConfidence = fb.source === "usda" ? "medium" : "low";
          usedFallback = true;
        } else {
          return res.status(result.status >= 400 ? result.status : 502).json({
            verified: false,
            reason: "edamam_failed",
            detail: EdamamHelpers.sanitizeEdamamBody(result.rawText, 200),
            failureKind: result.failureKind,
          });
        }
      } else {
        macros = macrosFromEdamamData(result.data);
      }
    }

    if (!macros || !macros.calories || macros.calories <= 0) {
      const fb = await nutritionFallbackAfterEdamam({ ingr: cleanIngr, spoonacularRecipeId });
      if (fb && fb.macros.calories > 0) {
        macros = fb.macros;
        nutritionSource = fb.source;
        nutritionConfidence = fb.source === "usda" ? "medium" : "low";
        usedFallback = true;
      } else {
        return res.json({ verified: false, reason: "missing_calories", macros: null });
      }
    }

    const p = Number(macros.protein) || 0;
    const c = Number(macros.carbs) || 0;
    const f = Number(macros.fat) || 0;
    const computed = p * 4 + c * 4 + f * 9;
    const delta = Math.abs(computed - macros.calories) / Math.max(macros.calories, 1);
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

    if (!usdaIngredientOk || !usdaMacroOk) {
      arcPipelineLog("Invalid macro ratio detected");
    }

    const sanity = ArcValidation && ArcValidation.runNutritionSanityChecks
      ? ArcValidation.runNutritionSanityChecks(macros)
      : { valid: validation.safe, issues: [] };
    if (!sanity.valid) {
      arcPipelineLog("Invalid macro ratio detected");
      return res.json({
        verified: false,
        reason: "sanity_check_failed",
        macros,
        validation,
        sanity,
        source: nutritionSource,
        fallback: usedFallback,
        nutritionConfidence: determineNutritionConfidence(nutritionSource, false),
      });
    }

    if (!validation.safe) {
      ArcTrace.logMessage("USDA validation failed");
      if (usedFallback) {
        return res.json({
          verified: false,
          reason: "validation_failed",
          macros,
          validation,
          source: nutritionSource,
          fallback: true,
          nutritionConfidence: "low",
        });
      }
      return res.json({
        verified: false,
        reason: "validation_failed",
        macros,
        validation,
        source: "edamam",
      });
    }

    const usdaValidated = usdaMacroOk && usdaIngredientOk;
    const resolvedSource = usedFallback
      ? nutritionSource
      : (usdaValidated ? "edamam+usda" : nutritionSource);
    nutritionConfidence = determineNutritionConfidence(resolvedSource, usdaValidated);
    arcPipelineLog(`Nutrition confidence ${nutritionConfidence.toUpperCase()}`);
    if (usdaValidated) {
      arcPipelineLog("USDA reconciliation success");
    }

    const derivedTags = ArcValidation && ArcValidation.deriveNutritionTags
      ? ArcValidation.deriveNutritionTags({
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        fiber: Number(req.body?.fiber) || 0,
      })
      : { tags: [], rules: {} };
    const tagCheck = ArcValidation && ArcValidation.validateRecipeTags
      ? ArcValidation.validateRecipeTags(req.body?.tags || [], {
        calories: macros.calories,
        protein: macros.protein,
        carbs: macros.carbs,
        fat: macros.fat,
        fiber: Number(req.body?.fiber) || 0,
      })
      : { validTags: [], rejectedTags: [] };

    ArcTrace.logMessage("Final meal generation complete");
    res.json({
      verified: true,
      macros,
      validation,
      sanity,
      source: resolvedSource,
      fallback: usedFallback,
      nutritionConfidence,
      nutritionTags: derivedTags.tags,
      validatedTags: tagCheck.validTags,
      rejectedTags: tagCheck.rejectedTags,
      note: usedFallback
        ? "Macros from fallback provider after Edamam failure — lower confidence"
        : "Displayed macros from Edamam analysis with USDA consistency checks",
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
