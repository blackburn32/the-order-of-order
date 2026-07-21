// Renders a BatchStats into one self-contained HTML file (inline CSS + inline
// SVG, no network). Palette and conventions follow the dataviz method: fixed
// categorical series colors, one axis per chart, a legend for multi-series, thin
// marks with rounded data-ends, native <title> hover tooltips, and a selected
// dark mode (not an auto-flip). Detail-heavy per-item numbers live in tables.

import { BatchStats, ItemStat, StrategyStats } from './stats';
import { StrategyName } from './bot';

// Series colors are the dataviz reference palette's first three categorical
// slots (blue / green / magenta), defined once as CSS vars --series-1..3 in the
// page's <style> (light + dark) and referenced by role via seriesVar().
const STRATEGY_ORDER: StrategyName[] = ['noBuy', 'random', 'greedy'];
const STRATEGY_LABEL: Record<StrategyName, string> = {
  noBuy: 'No-buy (baseline)',
  random: 'Random',
  greedy: 'Greedy (expensive-first)'
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const n1 = (x: number) => x.toFixed(1);
const int = (x: number) => Math.round(x).toLocaleString();
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function seriesVar(i: number): string {
  return `var(--series-${i + 1})`;
}

// ---- SVG chart builders ----------------------------------------------------

/** Grouped vertical bars: one group per category, one bar per series. */
function groupedBars(
  categories: string[],
  series: { name: string; color: string; values: number[] }[],
  opts: { width?: number; height?: number; yLabel?: string; fmt?: (v: number) => string } = {}
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
      return `<line x1="${m.left}" y1="${gy}" x2="${W - m.right}" y2="${gy}" class="grid"/>` +
        `<text x="${m.left - 6}" y="${gy + 3}" class="tick" text-anchor="end">${fmt(t * max)}</text>`;
    })
    .join('');

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
        .join('');
      const label = `<text x="${(gx + (barW * series.length) / 2).toFixed(1)}" y="${H - m.bottom + 16}" class="tick" text-anchor="middle">${esc(cat)}</text>`;
      return inner + label;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${bars}</svg>`;
}

/** Multi-series line chart with an optional log-y scale and a dashed reference line. */
function lineChart(
  xs: number[],
  series: { name: string; color: string; points: { x: number; y: number }[]; dashed?: boolean }[],
  opts: { width?: number; height?: number; log?: boolean; fmt?: (v: number) => string; xLabel?: string } = {}
): string {
  const W = opts.width ?? 720;
  const H = opts.height ?? 300;
  const m = { top: 14, right: 14, bottom: 32, left: 52 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const fmt = opts.fmt ?? ((v) => int(v));
  const allY = series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v > 0);
  const rawMax = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const log = opts.log ?? false;
  const yMin = log ? Math.max(0.5, Math.min(...allY, 1)) : 0;
  const yMax = rawMax;
  const sx = (x: number) => m.left + ((x - xMin) / Math.max(1, xMax - xMin)) * iw;
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
    ? [1, 10, 100, 1000, 10000, 100000, 1000000].filter((v) => v >= yMin * 0.9 && v <= yMax * 1.1)
    : [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);
  const grid = yTicks
    .map((v) => {
      const gy = sy(v);
      return `<line x1="${m.left}" y1="${gy}" x2="${W - m.right}" y2="${gy}" class="grid"/>` +
        `<text x="${m.left - 6}" y="${gy + 3}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`;
    })
    .join('');

  const xTicks = xs
    .map((x) => `<text x="${sx(x)}" y="${H - m.bottom + 16}" class="tick" text-anchor="middle">${x}</text>`)
    .join('');

  const paths = series
    .map((s) => {
      if (!s.points.length) return '';
      const d = s.points
        .map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`)
        .join(' ');
      const dots = s.points
        .map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.name)} · round ${p.x}: ${esc(fmt(p.y))}</title></circle>`)
        .join('');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="5 4"' : ''}/>${dots}`;
    })
    .join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img">${grid}${xTicks}${paths}</svg>`;
}

/** Horizontal bars, sorted by value desc. Each row: label + bar + display value. */
function hbars(rows: { label: string; value: number; display: string; hint?: string }[], color: string): string {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows
    .map((r) => {
      const w = (r.value / max) * 100;
      return `<div class="hbar-row" title="${esc(r.hint ?? r.label)}"><span class="hbar-label">${esc(r.label)}</span>` +
        `<span class="hbar-track"><span class="hbar-fill" style="width:${w.toFixed(1)}%;background:${color}"></span></span>` +
        `<span class="hbar-val">${esc(r.display)}</span></div>`;
    })
    .join('')}</div>`;
}

function legend(stats: StrategyStats[]): string {
  return `<div class="legend">${stats
    .map((s, i) => `<span class="lg"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(STRATEGY_LABEL[s.name])}</span>`)
    .join('')}</div>`;
}

// ---- sections --------------------------------------------------------------

function summaryTiles(stats: StrategyStats[]): string {
  return `<div class="tiles">${stats
    .map(
      (s, i) => `<div class="tile"><div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(STRATEGY_LABEL[s.name])}</div>` +
        `<div class="tile-grid">` +
        `<div><span class="big">${pct(s.winRate)}</span><span class="cap">win rate</span></div>` +
        `<div><span class="big">${n1(s.round.median)}</span><span class="cap">median round</span></div>` +
        `<div><span class="big">${int(s.score.median)}</span><span class="cap">median score</span></div>` +
        `<div><span class="big">${int(s.finalDice.median)}</span><span class="cap">median dice</span></div>` +
        `</div></div>`
    )
    .join('')}</div>`;
}

function histogramSection(stats: StrategyStats[]): string {
  const rounds = stats[0].round.histogram.map((_, i) => String(i + 1));
  const series = stats.map((s, i) => ({ name: STRATEGY_LABEL[s.name], color: seriesVar(i), values: s.round.histogram }));
  return `<section><h2>Where runs end</h2>` +
    `<p class="note">Number of runs that ended on each round (the round they died, or ${stats[0]?.round.histogram.length ?? 20} = cleared all rounds / victory). Tall early bars mark a difficulty wall.</p>` +
    legend(stats) +
    groupedBars(rounds, series, { fmt: (v) => int(v) }) +
    `</section>`;
}

function curveSection(stats: StrategyStats[]): string {
  const maxRound = Math.max(...stats.flatMap((s) => s.roundCurve.map((p) => p.round)), 1);
  const xs = Array.from({ length: maxRound }, (_, i) => i + 1);
  const target = stats[0]
    ? { name: 'Round target', color: 'var(--muted)', dashed: true, points: xs.map((x) => ({ x, y: roundTargetFrom(stats, x) })) }
    : { name: 'target', color: 'var(--muted)', points: [] };
  const series = [
    ...stats.map((s, i) => ({
      name: STRATEGY_LABEL[s.name],
      color: seriesVar(i),
      points: s.roundCurve.map((p) => ({ x: p.round, y: Math.max(1, p.medianRoundScore) }))
    })),
    target
  ];
  return `<section><h2>Peak score vs. target, by round</h2>` +
    `<p class="note">Median peak score reached each round (log scale) against the survival target (dashed). Where a strategy's line dips toward the target, runs are scraping by; where it crosses below, they die. The target grows 1.85×/round.</p>` +
    legend(stats) +
    lineChart(xs, series, { log: true, fmt: (v) => int(v) }) +
    `</section>`;
}

function roundTargetFrom(stats: StrategyStats[], round: number): number {
  for (const s of stats) {
    const p = s.roundCurve.find((c) => c.round === round);
    if (p) return p.target;
  }
  return 0;
}

function itemTableSection(stats: StrategyStats[]): string {
  const rarityRank: Record<string, number> = { common: 0, uncommon: 1, rare: 2 };
  const base = stats[0].items
    .slice()
    .sort((a, b) => rarityRank[a.rarity] - rarityRank[b.rarity] || a.cost - b.cost || a.name.localeCompare(b.name));

  const byStrat = new Map<StrategyName, Map<string, ItemStat>>();
  for (const s of stats) byStrat.set(s.name, new Map(s.items.map((it) => [it.id, it])));

  const head = `<tr><th>Item</th><th>Cost</th><th>Rarity</th>` +
    stats.map((s) => `<th class="grp" colspan="2">${esc(STRATEGY_LABEL[s.name])}</th>`).join('') +
    `</tr><tr><th></th><th></th><th></th>` +
    stats.map(() => `<th>buy%</th><th>win% if bought</th>`).join('') +
    `</tr>`;

  const rows = base
    .map((it) => {
      const cells = stats
        .map((s) => {
          const st = byStrat.get(s.name)!.get(it.id)!;
          const buy = st.buyRate > 0 ? pct(st.buyRate) : '—';
          const win = st.buyRuns > 0 ? pct(st.winRateIfBought) : '—';
          return `<td class="num">${buy}</td><td class="num">${win}</td>`;
        })
        .join('');
      return `<tr><td>${esc(it.name)}${it.gated ? ' <span class="gated">gated</span>' : ''}</td><td class="num">${it.cost}</td><td>${it.rarity}</td>${cells}</tr>`;
    })
    .join('');

  return `<section><h2>Item purchase &amp; win correlation</h2>` +
    `<p class="note">Per strategy: how often each offered item was bought when it appeared, and the win rate of runs that bought it (selection bias — a strong item and a strong run correlate; read alongside the baseline).</p>` +
    `<div class="tablewrap"><table>${head}${rows}</table></div></section>`;
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
          display: it.unlockRate > 0 ? `${pct(it.unlockRate)}${it.medianUnlockRound != null ? ` · r${it.medianUnlockRound}` : ''}` : '0%',
          hint: `${it.name}: unlocked in ${pct(it.unlockRate)} of runs${it.medianUnlockRound != null ? `, median round ${it.medianUnlockRound}` : ''}`
        }))
        .sort((a, b) => b.value - a.value);
      return `<div class="unlock-card"><div class="tile-strat"><span class="sw" style="background:${seriesVar(i)}"></span>${esc(STRATEGY_LABEL[s.name])}</div>${hbars(rows, seriesVar(i))}</div>`;
    })
    .join('');
  return `<section><h2>Unlock likelihood</h2>` +
    `<p class="note">Share of runs whose play satisfied each gated item's unlock criterion, and the median round it first happened (r#). Items near 0% are effectively unreachable for that play style. Measured for all ${gated.length} gated items regardless of the configured shop pool.</p>` +
    `<div class="unlock-grid">${cards}</div></section>`;
}

// ---- page ------------------------------------------------------------------

export function buildReport(stats: BatchStats): string {
  const ordered = STRATEGY_ORDER
    .map((name) => stats.strategies.find((s) => s.name === name))
    .filter((s): s is StrategyStats => !!s);

  const meta = `${int(stats.runsPerStrategy)} runs/strategy · seed ${stats.seed} · ${stats.unlockedAtStart.length} gated items unlocked in pool · dice cap ${int(stats.maxDice)} · ${new Date(stats.generatedAt).toLocaleString()}`;
  const capNote = ordered.some((s) => s.diceCapHitRate > 0)
    ? `<p class="note">Dice cap (${int(stats.maxDice)}) hit by ${ordered
        .map((s) => `${pct(s.diceCapHitRate)} of ${STRATEGY_LABEL[s.name].toLowerCase()}`)
        .join(', ')} runs — those already overshoot the target by 100×+, so the cap does not change win/loss or round reached.</p>`
    : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>The Order of Order — Balance Report</title>
<style>
:root{color-scheme:light;
  --plane:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,.10);
  --series-1:#2a78d6; --series-2:#008300; --series-3:#e87ba4;}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;
  --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,.10);
  --series-1:#3987e5; --series-2:#008300; --series-3:#d55181;}}
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
<p class="note">Three shopping strategies compared over identical run counts. No-buy is the raw survival floor; random and greedy show how much shopping moves the needle.</p>
${summaryTiles(ordered)}${capNote}</section>
${histogramSection(ordered)}
${curveSection(ordered)}
${itemTableSection(ordered)}
${unlockSection(ordered)}
</div></body></html>`;
}
