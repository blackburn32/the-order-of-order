// Renders a BatchStats into one self-contained HTML file (inline CSS + inline
// SVG, no network). Palette and conventions follow the dataviz method: fixed
// categorical series colors, one axis per chart, a legend for multi-series, thin
// marks with rounded data-ends, native <title> hover tooltips, and a selected
// dark mode (not an auto-flip). Detail-heavy per-item numbers live in tables.

import { BatchStats, ItemStat, StrategyStats } from "./stats";
import { SIM_SERIES } from "./series";

const STRATEGY_ORDER = SIM_SERIES.map((series) => series.id);
const STRATEGY_LABEL = new Map(
  SIM_SERIES.map((series) => [series.id, series.label]),
);

function strategyLabel(name: string): string {
  return STRATEGY_LABEL.get(name) ?? name;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const n1 = (x: number) => x.toFixed(1);
const int = (x: number) => Math.round(x).toLocaleString();
const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

function seriesVar(i: number): string {
  return `var(--series-${i + 1})`;
}

// ---- SVG chart builders ----------------------------------------------------

/** Grouped vertical bars: one group per category, one bar per series. */
function groupedBars(
  categories: string[],
  series: { name: string; color: string; values: number[] }[],
  opts: {
    width?: number;
    height?: number;
    yLabel?: string;
    fmt?: (v: number) => string;
  } = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 260;
  const m = { top: 14, right: 12, bottom: 30, left: 44 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const fmt = opts.fmt ?? ((v) => String(v));
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const groupW = iw / categories.length;
  const barW = Math.max(2, (groupW * 0.8) / series.length);
  const y = (v: number) => m.top + ih - (v / max) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const gy = m.top + ih - t * ih;
      return (
        `<line x1="${m.left}" y1="${gy}" x2="${W - m.right}" y2="${gy}" class="grid"/>` +
        `<text x="${m.left - 6}" y="${gy + 3}" class="tick" text-anchor="end">${fmt(t * max)}</text>`
      );
    })
    .join("");

  const bars = categories
    .map((cat, ci) => {
      const gx = m.left + ci * groupW + groupW * 0.1;
      const inner = series
        .map((s, si) => {
          const v = s.values[ci] ?? 0;
          const bx = gx + si * barW;
          const by = y(v);
          const bh = m.top + ih - by;
          return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2" fill="${s.color}"><title>${esc(s.name)} · ${esc(cat)}: ${esc(fmt(v))}</title></rect>`;
        })
        .join("");
      const label = `<text x="${(gx + (barW * series.length) / 2).toFixed(1)}" y="${H - m.bottom + 16}" class="tick" text-anchor="middle">${esc(cat)}</text>`;
      return inner + label;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${bars}</svg>`;
}

/** Multi-series line chart with an optional log-y scale and a dashed reference line. */
function lineChart(
  xs: number[],
  series: {
    name: string;
    color: string;
    points: { x: number; y: number }[];
    dashed?: boolean;
  }[],
  opts: {
    width?: number;
    height?: number;
    log?: boolean;
    fmt?: (v: number) => string;
    xLabel?: string;
  } = {},
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 300;
  const m = { top: 14, right: 14, bottom: 32, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const fmt = opts.fmt ?? ((v) => int(v));
  const allY = series
    .flatMap((s) => s.points.map((p) => p.y))
    .filter((v) => v > 0);
  const rawMax = Math.max(
    1,
    ...series.flatMap((s) => s.points.map((p) => p.y)),
  );
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const log = opts.log ?? false;
  const yMin = log ? Math.max(0.5, Math.min(...allY, 1)) : 0;
  const yMax = rawMax;
  const sx = (x: number) =>
    m.left + ((x - xMin) / Math.max(1, xMax - xMin)) * iw;
  const sy = (v: number) => {
    if (log) {
      const lv = Math.log10(Math.max(yMin, v));
      const lo = Math.log10(yMin);
      const hi = Math.log10(yMax);
      return m.top + ih - ((lv - lo) / Math.max(0.0001, hi - lo)) * ih;
    }
    return m.top + ih - (v / yMax) * ih;
  };

  const yTicks = log
    ? [1, 10, 100, 1000, 10000, 100000, 1000000].filter(
        (v) => v >= yMin * 0.9 && v <= yMax * 1.1,
      )
    : [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const grid = yTicks
    .map((v) => {
      const gy = sy(v);
      return (
        `<line x1="${m.left}" y1="${gy}" x2="${W - m.right}" y2="${gy}" class="grid"/>` +
        `<text x="${m.left - 6}" y="${gy + 3}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`
      );
    })
    .join("");

  const xTicks = xs
    .map(
      (x) =>
        `<text x="${sx(x)}" y="${H - m.bottom + 16}" class="tick" text-anchor="middle">${x}</text>`,
    )
    .join("");

  const paths = series
    .map((s) => {
      if (!s.points.length) return "";
      const d = s.points
        .map(
          (p, i) =>
            `${i === 0 ? "M" : "L"} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`,
        )
        .join(" ");
      const dots = s.points
        .map(
          (p) =>
            `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.name)} · round ${p.x}: ${esc(fmt(p.y))}</title></circle>`,
        )
        .join("");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="5 4"' : ""}/>${dots}`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${xTicks}${paths}</svg>`;
}

/** Horizontal bars, sorted by value desc. Each row: label + bar + display value. */
function hbars(
  rows: { label: string; value: number; display: string; hint?: string }[],
  color: string,
): string {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map((r) => {
      const w = (r.value / max) * 100;
      return (
        `<div class="hbar-row" title="${esc(r.hint ?? r.label)}"><span class="hbar-label">${esc(r.label)}</span>` +
        `<span class="hbar-track"><span class="hbar-fill" style="width:${w.toFixed(1)}%;background:${color}"></span></span>` +
        `<span class="hbar-val">${esc(r.display)}</span></div>`
      );
    })
    .join("")}</div>`;
}

function legend(stats: StrategyStats[]): string {
  return `<div class="legend">${stats
    .map(
      (s, i) =>
        `<span class="lg"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(strategyLabel(s.name))}</span>`,
    )
    .join("")}</div>`;
}

// ---- sections --------------------------------------------------------------

/** Per-modifier clear rates. A Boss Trial is only fair if beating it is roughly
 *  as likely whichever modifier turns up, so this table is read for OUTLIERS,
 *  not for absolute numbers: anything far off its peers wants retuning. */
function bossSection(stats: StrategyStats[]): string {
  const cards = stats
    .map((s, i) => {
      const faced = s.bosses.filter((b) => b.faced > 0);
      if (faced.length === 0) return "";
      const meanRate =
        faced.reduce((a, b) => a + b.clearRate, 0) / faced.length;
      const rows = faced
        .slice()
        .sort((a, b) => b.clearRate - a.clearRate)
        .map((b) => {
          const ratio = meanRate > 0 ? b.clearRate / meanRate : 1;
          const out = ratio < 0.6 || ratio > 1.4;
          return {
            label: b.name,
            value: b.clearRate,
            display: `${pct(b.clearRate)}${out ? " !" : ""}`,
            hint: `${b.name}: cleared ${pct(b.clearRate)} of ${int(b.faced)} encounters (${ratio.toFixed(2)}x this strategy's mean)`,
          };
        });
      return `<div class="unlock-card"><div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(strategyLabel(s.name))} <span class="cap">· mean ${pct(meanRate)}</span></div>${hbars(rows, seriesVar(i))}</div>`;
    })
    .join("");
  if (!cards) return "";
  return (
    `<section><h2>Boss Trial clear rates</h2>` +
    `<p class="note">How often each modifier was beaten when it turned up. Read this for outliers rather than absolute numbers: a modifier marked ! is more than 40% away from its strategy's mean, which means it is either a wall or a free pass compared to its peers.</p>` +
    `<div class="unlock-grid">${cards}</div>` +
    `</section>`
  );
}

/** Where the purse went. Gold is the whole shop economy now, so a strategy that
 *  ends runs sitting on unspent gold is either priced out or hoarding. */
function goldSection(stats: StrategyStats[]): string {
  const rows = stats.map((s, i) => ({
    label: strategyLabel(s.name),
    value: s.gold.earned > 0 ? s.gold.spent / s.gold.earned : 0,
    text: `${int(s.gold.spent)} / ${int(s.gold.earned)}`,
    hint: `${strategyLabel(s.name)}: spent ${int(s.gold.spent)} of ${int(s.gold.earned)} gold earned; median ${int(s.gold.medianHeld)} held at a trial clear`,
    color: seriesVar(i),
  }));
  return (
    `<section><h2>Gold earned and spent</h2>` +
    `<p class="note">Mean gold spent as a share of gold earned, per run. A low bar means the strategy could not find anything worth buying (or was priced out); a bar near 100% means it is spending everything it makes, and its ceiling is income rather than choice.</p>` +
    `<div class="hbars">${rows
      .map(
        (r) =>
          `<div class="hbar-row" title="${esc(r.hint)}"><span class="hbar-label">${esc(r.label)}</span>` +
          `<span class="hbar-track"><span class="hbar-fill" style="width:${(Math.min(1, r.value) * 100).toFixed(1)}%;background:${r.color}"></span></span>` +
          `<span class="hbar-val">${esc(r.text)}</span></div>`,
      )
      .join("")}</div>` +
    `</section>`
  );
}

function summaryTiles(stats: StrategyStats[]): string {
  return `<div class="tiles">${stats
    .map(
      (s, i) =>
        `<div class="tile"><div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(strategyLabel(s.name))}</div>` +
        `<div class="tile-grid">` +
        `<div><span class="big">${pct(s.winRate)}</span><span class="cap">win rate</span></div>` +
        `<div><span class="big">${n1(s.rank.median)}</span><span class="cap">median rank</span></div>` +
        `<div><span class="big">${int(s.score.median)}</span><span class="cap">median score</span></div>` +
        `<div><span class="big">${int(s.finalDice.median)}</span><span class="cap">median dice</span></div>` +
        `<div><span class="big">${int(s.gold.earned)}</span><span class="cap">gold earned</span></div>` +
        `<div><span class="big">${int(s.gold.medianHeld)}</span><span class="cap">gold held</span></div>` +
        `<div><span class="big">${n1(s.rolls.meanUsed)}</span><span class="cap">rolls per clear</span></div>` +
        `<div><span class="big">${pct(s.rolls.firstRollClearRate)}</span><span class="cap">cleared on roll 1</span></div>` +
        `</div></div>`,
    )
    .join("")}</div>`;
}

function histogramSection(
  stats: StrategyStats[],
  trialsPerRank: number,
): string {
  // Labelled "rank-trial" rather than 1..15, because which trial of a rank a run
  // died on is the interesting part — a rank that kills on its Lesser Trial is
  // a very different problem from one that kills on its boss.
  const trials = stats[0].trial.histogram.map((_, i) => {
    const rank = Math.floor(i / trialsPerRank) + 1;
    return `${rank}-${(i % trialsPerRank) + 1}`;
  });
  const series = stats.map((s, i) => ({
    name: strategyLabel(s.name),
    color: seriesVar(i),
    values: s.trial.histogram,
  }));
  const last = stats[0]?.trial.histogram.length ?? 15;
  return (
    `<section><h2>Where runs end</h2>` +
    `<p class="note">Number of runs that ended on each trial, labelled rank-trial (the trial they died on, or the ${last}th = cleared the final rank / victory). Tall bars on a rank's third column mean the Boss Trial is doing the killing.</p>` +
    legend(stats) +
    groupedBars(trials, series, { fmt: (v) => int(v) }) +
    `</section>`
  );
}

function survivalSection(stats: StrategyStats[]): string {
  const maxTrial = stats[0].trial.histogram.length; // = WIN_TRIAL
  const xs = Array.from({ length: maxTrial }, (_, i) => i + 1);
  // Survival curve from the death histogram: the share of runs that reached at
  // least trial t. Starts at 100% on trial 1 and decreases monotonically; the
  // value on the final trial is the win rate.
  const series = stats.map((s, i) => {
    const total = s.runs || 1;
    const points = xs.map((t) => {
      let reached = 0;
      for (let k = t; k <= maxTrial; k++) reached += s.trial.histogram[k - 1];
      return { x: t, y: reached / total };
    });
    return { name: strategyLabel(s.name), color: seriesVar(i), points };
  });
  return (
    `<section><h2>Runs still alive by trial</h2>` +
    `<p class="note">Share of runs that survived to reach each trial. Every run starts at 100% on trial 1 and the curve drops as runs die; its height on trial ${maxTrial} is the share reaching the final trial, a hair above the win rate since some reach it but die there. A steep drop marks a difficulty wall — and the attrition intent wants those drops spread evenly, not stacked.</p>` +
    legend(stats) +
    lineChart(xs, series, { fmt: (v) => pct(v) }) +
    `</section>`
  );
}

function curveSection(stats: StrategyStats[]): string {
  const maxTrial = Math.max(
    ...stats.flatMap((s) => s.trialCurve.map((p) => p.trial)),
    1,
  );
  const xs = Array.from({ length: maxTrial }, (_, i) => i + 1);
  const goal = stats[0]
    ? {
        name: "Trial goal",
        color: "var(--muted)",
        dashed: true,
        points: xs.map((x) => ({ x, y: trialGoalFrom(stats, x) })),
      }
    : { name: "goal", color: "var(--muted)", points: [] };
  const series = [
    ...stats.map((s, i) => ({
      name: strategyLabel(s.name),
      color: seriesVar(i),
      points: s.trialCurve.map((p) => ({
        x: p.trial,
        y: Math.max(1, p.medianTrialScore),
      })),
    })),
    goal,
  ];
  return (
    `<section><h2>Peak score vs. goal, by trial</h2>` +
    `<p class="note">Median peak score reached each trial (log scale) against that trial's goal (dashed). Where a strategy's line dips toward the goal, runs are scraping by; where it crosses below, they die. The saw-tooth is the shape of a rank: a short Lesser Trial scores less than the long Boss Trial that follows it.</p>` +
    legend(stats) +
    lineChart(xs, series, { log: true, fmt: (v) => int(v) }) +
    `</section>`
  );
}

function trialGoalFrom(stats: StrategyStats[], trial: number): number {
  for (const s of stats) {
    const p = s.trialCurve.find((c) => c.trial === trial);
    if (p) return p.goal;
  }
  return 0;
}

/**
 * How much of a trial the field actually plays.
 *
 * A goal curve can be correct about attrition and still wrong about tempo: if
 * the trial ends on the opening roll, the twenty rolls it granted were never a
 * resource and the trial was never a decision. This is the section that says so.
 *
 * Cleared trials only, and counted at the roll the goal was CROSSED, so a run
 * that died having burned its whole budget cannot read as good pacing.
 */

/** The reference line on the chart: half a trial's budget. Not a promise — the
 *  field does not reach it and cannot be made to by the goal curve alone (see
 *  the note the section prints) — but a legible benchmark to read the curve
 *  against, which a line nothing comes near would not be. */
const PACING_TARGET = 0.5;

/** Above this share of clears landing on the opening roll, the trial is being
 *  decided before it is played. This is the failure this section exists to
 *  surface, so it is the column that gets flagged. */
const FIRST_ROLL_ALARM = 0.45;

function rollPacingSection(stats: StrategyStats[]): string {
  const maxTrial = Math.max(
    ...stats.flatMap((s) => s.trialCurve.map((p) => p.trial)),
    1,
  );
  const xs = Array.from({ length: maxTrial }, (_, i) => i + 1);
  const series = [
    ...stats.map((s, i) => ({
      name: strategyLabel(s.name),
      color: seriesVar(i),
      points: s.trialCurve
        .filter((p) => p.clearRate > 0)
        .map((p) => ({ x: p.trial, y: p.rollShare })),
    })),
    {
      name: "Half the budget",
      color: "var(--muted)",
      dashed: true,
      points: xs.map((x) => ({ x, y: PACING_TARGET })),
    },
  ];

  return (
    `<section><h2>Rolls spent per trial</h2>` +
    `<p class="note">Share of a trial's roll budget spent before its goal was crossed, over the runs that cleared it, against a dashed line at half the budget. Lines along the bottom of the chart are trials being won before they are played, where the roll budget is decoration rather than a resource to spend.</p>` +
    `<p class="note">The goal curve alone cannot lift this much further, and the ceiling is worth knowing: a trial's full-budget capacity runs about a thousandfold from the field's tenth percentile to its ninetieth, so any goal the weakest tenth can survive is met on the opening roll by the strongest tenth. A goal is one number, so its attrition fixes it and the tempo follows — <code>src/sim/pacingSweep.ts</code> prints what every other attrition target would cost. Tempo past that has to be bought somewhere other than the goal: a shorter roll budget, or items whose per-roll spread is narrower.</p>` +
    `<p class="note">The last trial reads 100% because it is the duel, which has no goal to cross and is decided when the rolls run out. A trial flagged ! has more than ${pct(FIRST_ROLL_ALARM)} of its clears landing on the opening roll.</p>` +
    legend(stats) +
    lineChart(xs, series, { fmt: (v) => pct(v) }) +
    pacingTable(stats, maxTrial) +
    `</section>`
  );
}

/** The same numbers as the chart, pooled across strategies and weighted by
 *  clears, because a goal is authored per trial and this is the column to read
 *  while authoring it. */
function pacingTable(stats: StrategyStats[], maxTrial: number): string {
  const rows: string[] = [];
  for (let trial = 1; trial <= maxTrial; trial++) {
    let clears = 0;
    let used = 0;
    let budget = 0;
    let firstRoll = 0;
    let entered = 0;
    let goal = 0;
    for (const s of stats) {
      const p = s.trialCurve.find((c) => c.trial === trial);
      if (!p) continue;
      goal = p.goal;
      entered += p.runsReached;
      const n = p.runsReached * p.clearRate;
      clears += n;
      used += p.meanRollsUsed * n;
      budget += p.meanRollBudget * n;
      firstRoll += p.firstRollClearRate * n;
    }
    if (entered === 0) continue;
    const share = budget > 0 ? used / budget : 0;
    const firstRollRate = clears > 0 ? firstRoll / clears : 0;
    const flag = firstRollRate > FIRST_ROLL_ALARM ? " !" : "";
    rows.push(
      `<tr><td class="num">${trial}</td><td class="num">${int(goal)}</td>` +
        `<td class="num">${clears > 0 ? n1(used / clears) : "—"}</td>` +
        `<td class="num">${clears > 0 ? n1(budget / clears) : "—"}</td>` +
        `<td class="num">${clears > 0 ? pct(share) : "—"}</td>` +
        `<td class="num">${clears > 0 ? pct(firstRollRate) + flag : "—"}</td>` +
        `<td class="num">${clears > 0 ? pct(clears / entered) : "0.0%"}</td></tr>`,
    );
  }
  return (
    `<div class="tablewrap"><table>` +
    `<tr><th>Trial</th><th class="num">Goal</th><th class="num">Rolls used</th>` +
    `<th class="num">Budget</th><th class="num">Share</th>` +
    `<th class="num">1-roll clears</th><th class="num">Clear rate</th></tr>` +
    rows.join("") +
    `</table></div>`
  );
}

function itemTableSection(stats: StrategyStats[]): string {
  const rarityRank: Record<string, number> = {
    common: 0,
    uncommon: 1,
    rare: 2,
  };
  const priceRank: Record<string, number> = {
    free: 0,
    low: 1,
    standard: 2,
    strong: 3,
    build: 4,
  };
  const base = stats[0].items
    .slice()
    .sort(
      (a, b) =>
        rarityRank[a.rarity] - rarityRank[b.rarity] ||
        priceRank[a.priceBand] - priceRank[b.priceBand] ||
        a.name.localeCompare(b.name),
    );

  const byStrat = new Map<string, Map<string, ItemStat>>();
  for (const s of stats)
    byStrat.set(s.name, new Map(s.items.map((it) => [it.id, it])));

  const head =
    `<tr><th>Item</th><th>Price band</th><th>Rarity</th>` +
    stats
      .map(
        (s) => `<th class="grp" colspan="2">${esc(strategyLabel(s.name))}</th>`,
      )
      .join("") +
    `</tr><tr><th></th><th></th><th></th>` +
    stats.map(() => `<th>buy%</th><th>win% if bought</th>`).join("") +
    `</tr>`;

  const rows = base
    .map((it) => {
      const cells = stats
        .map((s) => {
          const st = byStrat.get(s.name)!.get(it.id)!;
          const buy = st.buyRate > 0 ? pct(st.buyRate) : "—";
          const win = st.buyRuns > 0 ? pct(st.winRateIfBought) : "—";
          return `<td class="num">${buy}</td><td class="num">${win}</td>`;
        })
        .join("");
      const band = it.priceBand === "build" ? "build-defining" : it.priceBand;
      return `<tr><td>${esc(it.name)}${it.gated ? ' <span class="gated">gated</span>' : ""}</td><td>${esc(band)}</td><td>${it.rarity}</td>${cells}</tr>`;
    })
    .join("");

  return (
    `<section><h2>Item purchase &amp; win correlation</h2>` +
    `<p class="note">Price bands resolve to a share of the current round target; concrete costs also account for shop timing and repeat purchases. Per strategy: how often each offered item was bought when it appeared, and the win rate of runs that bought it (selection bias — a strong item and a strong run correlate; read alongside the baseline).</p>` +
    `<div class="tablewrap"><table>${head}${rows}</table></div></section>`
  );
}

function itemPointsSection(stats: StrategyStats[]): string {
  const TOP = 12;
  const cards = stats
    .map((s, i) => {
      const head = `<div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(strategyLabel(s.name))} <span class="cap">· ${int(s.winningRuns)} wins</span></div>`;
      if (s.winningRuns === 0 || s.itemPointRanking.length === 0) {
        return `<div class="unlock-card">${head}<p class="note">No winning runs to attribute.</p></div>`;
      }
      const rows = s.itemPointRanking.slice(0, TOP).map((it) => ({
        label: it.label,
        value: it.avgPoints,
        display: `${int(it.avgPoints)} · ${pct(it.shareOfWinPoints)}`,
        hint: `${it.label}: ${int(it.avgPoints)} pts/win (${int(it.avgDice)} from dice + ${int(it.avgBonus)} bonus/mult), ${pct(it.shareOfWinPoints)} of all winning points`,
      }));
      return `<div class="unlock-card">${head}${hbars(rows, seriesVar(i))}</div>`;
    })
    .join("");
  return (
    `<section><h2>Points by item (winning runs)</h2>` +
    `<p class="note">Among runs that won, the average points each item contributed per win, ranked. Points from an item's dice (base rolling points over their lifespan) and its own bonus/multiplier payouts are combined; hover a bar for the split. Each item's share of all points earned across winning runs is shown after the “·”. Copies are credited to the item that spawned them.</p>` +
    `<div class="unlock-grid">${cards}</div></section>`
  );
}

function unlockSection(stats: StrategyStats[]): string {
  const gated = stats[0].items.filter((it) => it.gated);
  const cards = stats
    .map((s, i) => {
      const rows = s.items
        .filter((it) => it.gated)
        .map((it) => ({
          label: it.name,
          value: it.unlockRate,
          display:
            it.unlockRate > 0
              ? `${pct(it.unlockRate)}${it.medianUnlockTrial != null ? ` · r${it.medianUnlockTrial}` : ""}`
              : "0%",
          hint: `${it.name}: unlocked in ${pct(it.unlockRate)} of runs${it.medianUnlockTrial != null ? `, median round ${it.medianUnlockTrial}` : ""}`,
        }))
        .sort((a, b) => b.value - a.value);
      return `<div class="unlock-card"><div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(strategyLabel(s.name))}</div>${hbars(rows, seriesVar(i))}</div>`;
    })
    .join("");
  return (
    `<section><h2>Unlock likelihood</h2>` +
    `<p class="note">Share of runs whose play satisfied each gated item's unlock criterion, and the median round it first happened (r#). Items near 0% are effectively unreachable for that play style. Measured for all ${gated.length} gated items regardless of the configured shop pool.</p>` +
    `<div class="unlock-grid">${cards}</div></section>`
  );
}

// ---- page ------------------------------------------------------------------

export function buildReport(stats: BatchStats): string {
  const ordered = STRATEGY_ORDER.map((name) =>
    stats.strategies.find((s) => s.name === name),
  ).filter((s): s is StrategyStats => !!s);

  const pools = stats.unlockPools
    .map((pool) => `${pool.name}: ${pool.gatedItems} gated`)
    .join(" · ");
  const meta = `${int(stats.runsPerStrategy)} runs/series · seed ${stats.seed} · ${pools} · ${new Date(stats.generatedAt).toLocaleString()}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>The Order of Order — Balance Report</title>
<style>
:root{color-scheme:light;
  --plane:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#77736b; --series-2:#2a78d6; --series-3:#72a9e6;
  --series-4:#008300; --series-5:#70b96b; --series-6:#b8791f;
  --series-7:#c2410c; --series-8:#7c3aed; --series-9:#be185d;}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
  --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#a29e95; --series-2:#3987e5; --series-3:#86b9ef;
  --series-4:#26a641; --series-5:#78c876; --series-6:#d99b3d;
  --series-7:#f0714a; --series-8:#a78bfa; --series-9:#f472b6;}}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;padding:32px 20px 80px}
.wrap{max-width:920px;margin:0 auto}
h1{font-size:26px;margin:0 0 4px} h2{font-size:18px;margin:0 0 6px}
.sub{color:var(--ink2);font-size:13px;margin:0 0 28px}
section{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin:0 0 20px}
.note{color:var(--ink2);font-size:13px;margin:0 0 12px;max-width:70ch}
.chart{width:100%;height:auto;display:block;overflow:visible}
.grid{stroke:var(--grid);stroke-width:1}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:16px;margin:0 0 10px;font-size:13px;color:var(--ink2)}
.lg{display:inline-flex;align-items:center;gap:6px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.tile{border:1px solid var(--border);border-radius:10px;padding:14px}
.tile-strat{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;margin-bottom:10px}
.tile-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 8px}
.tile-grid div{display:flex;flex-direction:column}
.big{font-size:22px;font-weight:650} .cap{font-size:11px;color:var(--muted)}
.tablewrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:5px 9px;text-align:left;border-bottom:1px solid var(--grid);white-space:nowrap}
th{color:var(--ink2);font-weight:600} th.grp{text-align:center;border-bottom:1px solid var(--border)}
td.num,.num{text-align:right;font-variant-numeric:tabular-nums}
.gated{font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 4px;margin-left:4px}
.unlock-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.unlock-card .tile-strat{margin-bottom:8px}
.hbars{display:flex;flex-direction:column;gap:3px}
.hbar-row{display:grid;grid-template-columns:120px 1fr 76px;align-items:center;gap:8px;font-size:12px}
.hbar-label{color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hbar-track{background:var(--grid);border-radius:3px;height:9px;overflow:hidden}
.hbar-fill{display:block;height:100%;border-radius:3px}
.hbar-val{text-align:right;color:var(--ink2);font-variant-numeric:tabular-nums}
</style></head>
<body><div class="wrap">
<h1>The Order of Order — Balance Report</h1>
<p class="sub">${esc(meta)}</p>
<section><h2>Strategy summary</h2>
<p class="note">Greedy and thrifty bracket how far a purse stretches — most expensive first versus cheapest first — and are each shown with only base items available and with every gated item unlocked, using the same seed stream. The five themed shoppers each chase one build archetype with the full pool, so their spread shows whether every archetype is viable.</p>
${summaryTiles(ordered)}</section>
${histogramSection(ordered, stats.trialsPerRank)}
${survivalSection(ordered)}
${curveSection(ordered)}
${rollPacingSection(ordered)}
${bossSection(ordered)}
${goldSection(ordered)}
${itemPointsSection(ordered)}
${itemTableSection(ordered)}
${unlockSection(ordered)}
</div></body></html>`;
}
