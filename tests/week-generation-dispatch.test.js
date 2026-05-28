/**
 * callAI week-generation vs enhancement classification (mirrors Index1.html callAI).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOOSE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'canonical-week-loose.json'), 'utf8')
);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function hasCanonicalSchemaShape(v) {
  if (!isPlainObject(v)) return false;
  if (v.schema && isPlainObject(v.schema) && String(v.schema.owner || '').toLowerCase() === 'arc_backend') {
    return true;
  }
  if (isPlainObject(v.canonicalMeal) || Array.isArray(v.meals)) return true;
  if (Array.isArray(v.recipes) || isPlainObject(v.plan) || isPlainObject(v.meal_plan)) return true;
  if (isPlainObject(v.week) || isPlainObject(v.data)) return true;
  return false;
}

function hasWeekGenerationSchemaShape(v) {
  if (!isPlainObject(v)) return false;
  return Array.isArray(v.recipes) && isPlainObject(v.plan);
}

function extractAiResponseText(data) {
  if (!data || data.content == null) return '';
  const c = data.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || !c.length) return '';
  return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('');
}

/** Mirrors production callAI dispatch after /api/ai response */
function simulateCallAiDispatch(backendBody) {
  if (hasCanonicalSchemaShape(backendBody)) {
    return { source: 'canonical_backend', raw: backendBody };
  }
  const text = extractAiResponseText(backendBody).trim();
  if (text && backendBody && backendBody.content != null) {
    let nestedParsed = null;
    try {
      nestedParsed = JSON.parse(text);
    } catch (_) {
      nestedParsed = null;
    }
    if (nestedParsed && hasWeekGenerationSchemaShape(nestedParsed)) {
      return { source: 'week_generation', raw: nestedParsed };
    }
  }
  if (text) return { source: 'enhancement', raw: text };
  return { source: 'unknown', raw: null };
}

function simulateApplyWeekSourceGuard(meta) {
  const payloadSource = meta && meta.source ? String(meta.source) : 'unknown';
  if (payloadSource === 'enhancement') {
    return { blocked: true, reason: 'enhancement_payload_rejected' };
  }
  return { blocked: false, payloadSource };
}

describe('Week-generation response classification', () => {
  test('nested week JSON in content[].text classifies as week_generation', () => {
    const weekJson = { recipes: LOOSE.recipes, plan: LOOSE.plan || {} };
    const envelope = { content: [{ type: 'text', text: JSON.stringify(weekJson) }] };
    const dispatch = simulateCallAiDispatch(envelope);
    assert.equal(dispatch.source, 'week_generation');
    assert.ok(Array.isArray(dispatch.raw.recipes));
    assert.ok(isPlainObject(dispatch.raw.plan));
    const guard = simulateApplyWeekSourceGuard({ source: dispatch.source });
    assert.equal(guard.blocked, false);
  });

  test('top-level canonical_backend shape is unchanged', () => {
    const body = {
      schema: { owner: 'arc_backend', version: '1.0.0' },
      recipes: LOOSE.recipes,
      plan: { Mon: { Lunch: 1 } }
    };
    const dispatch = simulateCallAiDispatch(body);
    assert.equal(dispatch.source, 'canonical_backend');
  });

  test('enhancement text without week schema stays enhancement', () => {
    const envelope = {
      content: [{ type: 'text', text: '**Prep:** Dice onions and sauté until soft.' }]
    };
    const dispatch = simulateCallAiDispatch(envelope);
    assert.equal(dispatch.source, 'enhancement');
    const guard = simulateApplyWeekSourceGuard({ source: dispatch.source });
    assert.equal(guard.blocked, true);
  });

  test('nested JSON with recipes only (no plan) stays enhancement', () => {
    const envelope = {
      content: [{ type: 'text', text: JSON.stringify({ recipes: [{ name: 'Soup' }] }) }]
    };
    const dispatch = simulateCallAiDispatch(envelope);
    assert.equal(dispatch.source, 'enhancement');
  });
});
