import { chromium } from "playwright";

const URL = process.argv[2] ?? "http://localhost:5174/";
const OUT = process.argv[3] ?? ".";

const sizes = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "portrait", width: 420, height: 860 },
  { name: "small", width: 900, height: 560 },
];

const browser = await chromium.launch();
for (const s of sizes) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height } });
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${s.name}] console error: ${m.text()}`);
  });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.scene?.getScene("Shop"), null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const info = await page.evaluate(async () => {
    const rs = await import("/src/state/RunState.ts");
    const tut = await import("/src/systems/Tutorial.ts");
    const eng = await import("/src/sim/engine.ts");
    const game = window.__game;
    for (const sc of game.scene.getScenes(true)) sc.scene.stop();
    const state = rs.newRun([]);
    eng.beginRun(state);
    state.gold = 25;
    rs.setRun(game.registry, state);
    tut.setTutorial(game.registry, { active: true, stage: tut.TutorialStage.Shop });
    game.scene.start("Shop");
    return { stage: tut.TutorialStage.Shop };
  });

  await page.waitForTimeout(2500);
  // Strip the dev panel's DOM overlay so it cannot hide the canvas.
  await page.evaluate(() => {
    for (const el of [...document.body.children]) if (el.tagName !== "CANVAS") el.remove();
  });

  // Report the geometry the callout actually used: lit bands vs. panel rect.
  const geom = await page.evaluate(() => {
    const shop = window.__game.scene.getScene("Shop");
    const rect = (r) => (r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null);
    const objs = shop.tutorialCallout?.objects ?? [];
    // The gold-stroked rectangles are the highlights; the parchment panel is a
    // container at PANEL_DEPTH (102).
    const hilites = objs
      .filter((o) => o.type === "Rectangle" && o.strokeColor !== undefined && o.isStroked)
      .map((o) => ({ x: Math.round(o.x - o.width / 2), y: Math.round(o.y - o.height / 2), w: Math.round(o.width), h: Math.round(o.height) }));
    const panel = objs.find((o) => o.depth === 102);
    const b = panel?.getBounds?.();
    const panelRect = b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null;
    const body = objs.find((o) => o.depth === 103);
    const button = objs.find((o) => o.depth === 104);
    return {
      cardBand: rect(shop.cardBand),
      packBand: rect(shop.packBand),
      hilites,
      panelRect,
      hasBody: !!body,
      hasContinue: !!button,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  });

  const overlaps = (a, b) =>
    a && b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  console.log(
    JSON.stringify(
      {
        size: s.name,
        ...geom,
        panelOverlapsCards: overlaps(geom.panelRect, geom.cardBand),
        panelOverlapsPacks: overlaps(geom.panelRect, geom.packBand),
      },
      null,
      2,
    ),
  );

  await page.screenshot({ path: `${OUT}/shop-${s.name}.png` });
  await page.close();
}
await browser.close();
