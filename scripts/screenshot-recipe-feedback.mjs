import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/canonical-week-frontend-contract.json'), 'utf8')
);

const profile = {
  goal: 'Lose weight',
  activity: 'Moderate',
  budget: 'Moderate',
  displayMode: 'simple',
  weeklyPlan: { builtAt: new Date().toISOString(), weekVibe: 'steady' },
  arcSavedRecipes: { starredRecipeIds: [] },
  mealFeedback: {}
};

const session = {
  recipes: fixture.recipes.map((r) => ({ ...r, image: null })),
  mealPlan: fixture.plan,
  servingOverrides: {}
};

const outDir = path.join(ROOT, 'docs/screenshots');

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ profile, session }) => {
      localStorage.setItem('userProfile', JSON.stringify(profile));
      localStorage.setItem('nutriai_session', JSON.stringify(session));
    },
    { profile, session }
  );

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    if (typeof openRM === 'function') openRM(1);
  });
  await page.waitForTimeout(500);

  await page.screenshot({
    path: path.join(outDir, 'recipe-feedback-neutral.png'),
    fullPage: false
  });

  await page.click('#rx-like');
  await page.waitForTimeout(350);

  await page.screenshot({
    path: path.join(outDir, 'recipe-feedback-liked.png'),
    fullPage: false
  });

  await page.click('#rx-dislike');
  await page.waitForTimeout(350);

  await page.screenshot({
    path: path.join(outDir, 'recipe-feedback-disliked.png'),
    fullPage: false
  });

  await browser.close();
  console.log('Feedback screenshots saved to docs/screenshots/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
