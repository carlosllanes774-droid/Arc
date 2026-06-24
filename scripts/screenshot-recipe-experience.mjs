import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/canonical-week-frontend-contract.json'), 'utf8')
);

fixture.recipes[0].ing = ['Ground Beef', 'Rice', 'Broccoli'];
fixture.recipes[0].ingQty = {
  'Ground Beef': '8 oz',
  Rice: '1/2 cup',
  Broccoli: '1 cup'
};

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

async function scrollToIngredients(page) {
  await page.evaluate(() => {
    const hdr = document.getElementById('rx-ing-h');
    const sc = document.getElementById('rx-scroll');
    if (sc && hdr) sc.scrollTop = Math.max(0, hdr.offsetTop - 12);
  });
  await page.waitForTimeout(350);
}

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
  await page.waitForTimeout(2500);

  await page.evaluate(() => {
    if (typeof openRM === 'function') openRM(1);
  });
  await page.waitForTimeout(600);
  await scrollToIngredients(page);

  await page.screenshot({
    path: path.join(outDir, 'recipe-experience-ingredient-default.png'),
    fullPage: false
  });

  await page.evaluate(() => {
    const r = recipes.find((x) => x.id === 1);
    if (!r) return;
    const original = 'Ground Beef';
    const substitute = 'Ground Turkey';
    const idx = r.ing.indexOf(original);
    if (idx === -1) return;
    if (!recipeIngredientSwaps[1]) recipeIngredientSwaps[1] = {};
    recipeIngredientSwaps[1][original] = {
      originalName: original,
      originalQty: r.ingQty[original],
      substituteName: substitute,
      substituteQty: '8 oz'
    };
    r.ing[idx] = substitute;
    delete r.ingQty[original];
    r.ingQty[substitute] = '8 oz';
    if (typeof refreshScaledIngredientsUI === 'function') refreshScaledIngredientsUI();
  });
  await page.waitForTimeout(400);

  await page.screenshot({
    path: path.join(outDir, 'recipe-experience-ingredient-swapped.png'),
    fullPage: false
  });

  await page.evaluate(() => {
    if (typeof showNoSubstitutionsModal === 'function') showNoSubstitutionsModal();
    if (typeof openMotion === 'function') openMotion('swap-bg');
  });
  await page.waitForTimeout(500);

  await page.screenshot({
    path: path.join(outDir, 'recipe-experience-no-substitutions.png'),
    fullPage: false
  });

  await browser.close();
  console.log('Screenshots saved to docs/screenshots/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
