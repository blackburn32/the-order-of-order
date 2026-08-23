import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
async function probe(name, W, H, trial, bossIdx) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://localhost:5199/');
  await page.evaluate(() => document.querySelectorAll('body > *:not(#game)').forEach(e => e.remove()));
  await page.waitForFunction(() => window.__game?.scene.getScenes(true).some(s => s.scene.key === 'Menu'), { timeout: 30000 });
  const out = await page.evaluate(async ([trial, bossIdx]) => {
    const rs = await import('/src/state/RunState.ts');
    const tut = await import('/src/systems/Tutorial.ts');
    const boss = await import('/src/systems/Boss.ts');
    const g = window.__game;
    const state = rs.newRun([]);
    state.trial = trial; state.bossModifier = boss.BOSS_MODIFIERS[bossIdx].id;
    rs.setRun(g.registry, state);
    tut.getTutorial(g.registry).active = false;
    g.scene.getScenes(true)[0].scene.start('TrialOverview');
    await new Promise(r => setTimeout(r, 900));
    const s = g.scene.getScenes(true).find(x => x.scene.key === 'TrialOverview');
    // Every Text on a card must sit inside that card's rect.
    const bad = [];
    for (const o of s.children.list) {
      if (o.type !== 'Text' || !o.text) continue;
      const b = o.getBounds();
      const card = s.cardRects.find(r => b.centerX >= r.x && b.centerX <= r.x + r.width && b.centerY >= r.y && b.centerY <= r.y + r.height);
      if (!card) continue;
      const over = Math.max(card.y - b.y, b.bottom - (card.y + card.height), card.x - b.x, b.right - (card.x + card.width));
      if (over > 1.5) bad.push(`${JSON.stringify(o.text.slice(0, 22))} out by ${over.toFixed(1)}`);
    }
    return { bad, cards: s.cardRects.map(r => `${Math.round(r.width)}x${Math.round(r.height)}`) };
  }, [trial, bossIdx]);
  console.log(`${name} ${W}x${H} t${trial}`, out.cards.join(' '), out.bad.length ? 'OVERFLOW: ' + out.bad.join('; ') : 'ok', errs.length ? 'ERR ' + errs.join('|') : '');
  await page.close();
}
const sizes = [['narrow',360,640],['se',375,667],['portrait',430,932],['pixel',412,915],['tiny-land',568,320],['land',844,390],['desktop',1440,900],['wide',1920,1080],['square',800,800]];
for (const [n,w,h] of sizes) for (const bossIdx of [7, 5]) await probe(n, w, h, 3, bossIdx);
await probe('endless', 430, 932, 21, 7);
await probe('endless-d', 1440, 900, 21, 7);
await browser.close();
