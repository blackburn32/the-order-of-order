import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
async function probe(name, W, H) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.goto('http://localhost:5199/');
  await page.evaluate(() => document.querySelectorAll('body > *:not(#game)').forEach(e => e.remove()));
  await page.waitForFunction(() => window.__game?.scene.getScenes(true).some(s => s.scene.key === 'Menu'), { timeout: 30000 });
  const out = await page.evaluate(async () => {
    const rs = await import('/src/state/RunState.ts');
    const tut = await import('/src/systems/Tutorial.ts');
    const boss = await import('/src/systems/Boss.ts');
    const g = window.__game;
    const state = rs.newRun([]);
    state.trial = 3; state.bossModifier = boss.BOSS_MODIFIERS[7].id;
    rs.setRun(g.registry, state);
    tut.getTutorial(g.registry).active = false;
    g.scene.getScenes(true)[0].scene.start('TrialOverview');
    await new Promise(r => setTimeout(r, 800));
    const s = g.scene.getScenes(true).find(s => s.scene.key === 'TrialOverview');
    // Report card rect sizes and which text rows survived per card.
    const rects = s.cardRects.map(r => `${Math.round(r.width)}x${Math.round(r.height)}`);
    const texts = s.children.list.filter(o => o.type === 'Text').map(o => o.text);
    return { rects, captions: texts.filter(t => /points to clear|points needed/.test(t)).length, rules: texts.length };
  });
  console.log(name, W + 'x' + H, JSON.stringify(out.rects), 'caption-rows:', out.captions);
  await page.close();
}
for (const [n, w, h] of [['narrow-portrait',360,640],['portrait',430,932],['se',375,667],['pixel',412,915],['tiny-land',568,320],['desktop',1440,900]]) await probe(n, w, h);
await browser.close();
