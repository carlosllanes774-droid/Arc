/**
 * Arc V2.1 architecture contract — forbidden legacy symbols must not exist in index.html.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const SRC = readFileSync(INDEX_HTML, 'utf8');

const FORBIDDEN = [
  'function sendLog',
  'function finalizeFoodLogReply',
  'function openAdaptModal',
  'function runWeeklyReviewAndPersist',
  'function upsertWeeklyRecapHistory',
  'function buildWeeklyRecapPayload',
  'function computeConsistencyScoreRecap',
  'function detectWeeklyRecapMoments',
  'id="adapt-bg"',
  'id="planner-adapt-card"',
  'id="adapt-btn"',
  'ARC_COPY.adapt',
  'ARC_COPY.moments'
];

const REQUIRED = [
  'function processFoodReport',
  'function buildCoachResponse',
  'function buildWeeklyReflection',
  'function recalculateRecoveryTier',
  'function syncDisplayModeDom',
  'reflectionHistory',
  'function migrateLegacyReflectionData'
];

describe('Arc V2.1 index.html contract', () => {
  for (const sym of FORBIDDEN) {
    test(`does not contain legacy symbol: ${sym}`, () => {
      assert.equal(SRC.includes(sym), false, `found forbidden ${sym}`);
    });
  }

  for (const sym of REQUIRED) {
    test(`contains required spine symbol: ${sym}`, () => {
      assert.equal(SRC.includes(sym), true, `missing required ${sym}`);
    });
  }

  test('migrateLegacyReflectionData purges legacy review/recap archives', () => {
    assert.ok(SRC.includes('delete p.lastWeeklyReview'));
    assert.ok(SRC.includes('delete p.weeklyReviewHistory'));
    assert.ok(SRC.includes('delete p.arcWeeklyRecap.weeklyRecaps'));
  });

  test('defaultArcWeeklyRecap no longer maintains weeklyRecaps array', () => {
    const fnBlock = SRC.slice(
      SRC.indexOf('function defaultArcWeeklyRecap'),
      SRC.indexOf('function ensureArcWeeklyRecap')
    );
    assert.equal(fnBlock.includes('weeklyRecaps'), false);
  });
});
