// End-to-end check of the audit replayer against the real game.
//
//   npm run replay:e2e                 three runs
//   npm run replay:e2e -- --runs=5 --seed=7
//   npm run replay:e2e -- --headed     watch it play
//   npm run replay:e2e -- --chromium=/path/to/chrome
//
// Starts the dev server and plays whole runs in a real browser by calling the
// same scene methods the player's taps call — rolling (mid-tumble presses
// included), spending a reroll or a blessing from the score panel, dragging
// dice, buying cards and pointing them at dice, opening and
// skipping packs, rerolling the shelf, taking the Tribute, pressing on into
// endless — at a browser size picked per run, so the radius dice's reach
// changes with the layout. The shopping is decided here, in node, by the same
// appraiser the expert bot uses (sim/appraise), so runs get deep enough to meet
// the story, the Tribute and radius dice; the cards are bought in the page.
//
// It keeps the active-run save after every shop visit, and at the end the Hall
// entry, and replays each one with `npm run audit`, which has to reach exactly
// the score the game did. If the scenes and the replayer ever disagree about
// the rules, this is where it shows.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { hydrateRunState } from "../systems/ActiveRunPersistence";
import type { ShopCheckpointState } from "../systems/ActiveRunPersistence";
import { ITEMS } from "../systems/Items";
import { mulberry32 } from "../systems/Rng";
import { ShopVisit } from "../systems/ShopVisit";
import {
  appraiseOffer,
  efficiency,
  goldExchangeRate,
  measureCapacity,
  resolveGroupIndex,
  type Appraisal,
} from "./appraise";
import { installStorage } from "./localStorageShim";

installStorage([]);

function arg(name: string, fallback: string): string;
function arg(name: string): string | undefined;
function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const RUNS = Number(arg("runs", "3"));
const SEED = Number(arg("seed", String(Date.now() % 100000)));
const PORT = Number(arg("port", "5191"));
const HEADED = process.argv.includes("--headed");
const OUT = path.resolve(process.cwd(), "sim-out/replay-e2e");
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
  { width: 1024, height: 1366 },
];
const ACTIVE_RUN = "the-order-of-order.active-run";

function startServer(): Promise<ChildProcess> {
  const server = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("vite did not start")),
      60000,
    );
    server.stdout!.on("data", (chunk) => {
      if (String(chunk).includes("Local:")) {
        clearTimeout(timer);
        resolve(server);
      }
    });
    server.on("exit", (code) => reject(new Error(`vite exited ${code}`)));
  });
}

// The page-side code is plain JavaScript in strings: a function handed to
// page.evaluate is serialized as source, and the TypeScript loader's helpers
// would not exist on the other side.

/** One step of the player at the table and between trials. Returns what it
 *  did; "shop" hands the decision back to node; "over" ends the run. */
const STEP = `(seed) => {
  const g = window.__game;
  if (!g) return "booting";
  let s = (window.__pick ??= seed >>> 0);
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    window.__pick = s;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const active = g.scene.getScenes(true).map((sc) => sc.scene.key);
  const top = ["GameOver", "Victory", "Shop", "Tribute", "Ending",
    "TrialResults", "Game", "TrialOverview", "Character", "Menu"]
    .find((k) => active.includes(k));
  const sc = top && g.scene.getScene(top);
  window.__snapshots ??= [];
  switch (top) {
    case undefined: return "booting";
    case "Menu": if (!sc.leaving) sc.scene.start("Character"); return "menu";
    case "Character": if (!sc.leaving) sc.choose("diebert"); return "character";
    case "TrialOverview": if (!sc.leaving) sc.startTrial(); return "overview";
    case "Game": {
      if (sc.showdown) { sc.showdown.opts.onContinue(); return "showdown"; }
      if (sc.canLiftDice() && rand() < 0.25) {
        const n = sc.state.dice.length;
        const from = Math.floor(rand() * n);
        const to = Math.floor(rand() * n);
        if (sc.sprites.get(from) &&
            sc.liftDie(from, { x: 0, y: 0, id: 1, wasTouch: false })) {
          sc.heldDie.to = to;
          sc.dropHeldDie();
          return "move";
        }
      }
      // The score panel holding a roll open: strike it, bless it, or (by
      // rolling on, below) keep it.
      if (sc.favourPending && rand() < 0.5) {
        if (sc.preRollSnapshot && (rand() < 0.5 || sc.heldPoints === 0n)) {
          sc.rerollLastRoll();
          return "absolve";
        }
        if (sc.heldPoints > 0n && sc.state.benediction > sc.state.blessingsUsed) {
          sc.blessLastRoll();
          return "bless";
        }
      }
      sc.onRoll();
      return "roll";
    }
    case "TrialResults": sc.revealAll(); sc.continue(); return "results";
    case "Ending": sc.finish(); return "ending";
    case "Tribute": if (!sc.leaving) sc.choose(pick(sc.dataIn.choices)); return "tribute";
    case "Victory":
      if (sc.leaving || sc.runEnded) return "over";
      if (!window.__endless) { window.__endless = true; sc.continueRun(); return "endless"; }
      sc.endRun();
      return "over";
    case "GameOver": return "over";
    case "Shop": {
      if (sc.shelfAnimating || sc.visit === window.__leftVisit) return "shop-wait";
      if (sc.pickerOffer) {
        const offer = sc.pickerOffer;
        const want = window.__target;
        const eligible = [];
        for (let i = 0; i < sc.state.dice.length; i++)
          if (sc.eligibleFor(offer, sc.state.dice.dieAt(i))) eligible.push(i);
        if (eligible.length === 0) { sc.visit.cancelPick(); sc.rebuildShop(); return "shop-wait"; }
        const index = eligible.includes(want) && !sc.pickedIndices.includes(want)
          ? want : pick(eligible);
        sc.onPick(offer, index);
        return "pick";
      }
      return "shop";
    }
  }
  return top;
}`;

/** Carry out the shopper's decision in the page. */
const ACT = `(a) => {
  const sc = window.__game.scene.getScene("Shop");
  window.__target = a.target;
  switch (a.kind) {
    case "buy": {
      const row = a.from === "pack" ? sc.packChoices : sc.offers;
      sc.choose(row[a.index]);
      return;
    }
    case "pack": sc.openPack(sc.packs[a.index], undefined); return;
    case "skip": sc.declinePack(); return;
    case "reroll": sc.rerollStore(); return;
    case "leave":
      window.__leftVisit = sc.visit;
      sc.exit();
      window.__snapshots.push(localStorage.getItem("${ACTIVE_RUN}"));
      return;
  }
}`;

type Action =
  | { kind: "buy"; from: "shelf" | "pack"; index: number; target?: number }
  | { kind: "pack"; index: number }
  | { kind: "skip" }
  | { kind: "reroll" }
  | { kind: "leave" };

/** The shopper: weigh every card the visit can take with the expert's
 *  appraiser and take the best one per gold, while one is worth anything. */
const FAVOURS: ReadonlySet<string> = new Set([
  "absolution",
  "benediction",
  "doxology",
]);

function decide(raw: string, rng: () => number): Action {
  const envelope = JSON.parse(raw) as {
    run: unknown;
    checkpoint: { scene: string } & ShopCheckpointState;
  };
  const state = hydrateRunState(envelope.run);
  if (!state || envelope.checkpoint.scene !== "Shop") return { kind: "leave" };
  const visit = new ShopVisit(state, envelope.checkpoint);
  const fromPack = !!visit.packChoices;
  const row = visit.packChoices ?? visit.offers;
  const opts = {
    samples: 3,
    seed: Math.floor(rng() * 1e9),
    objective: "ladder" as const,
    horizon: 12,
  };
  // A roll favour is taken whenever one is on offer, so the runs reach the
  // score panel's reroll and blessing, which the replayer has to follow too.
  const favour = row.findIndex(
    (offer) => FAVOURS.has(offer.id) && visit.canBuy(offer),
  );
  if (favour >= 0)
    return { kind: "buy", from: fromPack ? "pack" : "shelf", index: favour };
  const baseline = measureCapacity(state, opts);
  const appraisals: { a: Appraisal; index: number }[] = [];
  row.forEach((offer, index) => {
    if (!visit.canBuy(offer)) return;
    const a = appraiseOffer(state, offer, baseline, opts);
    if (a) appraisals.push({ a, index });
  });
  const rate = goldExchangeRate(appraisals.map((x) => x.a));
  appraisals.sort((x, y) => efficiency(y.a, rate) - efficiency(x.a, rate));
  const best = appraisals[0];
  if (best && efficiency(best.a, rate) > 0) {
    const target =
      best.a.targetKey === null
        ? undefined
        : (resolveGroupIndex(state.dice, best.a.targetKey) ?? undefined);
    return {
      kind: "buy",
      from: fromPack ? "pack" : "shelf",
      index: best.index,
      target,
    };
  }
  if (fromPack) return { kind: "skip" };
  const pack = visit.packs.findIndex(
    (p) => !p.sold && !visit.closed && state.gold >= p.cost,
  );
  if (pack >= 0 && rng() < 0.6) return { kind: "pack", index: pack };
  if (visit.rerollsThisVisit < 2 && state.gold >= visit.rerollPrice().price + 4)
    return { kind: "reroll" };
  return { kind: "leave" };
}

/** Doctored copies of a real Hall entry, each of which the audit has to
 *  refuse: a run is only worth auditing if a lie does not replay. */
function tampered(
  entry: Record<string, unknown>,
): [string, Record<string, unknown>][] {
  const log = entry.inputLog as unknown[][];
  const out: [string, Record<string, unknown>][] = [
    [
      "a score one point higher",
      { ...entry, score: String(BigInt(entry.score as string) + 1n) },
    ],
    [
      "a different seed",
      { ...entry, seed: ((entry.seed as number) + 1) >>> 0 },
    ],
    [
      "a dev-panel action",
      {
        ...entry,
        inputLog: [...log.slice(0, 2), [1, "dev", "setGold"], ...log.slice(2)],
      },
    ],
  ];
  const buy = log.findIndex((e) => e[1] === "buy");
  if (buy >= 0)
    out.push([
      "a purchase taken out",
      { ...entry, inputLog: log.filter((_, i) => i !== buy) },
    ]);
  const roll = log.findIndex((e) => e[1] === "roll" && e[4] === 0);
  if (roll >= 0)
    out.push([
      "a roll marked as tutorial-rigged",
      {
        ...entry,
        inputLog: log.map((e, i) =>
          i === roll ? [...e.slice(0, 4), 1, 0] : e,
        ),
      },
    ]);
  return out;
}

function audit(file: string): { ok: boolean; out: string } {
  const res = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/sim/audit.ts", file],
    { encoding: "utf8" },
  );
  return { ok: res.status === 0, out: res.stdout + res.stderr };
}

async function playRun(browser: Browser, base: string, run: number) {
  const size = SIZES[(SEED + run) % SIZES.length];
  const page: Page = await browser.newPage({ viewport: size });
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  // A fresh profile with the whole shop unlocked — a legitimate snapshot, and
  // one whose runs get deep enough to be worth replaying.
  await page.addInitScript(
    ([ids]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.clear();
      localStorage.setItem(
        "ooo_settings_v2",
        JSON.stringify({
          showTutorial: false,
          showIntro: false,
          sfxVol: 0,
          musicVol: 0,
        }),
      );
      localStorage.setItem(
        "ooo_progress_v1",
        JSON.stringify({
          unlocked: ids,
          selectionCounts: {},
          gamesCompleted: 0,
        }),
      );
    },
    [ITEMS.map((item) => item.id)],
  );
  await page.goto(base);
  const rng = mulberry32(SEED * 7919 + run);
  let steps = 0;
  let last = "";
  for (; steps < 6000; steps++) {
    last = (await page.evaluate(`(${STEP})(${SEED * 1000 + run})`)) as string;
    if (last === "over") break;
    if (last === "shop") {
      const raw = (await page.evaluate(
        `localStorage.getItem("${ACTIVE_RUN}")`,
      )) as string;
      const action = decide(raw, rng);
      await page.evaluate(`(${ACT})(${JSON.stringify(action)})`);
      last = `shop ${action.kind}`;
    }
    const wait =
      last.startsWith("shop") ||
      last === "pick" ||
      last === "results" ||
      last === "ending"
        ? 450
        : last === "roll"
          ? 60 + Math.floor(rng() * 500)
          : 150;
    await page.waitForTimeout(wait);
  }
  await page.waitForTimeout(1500);
  const record = (await page.evaluate(`({
    hall: JSON.parse(localStorage.getItem("ooo_high_scores_v2") ?? "[]"),
    snapshots: window.__snapshots ?? [],
  })`)) as { hall: Record<string, unknown>[]; snapshots: (string | null)[] };
  await page.close();
  return { size, steps, last, errors, record };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await startServer();
  let browser: Browser | undefined;
  let failures = 0;
  try {
    const executablePath = arg("chromium");
    browser = await chromium.launch({
      headless: !HEADED,
      ...(executablePath ? { executablePath } : {}),
    });
    for (let run = 0; run < RUNS; run++) {
      const { size, steps, last, errors, record } = await playRun(
        browser,
        `http://localhost:${PORT}/`,
        run,
      );
      const entry = record.hall[0];
      console.log(
        `\nRun ${run + 1}: ${size.width}x${size.height}, ${steps} steps, ended on "${last}"` +
          (entry ? `, rank ${entry.rank} trial ${entry.trial}` : ""),
      );
      if (errors.length) {
        failures++;
        console.log(`  FAIL   page errors:\n    ${errors.join("\n    ")}`);
      }
      const files: string[] = [];
      for (const [i, snap] of record.snapshots.entries())
        if (snap) {
          const f = path.join(OUT, `run${run + 1}-visit${i + 1}.json`);
          await writeFile(f, snap);
          files.push(f);
        }
      if (entry) {
        const f = path.join(OUT, `run${run + 1}-hall.json`);
        await writeFile(f, JSON.stringify(entry));
        files.push(f);
      } else if (last === "over") {
        failures++;
        console.log("  FAIL   the run ended but left no Hall entry");
      }
      if (entry)
        for (const [what, doctored] of tampered(entry)) {
          const f = path.join(OUT, `run${run + 1}-tampered.json`);
          await writeFile(f, JSON.stringify(doctored));
          const { ok, out } = audit(f);
          console.log(`  ${ok ? "FAIL  " : "ok    "} refuses ${what}`);
          if (ok) {
            failures++;
            console.log(out.replace(/^/gm, "         "));
          }
        }
      for (const f of files) {
        const { ok, out } = audit(f);
        const score = /Score\s+(\S+)/.exec(out)?.[1];
        console.log(
          `  ${ok ? "ok    " : "FAIL  "} ${path.basename(f)}  score ${score}`,
        );
        if (!ok) {
          failures++;
          console.log(out.replace(/^/gm, "         "));
        }
      }
    }
  } finally {
    await browser?.close();
    server.kill();
  }
  console.log(
    failures
      ? `\nReplay e2e: ${failures} FAILURE(S)`
      : "\nReplay e2e: ALL PASS",
  );
  if (failures) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
