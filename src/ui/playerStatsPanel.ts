import Phaser from "phaser";
import type { PlayerStats, StatsMetric } from "../systems/PlayerStats";
import { formatCompactCount, formatScore } from "./formatScore";
import {
  buildRunCurveChart,
  curveAxisIsLog,
  runCurveChartHeight,
  type RunCurveChart,
  type RunCurveSeries,
} from "./runCurveChart";
import { buildStatBadges } from "./statBadges";

/**
 * The Codex's Stats tab: the player's lifetime record as a row of plates, then
 * their ten best runs charted three ways — points, dice and gold.
 *
 * Built into one container in local coordinates and taller than any viewport it
 * is likely to be read on, so the caller hangs it off a scrolling track. It
 * borrows both of its parts from the item analysis screen, which is the same
 * reading in the small: badges over a best-ten chart.
 */

/** The three charts, in the order they are stacked. */
const CHARTS: { metric: StatsMetric; title: string; log: boolean }[] = [
  // `log` forces the compressed axis: points climb by orders of magnitude
  // within a single run whatever these ten happened to reach. Dice and gold stay
  // countable, so they are left to be judged on their own peak.
  { metric: "score", title: "Best runs by points", log: true },
  { metric: "dice", title: "Best runs by dice", log: false },
  { metric: "gold", title: "Best runs by gold earned", log: false },
];

/** Air between the badge grid and the first chart, and between charts. */
const SECTION_GAP = 18;
const CHART_GAP = 16;
/** The plot's own height, before the title line and the key are added. */
const MIN_PLOT_H = 104;
const MAX_PLOT_H = 190;
/** Widest the column gets. Past this the charts stop reading as charts and
 *  start reading as rules ruled across the table. */
const MAX_CONTENT_W = 900;
/** Badges on the grid, and the most of the band they may take between them. */
const BADGE_COUNT = 10;
const BADGE_BAND_SHARE = 0.42;

export interface PlayerStatsPanelOptions {
  /** Top-left of the band the panel is read through, in scene coordinates. */
  x: number;
  y: number;
  width: number;
  /** The band's height — what the panel sizes its plots against, not the height
   *  it takes. */
  height: number;
  stats: PlayerStats;
}

export interface PlayerStatsPanel {
  container: Phaser.GameObjects.Container;
  /** How tall the content actually is. Taller than the band means it scrolls. */
  height: number;
  /** Play every chart's left-to-right reveal. */
  reveal(): void;
}

/** Badges across, chosen so a plate never gets too narrow to print its caption. */
function badgeColumns(width: number): number {
  if (width >= 720) return 5;
  if (width >= 520) return 4;
  if (width >= 330) return 3;
  return 2;
}

export function buildPlayerStatsPanel(
  scene: Phaser.Scene,
  opts: PlayerStatsPanelOptions,
): PlayerStatsPanel {
  const { stats } = opts;
  const width = Math.min(opts.width, MAX_CONTENT_W);
  // Centre the column when the band is wider than the panel wants to be.
  const inset = (opts.width - width) / 2;
  const container = scene.add.container(opts.x + inset, opts.y);

  const winRate = stats.runs
    ? `${Math.round((stats.wins / stats.runs) * 100)}%`
    : "—";
  const cols = badgeColumns(width);
  // Plates are sized off their own width, then capped so the record never takes
  // more than its share of the band — on a short landscape viewport four rows of
  // full-height plates would leave the first chart a sliver.
  const badgeRows = Math.ceil(BADGE_COUNT / cols);
  const badgeH = Phaser.Math.Clamp(
    Math.min(
      width / cols / 1.9,
      (opts.height * BADGE_BAND_SHARE - (badgeRows - 1) * 6) / badgeRows,
    ),
    30,
    58,
  );
  const badges = buildStatBadges(scene, {
    x: 0,
    y: 0,
    width,
    cols,
    height: badgeH,
    badges: [
      { label: "Games played", value: formatCompactCount(stats.runs) },
      { label: "Runs won", value: formatCompactCount(stats.wins) },
      { label: "Win rate", value: winRate },
      { label: "Gold earned", value: formatCompactCount(stats.goldEarned) },
      { label: "Gold spent", value: formatCompactCount(stats.goldSpent) },
      {
        label: "Cards purchased",
        value: formatCompactCount(stats.cardsPurchased),
      },
      { label: "Ones rolled", value: formatCompactCount(stats.onesRolled) },
      { label: "Points earned", value: formatScore(stats.points) },
      {
        label: "Dice collected",
        value: formatCompactCount(stats.diceCollected),
      },
      { label: "Rolls made", value: formatCompactCount(stats.rolls) },
    ],
  });
  container.add(badges.container);

  // Three plots share whatever the band has left under the badges, but never so
  // little that a curve becomes a scribble: below that they simply overflow and
  // the track scrolls.
  const room = (opts.height - badges.height - SECTION_GAP - CHART_GAP * 2) / 3;
  const plotH = Phaser.Math.Clamp(room - 60, MIN_PLOT_H, MAX_PLOT_H);

  const charts: RunCurveChart[] = [];
  let y = badges.height + SECTION_GAP;
  for (const spec of CHARTS) {
    const curves = stats.best[spec.metric];
    const maxRolls = Math.max(1, ...curves.map((curve) => curve.rolls));
    const series: RunCurveSeries[] = curves.map((curve, index) => ({
      id: `${spec.metric}:${curve.startedAt}`,
      label: `#${index + 1} ${curve.won ? "W" : "L"} · ${formatCompactCount(curve.final)}`,
      values: curve.values,
      span: curve.rolls > 0 ? curve.rolls / maxRolls : 1,
    }));
    // Settled here rather than left to the chart, so the caption cannot name a
    // scale the plot isn't drawn on.
    const logarithmic = curveAxisIsLog(series, spec.log);
    const height = runCurveChartHeight(plotH, curves.length, width);
    const chart = buildRunCurveChart(scene, {
      x: 0,
      y,
      width,
      height,
      title: spec.title,
      caption:
        curves.length === 0
          ? undefined
          : `${formatCompactCount(maxRolls)} rolls · ${
              logarithmic ? "log" : "linear"
            } scale`,
      logarithmic,
      series,
      emptyText: "No completed runs yet",
    });
    container.add(chart.container);
    charts.push(chart);
    y += height + CHART_GAP;
  }

  return {
    container,
    height: y - CHART_GAP,
    reveal: () => {
      for (const chart of charts) chart.reveal();
    },
  };
}
