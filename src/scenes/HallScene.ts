import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { HallEntry, loadHall } from "../systems/SaveData";
import { CHARACTERS } from "../systems/Characters";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import { addCamera, setCameraViewport } from "../ui/camera";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import {
  compactColumns,
  destroyAllChildren,
  isCompactLandscape,
  onResizeCoalesced,
} from "../ui/layout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import {
  fetchTopScores,
  globalScoresEnabled,
  GlobalScoreRow,
  fetchRunAnalysis,
  type GlobalRunAnalysis,
} from "../systems/GlobalScores";
import { toNumberPointMap } from "../systems/ItemPoints";
import { formatSci, formatScore } from "../ui/formatScore";
import { DieTooltip } from "../ui/dieTooltip";
import { vigilGroups } from "../ui/vigilTally";
import type { DiceStack } from "../systems/DicePool";
import { dieBodyTexture } from "../art/textures";
import {
  dieEffects,
  dieEffectsKey,
  type DieEffect,
} from "../systems/DieEffects";

type PointerHandler = (pointer: Phaser.Input.Pointer) => void;
type WheelHandler = (
  pointer: Phaser.Input.Pointer,
  over: unknown,
  dx: number,
  dy: number,
  dz: number,
) => void;

type Tab = "local" | "global";
type GlobalStatus = "idle" | "loading" | "error" | "disabled" | "ready";

/** Fixed sigil brightness for the backdrop — no trial to report here, so the
 *  value is chosen purely for how it looks (see MenuScene). */
const HALL_AMBIENCE = 0.65;

/** Zebra banding for the score rows. Faint enough that it reads as ruling on
 *  the table rather than as a row of plates laid on it. */
const BAND_ALPHA = 0.3;

/** Shortest a score row may get before the list scrolls instead: a finger's
 *  height, and enough that a row's type never runs into the next row's. */
const MIN_ROW_STEP = 28;

/** Strip under a list reserved for its hint line. */
const HINT_RESERVE = 22;
/** The most kinds of die a final grid lists before it folds the smallest into
 *  an ellipsis, and how many it keeps when it does — one fewer, so the
 *  ellipsis takes the last slot rather than widening the row. */
const GRID_LIST_MAX_KINDS = 5;
const GRID_LIST_SHOWN_WHEN_CROWDED = 4;
/** Past this many kinds, a final grid's counts go to scientific notation. */
const GRID_LIST_PLAIN_MAX_KINDS = 3;

/** A scene-space rectangle a tab lays its table out in. */
interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The Hall of High Scores. Two tabs: the player's local runs (drawn from
 * localStorage) and the worldwide top-100 fetched from the leaderboard Worker
 * (see worker/ and systems/GlobalScores). The selected
 * tab and the fetched global rows live in instance fields so they survive the
 * wipe-and-rebuild that runs on every resize / tab switch. The global list can
 * overflow the screen, so — like the Codex — its rows live in a `track`
 * container clipped by a dedicated camera and scrolled by drag/wheel.
 *
 * The scores are set straight on the felt, under the same masthead and turning
 * sigil the menu and the trial screens use, rather than on a parchment panel.
 */
export class HallScene extends Phaser.Scene {
  private tab: Tab = "local";
  private globalRows: GlobalScoreRow[] | null = null;
  private globalStatus: GlobalStatus = "idle";
  // Global analyses are fetched one row at a time, on tap, and kept for the
  // life of the scene: they are a few tens of KB each and a player comparing
  // the top of the board will open the same handful repeatedly.
  private analysisCache = new Map<string, GlobalRunAnalysis>();
  private analysisPending: string | null = null;
  /** Replaces the list's hint line while a fetch is in flight or after one
   *  failed, so a tap that goes nowhere still says something. Survives the
   *  rebuild-on-resize; `globalHint` is the live text object it is written to,
   *  and `globalHintBase` the standing hint it temporarily displaces. */
  private globalNotice = "";
  private globalHint?: Phaser.GameObjects.Text;
  private globalHintBase = "";
  private gridCamera?: Phaser.Cameras.Scene2D.Camera;
  // The felt, the sigil and the masthead's halo — the room the scores are laid
  // out in. Held still while the scores themselves slide on and off.
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private leaving = false;
  private input$?: {
    down: PointerHandler;
    move: PointerHandler;
    up: PointerHandler;
    wheel: WheelHandler;
  };

  /** Spells out a final grid's die while the pointer is over it. */
  private dieTooltip!: DieTooltip;

  constructor() {
    super("Hall");
  }

  create(): void {
    this.dieTooltip = new DieTooltip(this);
    this.tab = "local";
    this.globalRows = null;
    this.globalStatus = "idle";
    this.analysisCache.clear();
    this.analysisPending = null;
    this.globalNotice = "";
    this.gridCamera = undefined;
    this.leaving = false;
    this.build();
    slideSceneIn(this, this.slideBackdrop);

    const off = onResizeCoalesced(this, () => this.rebuild());
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      off();
      this.teardownInput();
      this.input.setDefaultCursor("default");
    });
  }

  private rebuild(): void {
    this.teardownInput();
    // Dropped before the children are destroyed: an in-flight analysis fetch
    // resolving after a resize must not write into a dead text object.
    this.globalHint = undefined;
    if (this.gridCamera) {
      this.cameras.remove(this.gridCamera, true);
      this.gridCamera = undefined;
    }
    destroyAllChildren(this);
    this.build();
  }

  private teardownInput(): void {
    if (this.input$) {
      this.input.off("pointerdown", this.input$.down);
      this.input.off("pointermove", this.input$.move);
      this.input.off("pointerup", this.input$.up);
      this.input.off("pointerupoutside", this.input$.up);
      this.input.off("wheel", this.input$.wheel);
      this.input$ = undefined;
    }
  }

  private build(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    const felt = addFelt(this);
    const ambient = new AmbientLayer(this, { ring: true });
    ambient.setPosition(cx, H / 2);
    ambient.setArea(W, H);
    ambient.setProgress(HALL_AMBIENCE, false);

    // Stacked, the masthead, the tabs, the table and the Return button share
    // the height four ways — on a handset held in landscape that left the
    // table a band about three rows tall, and the local rows spilled down
    // through the button. Folded, the chrome takes a column of its own and the
    // table gets the full height beside it: the same fold Inventory and the
    // Codex make, on the one `isCompactLandscape` gate.
    const compact = isCompactLandscape(W, H);
    const columns = compactColumns(this, { leftFraction: 0.34 });

    // A column is too narrow to hold the title on one line at a readable size,
    // so folded it is set as a two-line masthead instead of shrunk.
    const header = buildSceneHeader(this, {
      title: compact ? "Hall of\nHigh Scores" : "Hall of High Scores",
      y: compact ? columns.top + 40 : Math.max(44, Math.min(H * 0.13, 96)),
      width: compact ? columns.left.width : Math.min(W, 760),
      ...(compact ? { x: columns.left.cx } : {}),
    });
    header.title.setAlign("center");
    this.slideBackdrop = [felt, ambient, header.glow];

    const tableW = compact ? columns.right.width : Math.min(W - 36, 900);

    // The tabs head the table when stacked, and the chrome column when folded.
    const tabsY = header.bottom + (compact || H < 600 ? 20 : 28);
    this.buildTabs(
      compact ? columns.left.cx : cx,
      tabsY,
      compact ? columns.left.width : tableW,
    );

    // The Return button is created before the (camera-clipped) content so it is
    // part of the "everything except the scroll track" set the grid camera
    // ignores.
    const leave = () => this.leave(() => this.scene.start("Menu"));
    let area: Area;
    if (compact) {
      // Folded there is no full-width strip along the bottom, so the button
      // closes the chrome column instead: sized to what is left under the
      // tabs, then set down on the column's foot the way the Codex's is.
      const bandTop = tabsY + 30;
      const back = bannerButton(
        this,
        columns.left.cx,
        0,
        "Return to the Vestibule",
        leave,
        columns.left.width,
        columns.bottom - bandTop,
      );
      back.setY(columns.bottom - back.height / 2);
      area = {
        x: columns.right.x,
        y: columns.top,
        width: columns.right.width,
        height: columns.height,
      };
    } else {
      const buttonY = H - 46;
      bannerButton(
        this,
        cx,
        buttonY,
        "Return to the Vestibule",
        leave,
        Math.min(tableW, 340),
      );
      const top = tabsY + 30;
      area = {
        x: cx - tableW / 2,
        y: top,
        width: tableW,
        height: Math.max(80, buttonY - 44 - top),
      };
    }

    if (this.tab === "local") {
      this.buildLocal(area);
    } else {
      this.buildGlobal(area);
    }
  }

  /** Two text tabs sharing one baseline, the selected one gold over a short
   *  gold rule. Parchment buttons were doing this job before, which put two
   *  more slabs of chrome between the masthead and the scores. */
  private buildTabs(cx: number, y: number, tableW: number): void {
    const size = Math.round(Phaser.Math.Clamp(tableW * 0.028, 17, 22));
    // The gap closes up as the room narrows, so the folded column's pair
    // doesn't spend a third of its width on air.
    const gap = Math.min(Math.max(28, tableW * 0.06), tableW * 0.12);

    const make = (label: string, tab: Tab): Phaser.GameObjects.Text => {
      const active = this.tab === tab;
      const text = this.add
        .text(0, y, label, {
          fontFamily: SERIF,
          fontSize: `${size}px`,
          color: active ? CSS.gold : CSS.dim,
          fontStyle: active ? "bold" : "normal",
          letterSpacing: 2,
        })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true });
      text.on("pointerover", () =>
        text.setColor(active ? CSS.goldLight : CSS.parchment),
      );
      text.on("pointerout", () => text.setColor(active ? CSS.gold : CSS.dim));
      text.on("pointerdown", () => this.switchTab(tab));
      return text;
    };

    const local = make("MY RUNS", "local");
    const global = make("GLOBAL", "global");
    // Share any shrinkage in proportion, so neither label crowds the other.
    const room = Math.max(1, tableW - gap);
    const naturalW = local.width + global.width;
    if (naturalW > room) {
      fitTextWidth(local, (room * local.width) / naturalW);
      fitTextWidth(global, (room * global.width) / naturalW);
    }
    const totalW = local.width + gap + global.width;
    local.setX(cx - totalW / 2 + local.width / 2);
    global.setX(cx + totalW / 2 - global.width / 2);

    const active = this.tab === "local" ? local : global;
    const underline = this.add.graphics();
    underline.lineStyle(2, COLORS.gold, 0.75);
    underline.lineBetween(
      active.x - active.width / 2 - 6,
      y + size * 0.85,
      active.x + active.width / 2 + 6,
      y + size * 0.85,
    );
  }

  private switchTab(tab: Tab): void {
    if (tab === this.tab) return;
    // Retry the fetch when (re)entering Global if we've never loaded or errored.
    if (
      tab === "global" &&
      (this.globalStatus === "idle" || this.globalStatus === "error")
    ) {
      this.loadGlobal();
    }
    // A stale "could not be read" from an earlier tap shouldn't greet the
    // player when they come back to the tab.
    this.globalNotice = "";
    this.tab = tab;
    this.rebuild();
  }

  private loadGlobal(): void {
    if (!globalScoresEnabled()) {
      this.globalStatus = "disabled";
      return;
    }
    this.globalStatus = "loading";
    fetchTopScores().then((rows) => {
      if (!this.scene.isActive()) return; // scene left while in flight
      if (rows === null) {
        this.globalStatus = "error";
      } else {
        this.globalRows = rows;
        this.globalStatus = "ready";
      }
      if (this.tab === "global") this.rebuild();
    });
  }

  // --- Local tab ------------------------------------------------------------

  private buildLocal(area: Area): void {
    const entries = loadHall();
    const cx = area.x + area.width / 2;

    if (entries.length === 0) {
      this.centerMessage(
        cx,
        area.y + area.height * 0.32,
        "No initiates have been recorded.\nBegin a run and earn your place.",
        area.width,
      );
      return;
    }

    const headerSize = Math.round(
      Phaser.Math.Clamp(area.width * 0.032, 11, 16),
    );
    const cellSize = Math.round(Phaser.Math.Clamp(area.width * 0.045, 13, 20));
    const colGap = Math.max(10, area.width * 0.02);
    // Die icons are sized off the type rather than off the row: the row height
    // is now whatever the list can afford, and the dice shouldn't swell or
    // shrink with it.
    const iconSize = Math.round(Phaser.Math.Clamp(cellSize * 1.15, 12, 24));
    const countSize = Math.floor(Phaser.Math.Clamp(cellSize * 0.72, 9, 14));

    // The table hangs off the top of the band, the same way the global tab's
    // fixed header does — switching tabs shouldn't shift the column heads.
    const headerY = area.y + 8;
    const ruleY = headerY + headerSize;
    const listTop = ruleY + 2;
    const listH = Math.max(
      MIN_ROW_STEP,
      area.y + area.height - HINT_RESERVE - listTop,
    );

    // The rows live in a track the list camera clips and scrolls (see
    // `mountList`). It sits at x = 0, so the columns below are placed in scene
    // coordinates and only their y is track-local.
    const track = this.add.container(0, 0);
    // Claimed now, filled once the columns have been measured: a container
    // keeps the display-list slot it was created in, so banding drawn into it
    // later still ends up beneath every glyph and die icon.
    const bands = this.add.container(0, 0);
    track.add(bands);

    // Every column is built at x = 0 and positioned only once all of them have
    // been measured. DATE/RANK/SCORE then can't collide whatever the font size,
    // locale date format, or digit count — and the block can be centred on the
    // width it actually occupies rather than on a guess.
    const dateHead = this.header(headerY, "DATE", headerSize);
    const rankHead = this.header(headerY, "RANK", headerSize);
    const scoreHead = this.header(headerY, "SCORE", headerSize);

    const rows = entries.map((entry) => {
      const date = new Date(entry.startedAt).toLocaleDateString(undefined, {
        year: "2-digit",
        month: "numeric",
        day: "numeric",
      });
      const row = {
        entry,
        date: this.cell(0, date, cellSize),
        // Rank is the ranking key now, so it reads as "rank-trial" — the same
        // shorthand the in-game HUD uses.
        rank: this.cell(0, `${entry.rank}-${entry.trial}`, cellSize),
        score: this.cell(0, formatScore(entry.score), cellSize),
        dice: this.buildGridList(entry, iconSize, countSize),
      };
      track.add([row.date, row.rank, row.score, row.dice.container]);
      return row;
    });

    const widest = (texts: Phaser.GameObjects.Text[]) =>
      Math.max(...texts.map((t) => t.width));
    const dateW = widest([dateHead, ...rows.map((r) => r.date)]);
    const rankW = widest([rankHead, ...rows.map((r) => r.rank)]);
    const scoreW = widest([scoreHead, ...rows.map((r) => r.score)]);
    // The crown and the endless mark get columns of their own rather than being
    // tucked into a margin, so neither can crowd the date or the score.
    const crownW = entries.some((e) => e.won) ? cellSize + 4 : 0;
    const markW = entries.some((e) => e.endless) ? cellSize : 0;
    const listW = Math.max(...rows.map((r) => r.dice.width));

    // Walk the text columns left to right in block-local coordinates.
    let cursor = 0;
    const crownX = cursor + crownW / 2;
    if (crownW) cursor += crownW + colGap * 0.5;
    const dateX = cursor + dateW / 2;
    cursor += dateW + colGap;
    const rankX = cursor + rankW / 2;
    cursor += rankW + colGap;
    const markRight = cursor + markW;
    if (markW) cursor += markW + 4;
    const scoreX = cursor + scoreW / 2;
    cursor += scoreW;
    const textW = cursor;

    // The final grid sits beside the figures while there is room for it at a
    // legible size. On a narrow screen the room left over would scale a long
    // grid down to specks, so there it drops to a line of its own under each
    // run's figures and takes the table's whole width.
    const maxW = area.width * 0.94;
    const gridX = textW + colGap * 1.4;
    const inline = maxW - gridX >= listW * 0.7;

    let blockW: number;
    let gridColW: number;
    let rowStep: number;
    if (inline) {
      const gridHeader = this.header(headerY, "FINAL GRID", headerSize, 0);
      gridColW = Math.max(
        60,
        Math.min(Math.max(listW, gridHeader.width), maxW - gridX),
      );
      blockW = gridX + gridColW;
      gridHeader.setX(cx - blockW / 2 + gridX);
      // The head is measured into the column, but only the dice rows are
      // scaled to it — shrink the head itself when the room ran out.
      fitTextWidth(gridHeader, gridColW);
      // Fill the band while the rows fit; past that the list scrolls rather
      // than packing rows into each other.
      const floor = Math.max(MIN_ROW_STEP, iconSize + 8, cellSize * 1.5);
      rowStep = Phaser.Math.Clamp(listH / entries.length, floor, 36);
    } else {
      gridColW = Math.min(listW, maxW);
      blockW = Math.max(textW, gridColW);
      rowStep = Math.round(cellSize * 1.3 + iconSize + 12);
    }
    const blockLeft = cx - blockW / 2;
    // Stacked, the figures line is centred on its own width, not the dice's.
    const textLeft = inline ? blockLeft : cx - textW / 2;
    // Banding and hover zones run a little past the ink on either side, the way
    // ruling on a page does.
    const bandW = Math.min(area.width * 0.98, blockW + 28);

    dateHead.setX(textLeft + dateX);
    rankHead.setX(textLeft + rankX);
    scoreHead.setX(textLeft + scoreX);

    // A hairline under the column heads — the one piece of ruling the table
    // needs to separate its head from its body.
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.35);
    rule.lineBetween(cx - bandW / 2, ruleY, cx + bandW / 2, ruleY);

    rows.forEach(({ entry, date, rank, score, dice }, i) => {
      const top = i * rowStep;
      // Inline, everything shares the row's centre line; stacked, the figures
      // take the upper line and the dice the lower.
      const textY = inline ? top + rowStep / 2 : top + 4 + cellSize * 0.65;
      const diceY = inline ? textY : textY + cellSize * 0.65 + 4 + iconSize / 2;

      if (i % 2 === 1) {
        bands.add(
          this.add.rectangle(
            cx,
            top + rowStep / 2,
            bandW,
            rowStep,
            COLORS.feltLight,
            BAND_ALPHA,
          ),
        );
      }

      date.setPosition(textLeft + dateX, textY);
      rank.setPosition(textLeft + rankX, textY);
      score.setPosition(textLeft + scoreX, textY);

      // Victorious runs get a gold crown in the left gutter (old entries predate
      // `won`, so `undefined` reads as a loss — no marker).
      if (entry.won) {
        track.add(
          this.add
            .text(textLeft + crownX, textY, "♛", {
              fontFamily: SERIF,
              fontSize: `${cellSize}px`,
              color: CSS.goldLight,
            })
            .setOrigin(0.5),
        );
      }
      // Runs that pressed on past the final rank get an infinity mark just left
      // of the score column.
      if (entry.endless) {
        track.add(
          this.add
            .text(textLeft + markRight, textY, "∞", {
              fontFamily: SERIF,
              fontSize: `${cellSize}px`,
              color: CSS.gold,
            })
            .setOrigin(1, 0.5),
        );
      }

      const scale = dice.width > gridColW ? gridColW / dice.width : 1;
      dice.container.setScale(scale);
      dice.container.setPosition(
        inline ? blockLeft + gridX : cx - (dice.width * scale) / 2,
        diceY,
      );
    });

    // Runs recorded with a points breakdown — or with the roll-by-roll
    // timeline the analysis screen charts — are tappable to open it. Older
    // entries predate both and stay inert.
    const tappable = entries.map(
      (entry) =>
        !!(entry.itemPoints && Object.keys(entry.itemPoints).length) ||
        !!(entry.dicePoints && Object.keys(entry.dicePoints).length) ||
        (entry.history?.length ?? 0) >= 2,
    );

    this.mountList({
      track,
      view: { x: cx - bandW / 2, y: listTop, width: bandW, height: listH },
      rowStep,
      count: entries.length,
      tappable: (i) => tappable[i],
      onTap: (i) => this.openAnalysisLocal(entries[i]),
      tapHint: tappable.some(Boolean)
        ? "tap a run for its points breakdown"
        : "",
      hintW: area.width,
    });
  }

  /**
   * One run's final grid: each distinct die it ended with — a size and the
   * effects it carried, shaded the way the table showed it — followed by how
   * many it held. A grid of many kinds keeps its largest few and counts the
   * rest off after an ellipsis, so one row never swamps the table. Built
   * left-anchored at x = 0 so the caller can measure the row before deciding
   * where it goes.
   */
  private buildGridList(
    entry: HallEntry,
    iconSize: number,
    countSize: number,
  ): { container: Phaser.GameObjects.Container; width: number } {
    // A saved grid can hold several stacks of one kind of die, because the
    // source that granted each is persisted too. Collapse them to what the
    // player can tell apart.
    const kinds = new Map<
      string,
      {
        sides: number;
        effects: DieEffect[];
        count: number;
        stacks: DiceStack[];
      }
    >();
    for (const stack of entry.dice) {
      const effects = dieEffects(stack, entry.auras);
      const key = `${stack.sides}|${dieEffectsKey(effects)}`;
      const kind = kinds.get(key);
      if (kind) {
        kind.count += stack.count;
        kind.stacks.push(stack);
      } else {
        kinds.set(key, {
          sides: stack.sides,
          effects,
          count: stack.count,
          stacks: [stack],
        });
      }
    }
    const all = [...kinds.values()];
    const crowded = all.length > GRID_LIST_MAX_KINDS;
    // The largest buckets are the grid's shape; the rest fold into the tail.
    const shown = crowded
      ? [...all]
          .sort((a, b) => b.count - a.count || b.sides - a.sides)
          .slice(0, GRID_LIST_SHOWN_WHEN_CROWDED)
      : all;
    shown.sort(
      (a, b) => b.sides - a.sides || a.effects.length - b.effects.length,
    );
    const extra = all
      .filter((kind) => !shown.includes(kind))
      .reduce((sum, kind) => sum + kind.count, 0);
    // A row of many kinds prints its counts in scientific form, which keeps
    // every label to a few characters however large the grid grew.
    const format = (n: number) =>
      all.length > GRID_LIST_PLAIN_MAX_KINDS ? formatSci(n) : formatScore(n);

    const itemPadding = Math.max(8, iconSize * 0.4);
    const container = this.add.container(0, 0);
    let listX = 0;

    shown.forEach(({ sides, effects, count, stacks }) => {
      // Sized rather than scaled: the die body is baked above layout
      // resolution, and a display size is the one form that normalises itself.
      const icon = this.add
        .image(
          listX + iconSize / 2,
          0,
          dieBodyTexture(this, sides, effects, false),
        )
        .setDisplaySize(iconSize, iconSize);
      const label = this.add
        .text(listX + iconSize + 3, 0, `×${format(count)}`, {
          fontFamily: SERIF,
          fontSize: `${countSize}px`,
          color: CSS.parchmentDark,
        })
        .setOrigin(0, 0.5);
      const width = iconSize + 3 + label.width;
      const hit = this.add.zone(listX + width / 2, 0, width, iconSize + 6);
      // The Vigil's tallies the run ended with, as the shop and the
      // inventory show them mid-run.
      const vigil = vigilGroups(stacks);
      this.dieTooltip.attach(hit, () => ({ sides, effects, count, vigil }));
      container.add([icon, label, hit]);
      listX += width + itemPadding;
    });

    if (extra > 0) {
      const more = this.add
        .text(listX, 0, `…+${format(extra)}`, {
          fontFamily: SERIF,
          fontSize: `${countSize}px`,
          color: CSS.dim,
        })
        .setOrigin(0, 0.5);
      container.add(more);
      listX += more.width + itemPadding;
    }

    return { container, width: Math.max(1, listX - itemPadding) };
  }

  private openAnalysisLocal(entry: HallEntry): void {
    const date = new Date(entry.startedAt).toLocaleDateString();
    this.scene.launch("Analysis", {
      returnTo: "Hall",
      // The masthead wants a short title and the detail beneath it; the run's
      // score is the headline the analysis screen prints for itself.
      title: "Run Analysis",
      subtitle: `${date} · rank ${entry.rank}-${entry.trial}${entry.won ? " · victory" : ""}`,
      dicePoints: toNumberPointMap(entry.dicePoints ?? {}),
      itemPoints: toNumberPointMap(entry.itemPoints ?? {}),
      history: entry.history,
      rolls: entry.rolls,
    });
  }

  /** Open a global row's analysis, fetching the run's blob first if this is the
   *  first tap on it. The board list itself carries only the score line — the
   *  analysis is tens of KB per run, so it is pulled on demand rather than with
   *  the hundred rows of the board. */
  private openAnalysisGlobal(row: GlobalScoreRow): void {
    const cached = this.analysisCache.get(row.memberId);
    if (cached) {
      this.launchGlobalAnalysis(row, cached);
      return;
    }
    if (this.analysisPending !== null) return; // one fetch at a time

    this.analysisPending = row.memberId;
    this.setGlobalNotice("consulting the archive…");

    void fetchRunAnalysis(row.memberId).then((analysis) => {
      if (!this.scene.isActive()) return; // scene left while in flight
      this.analysisPending = null;
      if (analysis && analysis.history.length > 0) {
        // Only a successful fetch is cached, so a failure retries on next tap.
        this.analysisCache.set(row.memberId, analysis);
        this.setGlobalNotice("");
        this.launchGlobalAnalysis(row, analysis);
      } else {
        this.setGlobalNotice("that run's analysis could not be read");
      }
    });
  }

  /** Swap the global list's hint line for a transient message (or back, with
   *  ""). Written straight onto the live text object rather than through
   *  `rebuild`, which would throw away the player's scroll position in the
   *  middle of them reading the board. */
  private setGlobalNotice(notice: string): void {
    this.globalNotice = notice;
    this.globalHint?.setText(notice || this.globalHintBase);
  }

  private launchGlobalAnalysis(
    row: GlobalScoreRow,
    analysis: GlobalRunAnalysis,
  ): void {
    this.scene.launch("Analysis", {
      returnTo: "Hall",
      title: row.name || "Global Run",
      // A global run now charts exactly what a local one does, so the subtitle
      // reads like the local one's rather than apologising for approximations.
      subtitle: `global #${row.rank} · ${CHARACTERS[row.character].name} · rank ${row.runRank}-${row.trial}${
        row.endless ? " · endless" : ""
      }`,
      dicePoints: analysis.dicePoints,
      itemPoints: analysis.itemPoints,
      history: analysis.history,
      rolls: analysis.rolls,
    });
  }

  // --- Global tab -----------------------------------------------------------

  private buildGlobal(area: Area): void {
    const cx = area.x + area.width / 2;
    const midY = area.y + area.height / 2;
    if (this.globalStatus !== "ready") {
      const msg =
        this.globalStatus === "loading"
          ? "Consulting the global hall…"
          : this.globalStatus === "disabled"
            ? "The global hall is beyond reach."
            : this.globalStatus === "error"
              ? "The global hall could not be reached.\nTap Global to try again."
              : "Consulting the global hall…";
      this.centerMessage(cx, midY, msg, area.width);
      return;
    }

    const rows = this.globalRows ?? [];
    if (rows.length === 0) {
      this.centerMessage(
        cx,
        midY,
        "No scores have been recorded yet.\nBe the first to earn a place.",
        area.width,
      );
      return;
    }

    const headerSize = Math.round(
      Phaser.Math.Clamp(area.width * 0.032, 11, 16),
    );
    const cellSize = Math.round(Phaser.Math.Clamp(area.width * 0.04, 13, 20));

    // Leave a fixed header band at the top; the scrolling list starts below.
    // Four short columns don't need the whole table's width — stretched across
    // it, RANK and INITIALS end up marooned from each other.
    const gridW = Math.min(area.width * 0.88, 620);
    const gridX = cx - gridW / 2;
    const headerY = area.y + 8;
    const ruleY = headerY + headerSize;
    const listTop = ruleY + 2;
    const listH = Math.max(
      MIN_ROW_STEP,
      area.y + area.height - HINT_RESERVE - listTop,
    );

    // Column centres, as fractions of the grid's width.
    const lRank = gridW * 0.08;
    const lName = gridW * 0.34;
    const lWho = gridW * 0.62;
    const lScore = gridW * 0.98;
    this.header(headerY, "RANK", headerSize).setX(gridX + lRank);
    this.header(headerY, "INITIALS", headerSize).setX(gridX + lName);
    // All three novices climb the same ladder and share this one board, so the
    // column says which one a run was, and the board goes on sorting by rank
    // and points alone.
    this.header(headerY, "NOVICE", headerSize).setX(gridX + lWho);
    this.header(headerY, "SCORE", headerSize, 1).setX(gridX + lScore);
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.35);
    rule.lineBetween(gridX, ruleY, gridX + gridW, ruleY);

    const rowStep = Phaser.Math.Clamp(
      listH / rows.length,
      Math.max(MIN_ROW_STEP, cellSize * 1.45),
      34,
    );

    // Rows live in a track clipped/scrolled by a dedicated camera. Local x runs
    // 0..gridW across the grid.
    const track = this.add.container(gridX, 0);

    rows.forEach((row, i) => {
      const y = i * rowStep + rowStep / 2;
      if (row.isYou) {
        track.add(
          this.add
            .rectangle(gridW / 2, y, gridW, rowStep, COLORS.goldLight, 0.18)
            .setOrigin(0.5),
        );
        track.add(
          this.add
            .text(0, y, "♛", {
              fontFamily: SERIF,
              fontSize: `${cellSize}px`,
              color: CSS.gold,
            })
            .setOrigin(0, 0.5),
        );
      } else if (i % 2 === 1) {
        track.add(
          this.add
            .rectangle(
              gridW / 2,
              y,
              gridW,
              rowStep,
              COLORS.feltLight,
              BAND_ALPHA,
            )
            .setOrigin(0.5),
        );
      }
      const color = row.isYou ? CSS.goldLight : CSS.parchment;
      const style = {
        fontFamily: SERIF,
        fontSize: `${cellSize}px`,
        color,
        fontStyle: row.isYou ? "bold" : "normal",
      };
      track.add(this.add.text(lRank, y, `${row.rank}`, style).setOrigin(0.5));
      track.add(this.add.text(lName, y, row.name || "—", style).setOrigin(0.5));
      // Set dimmer than the run's own figures: it says which discipline the run
      // was played under, which is context for the score beside it rather than
      // part of the score.
      track.add(
        this.add
          .text(lWho, y, CHARACTERS[row.character].name, {
            ...style,
            fontSize: `${Math.max(9, Math.round(cellSize * 0.85))}px`,
            color: row.isYou ? CSS.goldLight : CSS.dim,
          })
          .setOrigin(0.5),
      );
      const scoreText = this.add
        .text(lScore, y, formatScore(row.score), style)
        .setOrigin(1, 0.5);
      track.add(scoreText);
      // Endless runs get an infinity mark just left of the (right-aligned)
      // score.
      if (row.endless) {
        track.add(
          this.add
            .text(lScore - scoreText.width - 6, y, "∞", {
              fontFamily: SERIF,
              fontSize: `${cellSize}px`,
              color: CSS.gold,
            })
            .setOrigin(1, 0.5),
        );
      }
    });

    const hint = this.mountList({
      track,
      view: { x: gridX, y: listTop, width: gridW, height: listH },
      rowStep,
      count: rows.length,
      tappable: (i) => rows[i].hasAnalysis,
      onTap: (i) => this.openAnalysisGlobal(rows[i]),
      tapHint: rows.some((r) => r.hasAnalysis)
        ? "tap a row for its analysis"
        : "",
      hintW: area.width,
    });
    // Always kept, even when there is no standing hint: it is also where a
    // fetch's progress and failure notices are written (see setGlobalNotice),
    // and those can arrive long after this list was laid out.
    this.globalHintBase = hint.base;
    this.globalHint = hint.text;
    if (this.globalNotice) hint.text.setText(this.globalNotice);
  }

  /**
   * Hang a list of `count` rows, `rowStep` apart, in `view` and make it
   * scroll. The rows live in `track` — y from 0, one row per step — clipped by
   * a dedicated camera and scrolled by drag or wheel when they overflow. A tap
   * that barely moved opens the row under it; hovering a tappable row lights
   * it. Both tabs lay their tables out this way, so a short screen scrolls
   * either one instead of running its rows into the Return button.
   *
   * Must be called once everything else in the scene exists: the list camera
   * is told to ignore every object but the track at this point.
   */
  private mountList(opts: {
    track: Phaser.GameObjects.Container;
    view: Area;
    rowStep: number;
    count: number;
    tappable: (i: number) => boolean;
    onTap: (i: number) => void;
    tapHint: string;
    hintW: number;
  }): { text: Phaser.GameObjects.Text; base: string } {
    const { track, view, rowStep, count } = opts;
    track.setY(view.y);
    const contentH = count * rowStep;
    const overflow = Math.max(0, contentH - view.height);

    // Lit under the pointer rather than per row, so a hundred rows don't carry
    // a hundred hover zones.
    const highlight = this.add
      .rectangle(
        view.x + view.width / 2 - track.x,
        0,
        view.width,
        rowStep,
        COLORS.goldLight,
        0.14,
      )
      .setVisible(false);
    track.add(highlight);

    const base =
      overflow > 0
        ? opts.tapHint
          ? `drag or scroll for more · ${opts.tapHint}`
          : "drag or scroll for more"
        : opts.tapHint;
    // Directly under the last row when the list is short, at the foot of the
    // band when it scrolls.
    const text = this.add
      .text(
        view.x + view.width / 2,
        view.y + Math.min(contentH, view.height) + 4,
        base,
        {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        },
      )
      .setOrigin(0.5, 0);
    fitTextWidth(text, opts.hintW);

    // Clip the track to the list's band with a dedicated camera. It stays
    // transparent, so the felt and the turning sigil the main camera drew show
    // through behind the rows. The clip is only ever needed vertically — the
    // rows are no wider than the table — so the viewport spans the full width,
    // which lets the scene slide carry the list clear off the screen instead of
    // having it wink out at the table's left edge partway across.
    const cam = this.ensureGridCamera();
    setCameraViewport(cam, 0, view.y, this.scale.width, view.height);
    cam.setScroll(0, view.y);
    cam.ignore(this.children.list.filter((o) => o !== track));
    this.cameras.main.ignore(track);

    const maxY = view.y;
    const minY = view.y - overflow;
    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= view.x &&
      p.x <= view.x + view.width &&
      p.y >= view.y &&
      p.y <= view.y + view.height;
    // Map a pointer to the row under it, accounting for the scroll offset.
    const rowAt = (p: Phaser.Input.Pointer): number => {
      const i = Math.floor((p.y - track.y) / rowStep);
      return i >= 0 && i < count ? i : -1;
    };

    let dragging = false;
    let startPointerX = 0;
    let startPointerY = 0;
    let startTrackY = 0;

    const onDown: PointerHandler = (p) => {
      if (!inBounds(p)) return;
      dragging = true;
      startPointerX = p.x;
      startPointerY = p.y;
      startTrackY = track.y;
    };
    const onMove: PointerHandler = (p) => {
      if (!dragging) {
        const over = inBounds(p);
        const i = over ? rowAt(p) : -1;
        const tappable = i >= 0 && opts.tappable(i);
        highlight.setVisible(tappable);
        if (tappable) highlight.setY(i * rowStep + rowStep / 2);
        this.input.setDefaultCursor(
          tappable ? "pointer" : over && overflow > 0 ? "grab" : "default",
        );
        return;
      }
      if (overflow > 0) {
        highlight.setVisible(false);
        track.y = Phaser.Math.Clamp(
          startTrackY + (p.y - startPointerY),
          minY,
          maxY,
        );
      }
    };
    const onUp: PointerHandler = (p) => {
      // A pointerup that barely moved is a tap: open the row's breakdown.
      if (
        dragging &&
        Math.abs(p.x - startPointerX) < 6 &&
        Math.abs(p.y - startPointerY) < 6 &&
        inBounds(p) &&
        // Holding a die to read it is not a tap on its row.
        !this.dieTooltip.tookPress
      ) {
        const i = rowAt(p);
        if (i >= 0 && opts.tappable(i)) opts.onTap(i);
      }
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (overflow <= 0 || !inBounds(p)) return;
      highlight.setVisible(false);
      track.y = Phaser.Math.Clamp(track.y - dy, minY, maxY);
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    return { text, base };
  }

  /** Send the scores off to the right, then hand over to the menu, which
   *  brings its own interface in over the same still room. */
  private leave(complete: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }

  private ensureGridCamera(): Phaser.Cameras.Scene2D.Camera {
    if (this.gridCamera) this.cameras.remove(this.gridCamera, true);
    const cam = addCamera(this, 0, 0, 1, 1);
    cam.setBackgroundColor();
    this.gridCamera = cam;
    return cam;
  }

  private centerMessage(
    cx: number,
    y: number,
    text: string,
    tableW: number,
  ): void {
    this.add
      .text(cx, y, text, {
        fontFamily: SERIF,
        fontSize: `${Math.round(Phaser.Math.Clamp(tableW * 0.026, 16, 24))}px`,
        color: CSS.parchmentDark,
        fontStyle: "italic",
        align: "center",
        lineSpacing: 6,
      })
      .setOrigin(0.5);
  }

  private header(
    y: number,
    label: string,
    size: number,
    originX = 0.5,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(0, y, label, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.gold,
        letterSpacing: 2,
        fontStyle: "bold",
      })
      .setOrigin(originX, 0.5);
  }

  private cell(
    y: number,
    value: string,
    size: number,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(0, y, value, {
        fontFamily: SERIF,
        fontSize: `${size}px`,
        color: CSS.parchment,
      })
      .setOrigin(0.5);
  }
}
