import { chromium } from 'playwright';
const OUT = process.argv[2];
const browser = await chromium.launch({ headless: true });

async function shoot(name, W, H, trial, bossCleared = 0, bossIdx = 3) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  page.on('pageerror', e => console.log('ERR', name, e.message));
  await page.goto('http://localhost:5199/');
  await page.evaluate(() => document.querySelectorAll('body > *:not(#game)').forEach(e => e.remove()));
  await page.waitForFunction(() => window.__game?.scene.getScenes(true).some(s => s.scene.key === 'Menu'), { timeout: 30000 });
  await page.evaluate(async ([trial, bossCleared, bossIdx]) => {
    const rs = await import('/src/state/RunState.ts');
    const tut = await import('/src/systems/Tutorial.ts');
    const boss = await import('/src/systems/Boss.ts');
    const g = window.__game;
    const state = rs.newRun([]);
    rs.initializeRun?.(state);
    state.trial = trial;
    state.bossesCleared = bossCleared;
    state.bossModifier = boss.BOSS_MODIFIERS[bossIdx].id;
    rs.setRun(g.registry, state);
    tut.getTutorial(g.registry).active = false;
    const menu = g.scene.getScenes(true)[0];
    menu.scene.start('TrialOverview');
  }, [trial, bossCleared, bossIdx]);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.close();
  console.log('shot', name);
}

await shoot('desktop-t2', 1440, 900, 2);
await shoot('portrait-t2', 430, 932, 2);
await shoot('landscape-t2', 844, 390, 2);
await shoot('desktop-t9', 1440, 900, 9, 2);
await shoot('tiny-landscape', 568, 320, 3, 0, 7);
await shoot('narrow-portrait', 360, 640, 3, 0, 7);
await shoot('endless', 1440, 900, 21, 6, 5);
await shoot('endless-portrait', 430, 932, 21, 6, 5);
await browser.close();
