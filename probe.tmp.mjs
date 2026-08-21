import { chromium } from 'playwright';
const W = 1100, H = 900;
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: W, height: H }, reducedMotion: 'no-preference' });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { const t = m.text(); if (t.includes('[perf]')) console.log(t); else if (m.type() === 'error') errors.push('console: ' + t); });
await page.goto('http://localhost:5199/');
await page.evaluate(() => localStorage.setItem('ooo_progress_v2', JSON.stringify({ unlocked: [], selectionCounts: {}, gamesCompleted: 3 })));
await page.reload({ waitUntil: 'networkidle' });

const settle = (k) => page.waitForFunction((k) => {
  const s = window.__game.scene.getScenes(true).find((s) => s.scene.key === k);
  return !!s && !s.tweens.getTweens().some((t) => t.data && t.data.some((d) => d.key === 'x'));
}, k, { timeout: 90000, polling: 100 });
const btn = (k, r) => page.evaluate(([k, r]) => {
  const s = window.__game.scene.getScenes(true).find((s) => s.scene.key === k);
  const rx = new RegExp(r);
  const walk = (l, ox, oy) => { for (const o of l) { if (o.list && o.list.some((c) => c.text && rx.test(c.text))) return { x: ox + o.x, y: oy + o.y }; if (o.list) { const h = walk(o.list, ox + o.x, oy + o.y); if (h) return h; } } };
  return walk(s.children.list, 0, 0);
}, [k, r]);
const trace = (ms) => page.evaluate((ms) => new Promise((res) => {
  const fr = []; let last = performance.now(); const t0 = last;
  const tick = () => { const n = performance.now(); fr.push(Math.round(n - last)); last = n; if (n - t0 < ms) requestAnimationFrame(tick); else res(fr); };
  requestAnimationFrame(tick);
}), ms);

const stats = (fr) => { const s = [...fr].sort((a, b) => b - a); return `worst ${s.slice(0, 5).join(', ')} | over-16ms: ${fr.filter((f) => f > 16).length}/${fr.length}`; };

await settle('Menu');
const t = trace(3000);
const b = await btn('Menu', 'Codex');
await page.mouse.click(b.x, b.y);
console.log('menu -> codex frames:', stats(await t));

await settle('Items');
console.log('cards built right after entrance:', await page.evaluate(() => {
  const s = window.__game.scene.getScenes(true).find((s) => s.scene.key === 'Items');
  return s.gallery ? `${s.gallery.built.size}/${s.gallery.items.length}` : 'n/a';
}));
await page.waitForTimeout(1500);
console.log('cards after top-up:', await page.evaluate(() => {
  const s = window.__game.scene.getScenes(true).find((s) => s.scene.key === 'Items');
  return s.gallery ? `${s.gallery.built.size}/${s.gallery.items.length}` : 'n/a';
}));

// Scroll the gallery and watch for hitches.
const t2 = trace(2000);
await page.mouse.move(W / 2, H / 2);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
console.log('scroll frames:', stats(await t2));

// Second visit: the top-up must be re-armed, not left on through the entrance.
const back = await btn('Items', 'Vestibule');
await page.mouse.click(back.x, back.y);
await settle('Menu');
const t3 = trace(3000);
const b2 = await btn('Menu', 'Codex');
await page.mouse.click(b2.x, b2.y);
console.log('second visit frames:', stats(await t3));
await settle('Items');
console.log('objects drawn twice check — main-camera-visible cards:', await page.evaluate(() => {
  const s = window.__game.scene.getScenes(true).find((s) => s.scene.key === 'Items');
  const main = s.cameras.main;
  return s.gallery.track.list.filter((c) => !(c.cameraFilter & main.id)).length;
}));
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no page errors');
