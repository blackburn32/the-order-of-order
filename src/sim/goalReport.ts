// Renders a goal search and two validation passes into one self-contained HTML
// page: how the goals moved, and how the strategy grid fares before and after.
//
//   npm run goals:report
//   BEFORE=sim-out/goal-validate-before.json AFTER=sim-out/goal-validate.json \
//     SEARCH=sim-out/goal-search.json npm run goals:report
//
// | env    | default                           | what it reads                       |
// | ------ | --------------------------------- | ----------------------------------- |
// | SEARCH | sim-out/goal-search.json          | the goal search (bands, new goals)  |
// | BEFORE | sim-out/goal-validate-before.json | the baseline validation             |
// | AFTER  | sim-out/goal-validate.json        | the candidate's validation          |
// | SWEEP  | sim-out/goal-sweep.json           | optional: the percentile trade-off  |
// | EXTRA  | (none)                            | optional: one more validation line  |
// | OUT    | sim-out/goal-report.html          | the page                            |
//
// The page carries its data as JSON and draws its charts in the browser, so a
// chart's hover can read every series at a trial without a second encoding.
// It is written without <html>/<body> tags (browsers supply them), which is
// also the shape the Artifact publisher expects.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ValidateSummary } from "./goalValidate";

const SEARCH = process.env.SEARCH ?? "sim-out/goal-search.json";
const BEFORE = process.env.BEFORE ?? "sim-out/goal-validate-before.json";
const AFTER = process.env.AFTER ?? "sim-out/goal-validate.json";
const SWEEP = process.env.SWEEP ?? "sim-out/goal-sweep.json";
const EXTRA = process.env.EXTRA;
const OUT = process.env.OUT ?? "sim-out/goal-report.html";

interface SearchTrial {
  trial: number;
  rank: number;
  slot: number;
  budget: number;
  medianSeedMax: number;
  medianSeedPct: number;
  seedPctBand: [number, number];
  seedMaxBand: [number, number];
  all: { p10: number; p50: number; p80: number; p90: number; max: number };
}

interface SearchFile {
  seeds: number;
  grid: string[];
  percentile: number[];
  clearGold: [number, number];
  cadence: number[];
  trials: SearchTrial[];
  goals: string[];
  tables: Record<string, { goals: string[]; schedule: number[] }>;
}

function read<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function log10Str(v: string): number {
  if (v === "0") return -1;
  const head = v.slice(0, 15);
  return v.length - head.length + Math.log10(Number(head));
}

/** What the page needs from one validation pass. */
function slimValidation(s: ValidateSummary) {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    label: s.label,
    runs: s.runs,
    seeds: s.seeds,
    winRate: s.winRate,
    firstRollShare: s.firstRollShare,
    medianTrialReached: s.medianTrialReached,
    cadence: s.cadence,
    rerollPrices: s.rerollPrices,
    priceBands: s.priceBands,
    packPrices: s.packPrices,
    hungerRolls: s.hungerRolls,
    goals: s.goals.map(log10Str),
    goalText: s.goals,
    alive: s.trials.map((t) => r3(t.alive)),
    clearRate: s.trials.map((t) => r3(t.clearRate)),
    firstRoll: s.trials.map((t) => r3(t.firstRollShare)),
    budgetShare: s.trials.map((t) => r3(t.budgetShare)),
    entered: s.trials.map((t) => t.entered),
    strategies: s.strategies.map((st) => ({
      strategy: st.strategy,
      alive: st.alive.map(r3),
      winRate: st.winRate,
      medianTrialReached: st.medianTrialReached,
      firstRollShare: st.firstRollShare,
      runs: st.runs,
    })),
    bosses: s.bosses,
    shopGold: s.shopGold,
    // Clear rate over trials 2-29, weighted by entrants: "how often does a run
    // that reached a trial get past it", the number the old ladder had at ~95%.
    laterClearRate: (() => {
      let entered = 0;
      let cleared = 0;
      for (const t of s.trials.slice(1, 29)) {
        entered += t.entered;
        cleared += t.entered * t.clearRate;
      }
      return entered ? cleared / entered : 0;
    })(),
  };
}

function main(): void {
  const search = read<SearchFile>(SEARCH);
  const before = read<ValidateSummary>(BEFORE);
  const after = read<ValidateSummary>(AFTER);
  const sweep = existsSync(SWEEP)
    ? read<{ summaries: ValidateSummary[] }>(SWEEP).summaries
    : [];
  const extra = EXTRA ? read<ValidateSummary>(EXTRA) : null;

  const data = {
    search: {
      seeds: search.seeds,
      gridSize: search.grid.length,
      percentile: search.percentile,
      clearGold: search.clearGold,
      cadence: search.cadence,
      trials: search.trials.map((t) => ({
        trial: t.trial,
        rank: t.rank,
        slot: t.slot,
        budget: t.budget,
        seedMax: t.medianSeedMax,
        seedMaxBand: t.seedMaxBand,
        seedPct: t.medianSeedPct,
        seedPctBand: t.seedPctBand,
        p50: t.all.p50,
      })),
      literalP80: search.tables["0.8"]?.goals.map(log10Str) ?? null,
    },
    before: slimValidation(before),
    after: slimValidation(after),
    extra: extra ? slimValidation(extra) : null,
    sweep: sweep.map((s) => {
      const v = slimValidation(s);
      return {
        label: v.label.replace(/^percentile /, ""),
        winRate: v.winRate,
        firstRollShare: v.firstRollShare,
        medianTrialReached: v.medianTrialReached,
        laterClearRate: v.laterClearRate,
        aliveRank4: s.trials[9].alive,
      };
    }),
    generated: new Date().toISOString().slice(0, 10),
  };

  const html = PAGE.replace(
    "/*__DATA__*/null",
    JSON.stringify(data).replace(/</g, "\\u003c"),
  );
  const outPath = resolve(process.cwd(), OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Report → ${outPath}`);
}

// ---- the page ----------------------------------------------------------------

const PAGE = String.raw`<title>Goal Ladder Rebalance</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
/* Layout: one reading column; KPI strip, then a chart per question, each with
   its own legend above and hover readout; tables scroll inside their cards. */
:root {
  color-scheme: light;
  --page: #f6f6f3;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --ring: rgba(11, 11, 11, 0.1);
  --after: #2a78d6;
  --before: #eb6834;
  --third: #1baf7a;
  --band: rgba(42, 120, 214, 0.14);
  --up: #006300;
  --down: #b42b2b;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --ring: rgba(255, 255, 255, 0.1);
    --after: #3987e5;
    --before: #d95926;
    --third: #199e70;
    --band: rgba(57, 135, 229, 0.2);
    --up: #0ca30c;
    --down: #e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --ring: rgba(255, 255, 255, 0.1);
  --after: #3987e5;
  --before: #d95926;
  --third: #199e70;
  --band: rgba(57, 135, 229, 0.2);
  --up: #0ca30c;
  --down: #e66767;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.55 var(--font); }
main { max-width: 980px; margin: 0 auto; padding-inline: 16px; padding-block: 28px 56px; display: grid; gap: 20px; }
header { display: grid; gap: 6px; }
h1 { font-size: 1.75rem; line-height: 1.2; margin: 0; letter-spacing: -0.01em; text-wrap: balance; }
h2 { font-size: 1.08rem; margin: 0; text-wrap: balance; }
.sub { color: var(--ink-2); max-width: 70ch; margin: 0; }
.eyebrow { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 18px 18px 14px; display: grid; gap: 10px; min-width: 0; align-content: start; }
.card p { margin: 0; color: var(--ink-2); max-width: 75ch; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.kpi { background: var(--surface); border: 1px solid var(--ring); border-radius: 10px; padding: 14px 16px; display: grid; gap: 2px; }
.kpi .label { font-size: 0.78rem; color: var(--ink-2); }
.kpi .value { font-size: 1.7rem; font-weight: 650; line-height: 1.15; }
.kpi .was { font-size: 0.82rem; color: var(--muted); }
#rules td:nth-child(2) { color: var(--ink-2); }
#rules td { white-space: normal; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 0.82rem; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
.swatch.dash { background: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px) !important; height: 2px; }
.swatch.box { height: 10px; width: 14px; }
.chart { position: relative; width: 100%; }
.chart svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart text { fill: var(--muted); font: 11px var(--font); font-variant-numeric: tabular-nums; }
.chart .gridline { stroke: var(--grid); stroke-width: 1; }
.chart .baseline { stroke: var(--axis); stroke-width: 1; }
.chart .rankline { stroke: var(--grid); stroke-width: 1; stroke-dasharray: 2 3; }
.chart .cross { stroke: var(--muted); stroke-width: 1; }
.tip { position: absolute; pointer-events: none; background: var(--surface); color: var(--ink); border: 1px solid var(--ring); border-radius: 8px; padding: 8px 10px; font-size: 0.8rem; box-shadow: 0 4px 16px rgba(0,0,0,0.12); min-width: 160px; z-index: 2; }
.tip b { display: block; margin-bottom: 4px; }
.tip .row { display: flex; justify-content: space-between; gap: 14px; font-variant-numeric: tabular-nums; }
.tip .row i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.86rem; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { font-weight: 600; color: var(--ink-2); font-size: 0.78rem; }
tr.pick td { font-weight: 650; }
tr.pick td:first-child::after { content: " (shipped)"; font-weight: 400; color: var(--muted); }
.bar { display: inline-block; height: 8px; border-radius: 2px; vertical-align: middle; }
.up { color: var(--up); }
.down { color: var(--down); }
code { font-family: var(--mono); font-size: 0.85em; }
pre { font-family: var(--mono); font-size: 0.8rem; background: var(--page); border: 1px solid var(--ring); border-radius: 8px; padding: 10px 12px; overflow-x: auto; margin: 0; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
@media (max-width: 520px) { .kpi .value { font-size: 1.4rem; } h1 { font-size: 1.4rem; } }
</style>
<main>
  <header>
    <span class="eyebrow">The Order of Order · balance pass</span>
    <h1>Goal Ladder Rebalance</h1>
    <p class="sub" id="lede"></p>
  </header>
  <section class="kpis" id="kpis"></section>
  <section class="card">
    <h2>What changed in the rules</h2>
    <div class="scroll"><table id="rules"><thead><tr><th>Rule</th><th>Before</th><th>After</th></tr></thead><tbody></tbody></table></div>
  </section>
  <section class="card">
    <h2>Goals by trial</h2>
    <p id="goals-note"></p>
    <div class="legend" id="goals-legend"></div>
    <div class="chart" id="goals-chart"></div>
  </section>
  <section class="card">
    <h2>Runs still alive</h2>
    <p>Share of runs that reach each trial: the whole grid, and the expert bot on its own. The dotted verticals mark each rank's Lesser Trial.</p>
    <div class="legend" id="alive-legend"></div>
    <div class="chart" id="alive-chart"></div>
  </section>
  <div class="two">
    <section class="card">
      <h2>Clears on the opening roll</h2>
      <p>Of the runs that cleared a trial, the share that did it on roll 1.</p>
      <div class="legend" id="first-legend"></div>
      <div class="chart" id="first-chart"></div>
    </section>
    <section class="card">
      <h2>Roll budget spent per clear</h2>
      <p>How far into its rolls a cleared trial got before the goal fell.</p>
      <div class="legend" id="budget-legend"></div>
      <div class="chart" id="budget-chart"></div>
    </section>
  </div>
  <section class="card">
    <h2>Win rate by strategy</h2>
    <p>Each strategy pooled over its curse appetites, on held-out seeds. The duel at trial 30 is part of the win.</p>
    <div class="scroll"><table id="strategies"></table></div>
  </section>
  <section class="card" id="sweep-card">
    <h2>Choosing the percentile</h2>
    <p id="sweep-note"></p>
    <div class="scroll"><table id="sweep"></table></div>
  </section>
  <div class="two">
    <section class="card">
      <h2>Rerolls a shop's purse can buy</h2>
      <p id="reroll-note"></p>
      <div class="scroll"><table id="rerolls"></table></div>
    </section>
    <section class="card">
      <h2>Boss Trials cleared</h2>
      <p>Share of runs that faced each modifier and beat it, before and after.</p>
      <div class="scroll"><table id="bosses"></table></div>
    </section>
  </div>
  <section class="card">
    <h2>Reproduce it</h2>
    <p>Every number here comes from four commands; the sim README documents their knobs.</p>
    <pre id="commands"></pre>
  </section>
</main>
<script>
const D = /*__DATA__*/null;
const $ = (id) => document.getElementById(id);
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
const sup = (n) => String(n).split("").map((c) => SUP[c] ?? c).join("");
/** A log10 score as the number a player would read. */
function sci(x) {
  if (x == null || !isFinite(x)) return "–";
  if (x < 0) return "0";
  if (x < 6) return Math.round(Math.pow(10, x)).toLocaleString();
  const e = Math.floor(x);
  const m = Math.pow(10, x - e);
  return m.toFixed(m < 9.95 ? 1 : 0) + "×10" + sup(e);
}
const label = (t) => Math.ceil(t / 3) + "-" + (((t - 1) % 3) + 1);
const A = D.after, B = D.before, S = D.search;

// ---- header -----------------------------------------------------------------
$("lede").textContent =
  "Goals are now measured. A grid of " + S.gridSize + " bot strategies plays " + S.seeds +
  " seeds with the goals taken away; for each seed and trial the search takes the " + scheduleText(S.percentile) +
  " of the grid's scores, and the goal is the median of that across seeds. Below, the same grid plays the old and the new game on " +
  A.seeds + " held-out seeds" + (A.strategies.some((s) => s.strategy === "expert") ? ", with the expert bot alongside." : ".");
/** "80th percentile", or "50th percentile for rank 1 and 80th for ranks 2–10". */
function scheduleText(p) {
  const runs = [];
  p.forEach((q, i) => {
    const last = runs[runs.length - 1];
    if (last && last.q === q) last.to = i + 1;
    else runs.push({ q, from: i + 1, to: i + 1 });
  });
  const ord = (q) => Math.round(q * 100) + "th";
  if (runs.length === 1) return ord(runs[0].q) + " percentile";
  const parts = runs.map(
    (r, i) =>
      ord(r.q) + (i === 0 ? " percentile" : "") + " for " +
      (r.from === r.to ? "rank " + r.from : "ranks " + r.from + "–" + r.to),
  );
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

function kpi(labelText, now, was, better) {
  const el = document.createElement("div");
  el.className = "kpi";
  el.innerHTML = '<span class="label"></span><span class="value"></span><span class="was"></span>';
  el.children[0].textContent = labelText;
  el.children[1].textContent = now;
  el.children[2].textContent = "was " + was;
  $("kpis").append(el);
}
kpi("Runs that win", pct(A.winRate), pct(B.winRate));
kpi("Clears on roll 1", pct(A.firstRollShare), pct(B.firstRollShare));
kpi("Clear rate, trials 2–29", pct(A.laterClearRate), pct(B.laterClearRate));
kpi("Median run ends on trial", String(A.medianTrialReached), String(B.medianTrialReached));

// ---- rules ------------------------------------------------------------------
function rule(name, was, now) {
  const tr = document.createElement("tr");
  for (const text of [name, was, now]) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  $("rules").querySelector("tbody").append(tr);
}
rule("Rolls per trial (Lesser / Greater / Boss)", B.cadence.join(" / "), A.cadence.join(" / "));
rule("Reroll prices within one shop visit", B.rerollPrices.join(", ") + "… gold", A.rerollPrices.join(", ") + "… gold");
rule("Card price bands (low / standard / strong / build)",
  ["low", "standard", "strong", "build"].map((k) => B.priceBands[k]).join(" / "),
  ["low", "standard", "strong", "build"].map((k) => A.priceBands[k]).join(" / "));
rule("Booster packs (common → rare)",
  ["common_pack", "uncommon_pack", "rare_pack"].map((k) => B.packPrices[k]).join(" / "),
  ["common_pack", "uncommon_pack", "rare_pack"].map((k) => A.packPrices[k]).join(" / "));
rule("The Hunger", -B.hungerRolls + " fewer rolls", -A.hungerRolls + " fewer rolls");
rule("Goal at trial 10 / 20 / 29", [9, 19, 28].map((i) => sci(B.goals[i])).join(" / "), [9, 19, 28].map((i) => sci(A.goals[i])).join(" / "));

// ---- a small line chart with a crosshair --------------------------------------
function legend(id, items) {
  const el = $(id);
  for (const it of items) {
    const s = document.createElement("span");
    const sw = document.createElement("i");
    sw.className = "swatch" + (it.dash ? " dash" : "") + (it.box ? " box" : "");
    sw.style.background = it.color;
    sw.style.color = it.color;
    s.append(sw, document.createTextNode(it.name));
    el.append(s);
  }
}

/**
 * series: [{ name, color, values[], dash?, band?: [lo[], hi[]] }]
 * opts: { log, min, max, fmt, ticks, height }
 */
function lineChart(id, xs, series, opts) {
  const root = $(id);
  const W = opts.width ?? 920, H = opts.height ?? 300;
  const m = { top: 12, right: 14, bottom: 30, left: opts.left ?? 62 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const x = (t) => m.left + ((t - xs[0]) / (xs[xs.length - 1] - xs[0])) * iw;
  const y = (v) => m.top + ih - ((v - opts.min) / (opts.max - opts.min)) * ih;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("role", "img");
  let g = "";
  for (const v of opts.ticks) {
    g += '<line class="gridline" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
    g += '<text x="' + (m.left - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + opts.fmt(v) + "</text>";
  }
  for (const t of xs) {
    if ((t - 1) % 3 === 0 && t > 1) g += '<line class="rankline" x1="' + x(t) + '" x2="' + x(t) + '" y1="' + m.top + '" y2="' + (m.top + ih) + '"/>';
    const every = opts.width && opts.width < 600 ? 6 : 3;
    if ((t - 1) % every === 0) g += '<text x="' + x(t) + '" y="' + (H - 10) + '" text-anchor="middle">' + label(t) + "</text>";
  }
  g += '<line class="baseline" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + (m.top + ih) + '" y2="' + (m.top + ih) + '"/>';
  const clamp = (v) => Math.max(opts.min, Math.min(opts.max, v));
  for (const s of series) {
    if (s.band) {
      const [lo, hi] = s.band;
      const pts = xs.map((t, i) => x(t) + "," + y(clamp(hi[i])));
      const back = xs.map((t, i) => x(t) + "," + y(clamp(lo[i]))).reverse();
      g += '<polygon points="' + pts.concat(back).join(" ") + '" fill="' + s.color + '" stroke="none"/>';
      continue;
    }
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null || !isFinite(v)) { pen = false; return; }
      d += (pen ? "L" : "M") + x(xs[i]).toFixed(1) + "," + y(clamp(v)).toFixed(1);
      pen = true;
    });
    g += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' + (s.dash ? ' stroke-dasharray="5 4"' : "") + "/>";
  }
  g += '<line class="cross" id="' + id + '-cross" y1="' + m.top + '" y2="' + (m.top + ih) + '" visibility="hidden"/>';
  g += '<g id="' + id + '-dots"></g>';
  svg.innerHTML = g;
  root.append(svg);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(tip);
  const cross = svg.querySelector("#" + id + "-cross");
  const dots = svg.querySelector("#" + id + "-dots");
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    let i = Math.round(((sx - m.left) / iw) * (xs.length - 1));
    i = Math.max(0, Math.min(xs.length - 1, i));
    const px = x(xs[i]);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    let dh = "";
    let rows = "";
    for (const s of series) {
      if (s.band || s.noTip) continue;
      const v = s.values[i];
      if (v == null || !isFinite(v)) continue;
      dh += '<circle cx="' + px + '" cy="' + y(clamp(v)) + '" r="4" fill="' + s.color + '" stroke="var(--surface)" stroke-width="2"/>';
      rows += '<div class="row"><span><i style="background:' + s.color + '"></i>' + s.name + "</span><span>" + opts.fmt(v, true) + "</span></div>";
    }
    dots.innerHTML = dh;
    tip.innerHTML = "<b>Trial " + xs[i] + " · " + label(xs[i]) + (opts.extra ? opts.extra(i) : "") + "</b>" + rows;
    tip.hidden = false;
    const left = (px / W) * r.width;
    tip.style.top = "8px";
    tip.style.left = (left > r.width / 2 ? left - tip.offsetWidth - 12 : left + 12) + "px";
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.innerHTML = ""; };
  svg.addEventListener("pointermove", (e) => show(e.clientX));
  svg.addEventListener("pointerdown", (e) => show(e.clientX));
  svg.addEventListener("pointerleave", hide);
}

const xs = Array.from({ length: 30 }, (_, i) => i + 1);
const css = (v) => "var(" + v + ")";

// ---- goals ------------------------------------------------------------------
{
  const top = Math.ceil(Math.max(...S.trials.map((t) => t.seedMaxBand[1]), ...A.goals, ...B.goals) + 0.2);
  const series = [
    { name: "Grid percentile, spread across seeds (20th–80th)", color: css("--band"), band: [S.trials.map((t) => t.seedPctBand[0]), S.trials.map((t) => t.seedPctBand[1])] },
    { name: "Best strategy on a typical seed", color: css("--third"), values: S.trials.map((t) => t.seedMax), dash: true },
    { name: "Median strategy run", color: css("--muted"), values: S.trials.map((t) => t.p50), dash: true },
    { name: "Old goal", color: css("--before"), values: B.goals },
    { name: "New goal", color: css("--after"), values: A.goals },
  ];
  legend("goals-legend", series.map((s) => ({ name: s.name, color: s.color, dash: s.dash, box: !!s.band })));
  const ticks = [];
  for (let v = 0; v <= top; v += top > 12 ? 2 : 1) ticks.push(v);
  lineChart("goals-chart", xs, series, {
    min: 0, max: top, ticks, height: 340,
    fmt: (v, tip) => (tip ? sci(v) : v === 0 ? "1" : "10" + sup(v)),
    extra: (i) => " · " + S.trials[i].budget + " rolls",
  });
  $("goals-note").textContent =
    "Log scale. The band and dashed lines come from the goal search, where every trial plays its whole roll budget with no goal, " +
    "nothing is culled, and each trial pays out as a clear plus " + S.clearGold.join("–") + " gold of assumed early-completion pay. " +
    "Trial 1 keeps its goal of 1. Goals are rounded to three significant figures and never drop within a rank or from one rank's slot to the next.";
}

// ---- survival, first roll, budget ---------------------------------------------
function pair() {
  const s = [
    { name: "Before", color: css("--before"), key: "before" },
    { name: "After", color: css("--after"), key: "after" },
  ];
  if (D.extra) s.splice(1, 0, { name: D.extra.label, color: css("--third"), key: "extra" });
  return s;
}
{
  const ser = pair().map((s) => ({ ...s, values: D[s.key].alive }));
  // The expert, alone: the closest the sim has to a strong player.
  const ex = (v) => v.strategies.find((s) => s.strategy === "expert");
  if (ex(B) && ex(A)) {
    ser.push({ name: "Expert before", color: css("--before"), dash: true, values: ex(B).alive });
    ser.push({ name: "Expert after", color: css("--after"), dash: true, values: ex(A).alive });
  }
  legend("alive-legend", ser);
  lineChart("alive-chart", xs, ser, {
    min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v, tip) => pct(v, tip ? 1 : 0),
  });
}
{
  // A trial nobody reached has no clears to measure; leave a gap, not a zero.
  const mask = (v, key) => v.map((x, i) => (D[key].entered[i] >= 20 && i < 29 ? x : null));
  const ser = pair().map((s) => ({ ...s, values: mask(D[s.key].firstRoll, s.key) }));
  legend("first-legend", ser);
  lineChart("first-chart", xs, ser, {
    min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v, tip) => pct(v, 0), width: 460, height: 280, left: 44,
    extra: (i) => " · " + D.after.entered[i] + " runs entered",
  });
  const ser2 = pair().map((s) => ({ ...s, values: mask(D[s.key].budgetShare, s.key) }));
  legend("budget-legend", ser2);
  lineChart("budget-chart", xs, ser2, {
    min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v, tip) => pct(v, 0), width: 460, height: 280, left: 44,
  });
}

// ---- strategies -------------------------------------------------------------
{
  const byName = new Map(B.strategies.map((s) => [s.strategy, s]));
  const rows = [...A.strategies].sort((a, b) => b.winRate - a.winRate || b.medianTrialReached - a.medianTrialReached);
  const maxWin = Math.max(...rows.map((r) => r.winRate), ...B.strategies.map((r) => r.winRate), 0.01);
  let h = "<thead><tr><th>Strategy</th><th>Win before</th><th>Win after</th><th></th><th>Median trial before → after</th><th>Roll-1 clears before → after</th><th>Runs</th></tr></thead><tbody>";
  for (const r of rows) {
    const b = byName.get(r.strategy);
    const wb = b ? b.winRate : 0;
    h += "<tr><td>" + r.strategy + "</td><td>" + pct(wb) + "</td><td>" + pct(r.winRate) + "</td>" +
      '<td style="min-width:120px"><span class="bar" style="width:' + (wb / maxWin) * 100 + 'px;background:var(--before)"></span><br><span class="bar" style="width:' + (r.winRate / maxWin) * 100 + 'px;background:var(--after)"></span></td>' +
      "<td>" + (b ? b.medianTrialReached : "–") + " → " + r.medianTrialReached + "</td>" +
      "<td>" + (b ? pct(b.firstRollShare, 0) : "–") + " → " + pct(r.firstRollShare, 0) + "</td><td>" + r.runs + "</td></tr>";
  }
  $("strategies").innerHTML = h + "</tbody>";
}

// ---- sweep ------------------------------------------------------------------
if (D.sweep.length === 0) $("sweep-card").hidden = true;
else {
  const shipped = S.percentile.every((q) => q === S.percentile[0]) ? String(S.percentile[0]) : S.percentile.join(",");
  $("sweep-note").textContent =
    "The same search, read at other percentiles and played with culling on. Higher percentiles cut first-roll clears but compound into a ladder almost no run survives, because every trial culls on its own. The shipped row is the table above.";
  let h = "<thead><tr><th>Percentile</th><th>Runs that win</th><th>Alive at rank 4</th><th>Clear rate, trials 2–29</th><th>Clears on roll 1</th><th>Median trial</th></tr></thead><tbody>";
  // The shipped table first, then the flat percentiles in order.
  const rows = [...D.sweep].sort((a, b) => (a.label === shipped ? -1 : Number(a.label)) - (b.label === shipped ? -1 : Number(b.label)));
  const name = (l) => (l.includes(",") ? scheduleText(l.split(",").map(Number)) : Math.round(Number(l) * 100) + "th percentile");
  for (const r of rows) {
    h += '<tr class="' + (r.label === shipped ? "pick" : "") + '"><td style="white-space:normal;min-width:180px">' + name(r.label) + "</td><td>" + pct(r.winRate) + "</td><td>" + pct(r.aliveRank4) + "</td><td>" + pct(r.laterClearRate) + "</td><td>" + pct(r.firstRollShare) + "</td><td>" + r.medianTrialReached + "</td></tr>";
  }
  $("sweep").innerHTML = h + "</tbody>";
}

// ---- rerolls ----------------------------------------------------------------
{
  $("reroll-note").textContent =
    "Gold in hand as each shop opens, after the new prices: how many rerolls in a row it could pay for (" +
    A.rerollPrices.slice(0, 3).join(", ") + "… gold) if it bought nothing else. Runs that reached each rank.";
  let h = "<thead><tr><th>Rank</th><th>Median purse</th><th>0</th><th>1</th><th>2</th><th>3+</th></tr></thead><tbody>";
  for (const g of A.shopGold) {
    const a = g.rerollsAffordable;
    const three = Object.entries(a).filter(([k]) => Number(k) >= 3).reduce((s, [, v]) => s + v, 0);
    h += "<tr><td>" + g.rank + "</td><td>" + g.p50 + "</td><td>" + pct(a[0] ?? 0, 0) + "</td><td>" + pct(a[1] ?? 0, 0) + "</td><td>" + pct(a[2] ?? 0, 0) + "</td><td>" + pct(three, 0) + "</td></tr>";
  }
  $("rerolls").innerHTML = h + "</tbody>";
}

// ---- bosses -----------------------------------------------------------------
{
  const before = new Map(B.bosses.map((b) => [b.boss, b]));
  const name = (id) => "The " + id[0].toUpperCase() + id.slice(1);
  let h = "<thead><tr><th>Modifier</th><th>Before</th><th>After</th><th>Faced after</th></tr></thead><tbody>";
  for (const b of A.bosses) {
    const o = before.get(b.boss);
    h += "<tr><td>" + name(b.boss) + "</td><td>" + (o ? pct(o.cleared / o.faced, 0) : "–") + "</td><td>" + pct(b.cleared / b.faced, 0) + "</td><td>" + b.faced + "</td></tr>";
  }
  $("bosses").innerHTML = h + "</tbody>";
}

$("commands").textContent = [
  "npm run goals:search      # " + S.seeds + " seeds × " + S.gridSize + " strategies, goals removed",
  "npm run goals:sweep       # every percentile's table, played with culling",
  "npm run goals:validate    # one table (the live one by default), held-out seeds",
  "npm run goals:report      # this page",
].join("\n");
</script>
`;

main();
