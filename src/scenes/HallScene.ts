import Phaser from "phaser";
import { COLORS, CSS, SERIF } from "../art/palette";
import { HallEntry, loadHall } from "../systems/SaveData";
import { addFelt, bannerButton, fitTextWidth } from "../ui/widgets";
import { AmbientLayer } from "../ui/AmbientLayer";
import { buildSceneHeader } from "../ui/sceneHeader";
import { destroyAllChildren, onResizeCoalesced } from "../ui/layout";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";
import {
  fetchTopScores,
  globalScoresEnabled,
  GlobalScoreRow,
} from "../systems/GlobalScores";
import { toNumberPointMap } from "../systems/ItemPoints";
import { formatScore } from "../ui/formatScore";

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

/**
 * The Hall of High Scores. Two tabs: the player's local runs (drawn from
 * localStorage) and the worldwide top-100 fetched from LootLocker. The selected
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

  constructor() {
    super("Hall");
  }

  create(): void {
    this.tab = "local";
    this.globalRows = null;
    this.globalStatus = "idle";
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

    const header = buildSceneHeader(this, {
      title: "Hall of High Scores",
      y: Math.max(50, Math.min(H * 0.13, 96)),
      width: Math.min(W, 760),
    });
    this.slideBackdrop = [felt, ambient, header.glow];

    const tableW = Math.min(W - 36, 900);

    const tabsY = header.bottom + 28;
    this.buildTabs(cx, tabsY, tableW);

    // The Return button is created before the (camera-clipped) content so it is
    // part of the "everything except the scroll track" set the grid camera
    // ignores.
    const buttonY = H - 46;
    bannerButton(
      this,
      cx,
      buttonY,
      "Return to the Vestibule",
      () => this.leave(() => this.scene.start("Menu")),
      Math.min(tableW, 340),
    );

    const contentTop = tabsY + 40;
    const contentBottom = buttonY - 52;

    if (this.tab === "local") {
      this.buildLocal(cx, tableW, contentTop, contentBottom);
    } else {
      this.buildGlobal(cx, tableW, contentTop, contentBottom);
    }
  }

  /** Two text tabs sharing one baseline, the selected one gold over a short
   *  gold rule. Parchment buttons were doing this job before, which put two
   *  more slabs of chrome between the masthead and the scores. */
  private buildTabs(cx: number, y: number, tableW: number): void {
    const size = Math.round(Phaser.Math.Clamp(tableW * 0.028, 17, 22));
    const gap = Math.max(28, tableW * 0.06);

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

  private buildLocal(
    cx: number,
    tableW: number,
    contentTop: number,
    contentBottom: number,
  ): void {
    const entries = loadHall();
    const band = Math.max(1, contentBottom - contentTop);

    if (entries.length === 0) {
      this.centerMessage(
        cx,
        contentTop + band * 0.32,
        "No initiates have been recorded.\nBegin a run and earn your place.",
        tableW,
      );
      return;
    }

    const headerSize = Math.round(Phaser.Math.Clamp(tableW * 0.032, 11, 16));
    const cellSize = Math.round(Phaser.Math.Clamp(tableW * 0.045, 13, 20));
    const colGap = Math.max(10, tableW * 0.02);
    const anyPoints = entries.some((e) => e.itemPoints || e.dicePoints);
    const hintH = anyPoints ? 26 : 0;
    /** Room between the column heads and the first row. */
    const HEAD_H = 34;

    // The table is centred in the band rather than hung off the tabs: with the
    // panel gone there is no frame holding it, and a short list left at the top
    // of a tall screen reads as a page that stopped halfway.
    const rowStep = Phaser.Math.Clamp(
      (band - HEAD_H - hintH) / entries.length,
      20,
      36,
    );
    const blockH = HEAD_H + entries.length * rowStep + hintH;
    const headerY = contentTop + Math.max(0, (band - blockH) / 2);
    const rowStart = headerY + HEAD_H;

    // Claimed now, filled once the columns have been measured: a container
    // keeps the display-list slot it was created in, so banding drawn into it
    // later still ends up beneath every glyph and die icon.
    const bands = this.add.container(0, 0);

    // Every column is built at x = 0 and positioned only once all of them have
    // been measured. DATE/RANK/SCORE then can't collide whatever the font size,
    // locale date format, or digit count — and the block can be centred on the
    // width it actually occupies rather than on a guess.
    const dateTexts = [this.header(headerY, "DATE", headerSize)];
    const rankTexts = [this.header(headerY, "RANK", headerSize)];
    const scoreTexts = [this.header(headerY, "SCORE", headerSize)];
    const gridHeader = this.header(headerY, "FINAL GRID", headerSize, 0);

    const rows = entries.map((entry, i) => {
      const y = rowStart + i * rowStep;
      const date = new Date(entry.startedAt).toLocaleDateString(undefined, {
        year: "2-digit",
        month: "numeric",
        day: "numeric",
      });
      dateTexts.push(this.cell(y, date, cellSize));
      // Rank is the ranking key now, so it reads as "rank-trial" — the same
      // shorthand the in-game HUD uses.
      rankTexts.push(this.cell(y, `${entry.rank}-${entry.trial}`, cellSize));
      scoreTexts.push(this.cell(y, formatScore(entry.score), cellSize));
      return {
        y,
        entry,
        dice: this.buildGridList(entry, y, rowStep, cellSize),
      };
    });

    const widest = (texts: Phaser.GameObjects.Text[]) =>
      Math.max(...texts.map((t) => t.width));
    const dateW = widest(dateTexts);
    const rankW = widest(rankTexts);
    const scoreW = widest(scoreTexts);
    // The crown and the endless mark get columns of their own rather than being
    // tucked into a margin, so neither can crowd the date or the score.
    const crownW = entries.some((e) => e.won) ? cellSize + 4 : 0;
    const markW = entries.some((e) => e.endless) ? cellSize : 0;
    const listW = Math.max(gridHeader.width, ...rows.map((r) => r.dice.width));

    // Walk the columns left to right in block-local coordinates, then centre
    // the finished block on the table.
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
    cursor += scoreW + colGap * 1.4;
    const gridX = cursor;
    // Whatever room is left over belongs to the grid column; a dice list longer
    // than that is scaled down to fit it.
    const gridColW = Math.max(60, Math.min(listW, tableW * 0.94 - gridX));
    const blockW = gridX + gridColW;
    const blockLeft = cx - blockW / 2;
    // Banding and hover zones run a little past the ink on either side, the way
    // ruling on a page does.
    const bandW = Math.min(tableW * 0.98, blockW + 28);

    dateTexts.forEach((t) => t.setX(blockLeft + dateX));
    rankTexts.forEach((t) => t.setX(blockLeft + rankX));
    scoreTexts.forEach((t) => t.setX(blockLeft + scoreX));
    gridHeader.setX(blockLeft + gridX);
    // The head is measured into `listW`, but only the dice rows are scaled to
    // the column — shrink the head itself when the room ran out.
    fitTextWidth(gridHeader, gridColW);

    entries.forEach((_, i) => {
      if (i % 2 === 1) {
        bands.add(
          this.add.rectangle(
            cx,
            rowStart + i * rowStep,
            bandW,
            rowStep,
            COLORS.feltLight,
            BAND_ALPHA,
          ),
        );
      }
    });

    // A hairline under the column heads — the one piece of ruling the table
    // needs to separate its head from its body.
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.35);
    rule.lineBetween(
      cx - bandW / 2,
      headerY + headerSize,
      cx + bandW / 2,
      headerY + headerSize,
    );

    rows.forEach(({ y, entry, dice }) => {
      // Victorious runs get a gold crown in the left gutter (old entries predate
      // `won`, so `undefined` reads as a loss — no marker).
      if (entry.won) {
        this.add
          .text(blockLeft + crownX, y, "♛", {
            fontFamily: SERIF,
            fontSize: `${cellSize}px`,
            color: CSS.goldLight,
          })
          .setOrigin(0.5);
      }
      // Runs that pressed on past the final rank get an infinity mark just left
      // of the score column.
      if (entry.endless) {
        this.add
          .text(blockLeft + markRight, y, "∞", {
            fontFamily: SERIF,
            fontSize: `${cellSize}px`,
            color: CSS.gold,
          })
          .setOrigin(1, 0.5);
      }

      dice.container.setX(blockLeft + gridX);
      if (dice.width > gridColW) dice.container.setScale(gridColW / dice.width);

      // Runs recorded with a points breakdown are tappable to open their
      // analysis. A near-transparent zone highlights on hover; older entries
      // predate the breakdown and stay inert.
      const hasPoints =
        !!(entry.itemPoints && Object.keys(entry.itemPoints).length) ||
        !!(entry.dicePoints && Object.keys(entry.dicePoints).length);
      if (hasPoints) {
        const zone = this.add
          .rectangle(cx, y, bandW, rowStep, COLORS.goldLight, 0.0001)
          .setInteractive({ useHandCursor: true });
        zone.on("pointerover", () => zone.setFillStyle(COLORS.goldLight, 0.14));
        zone.on("pointerout", () =>
          zone.setFillStyle(COLORS.goldLight, 0.0001),
        );
        zone.on("pointerdown", () => this.openAnalysisLocal(entry));
      }
    });

    if (anyPoints) {
      this.add
        .text(
          cx,
          rowStart + entries.length * rowStep + 6,
          "tap a run for its points breakdown",
          {
            fontFamily: SERIF,
            fontSize: "13px",
            color: CSS.dim,
            fontStyle: "italic",
          },
        )
        .setOrigin(0.5, 0);
    }
  }

  /**
   * One run's final grid: every die size it ended with, once, followed by how
   * many of that size it held. Built left-anchored at x = 0 so the caller can
   * measure the row before deciding where the grid column starts.
   */
  private buildGridList(
    entry: HallEntry,
    y: number,
    rowStep: number,
    cellSize: number,
  ): { container: Phaser.GameObjects.Container; width: number } {
    // A saved grid can contain several stacks of the same die size because
    // source and special flags are persisted separately. Collapse those stacks
    // so the row shows every size once, with its total count.
    const counts = new Map<number, number>();
    for (const stack of entry.dice) {
      counts.set(stack.sides, (counts.get(stack.sides) ?? 0) + stack.count);
    }
    const diceTypes = [...counts.entries()].sort(
      ([sidesA], [sidesB]) => sidesB - sidesA,
    );
    const iconSize = Phaser.Math.Clamp(rowStep * 0.72, 10, 26);
    const countSize = Math.floor(Phaser.Math.Clamp(cellSize * 0.72, 7, 14));
    const itemPadding = Math.max(8, iconSize * 0.4);
    const container = this.add.container(0, y);
    let listX = 0;

    diceTypes.forEach(([sides, count]) => {
      const icon = this.add
        .image(listX + iconSize / 2, 0, `die-${sides}`)
        .setScale(iconSize / 96);
      const label = this.add
        .text(listX + iconSize + 3, 0, `×${formatScore(count)}`, {
          fontFamily: SERIF,
          fontSize: `${countSize}px`,
          color: CSS.parchmentDark,
        })
        .setOrigin(0, 0.5);
      container.add([icon, label]);
      listX += iconSize + 3 + label.width + itemPadding;
    });

    return { container, width: Math.max(1, listX - itemPadding) };
  }

  private openAnalysisLocal(entry: HallEntry): void {
    const date = new Date(entry.startedAt).toLocaleDateString();
    this.scene.launch("Analysis", {
      returnTo: "Hall",
      title: `Run Analysis · ${formatScore(entry.score)} pts`,
      subtitle: `${date} · rank ${entry.rank}-${entry.trial}${entry.won ? " · victory" : ""}`,
      dicePoints: toNumberPointMap(entry.dicePoints ?? {}),
      itemPoints: toNumberPointMap(entry.itemPoints ?? {}),
    });
  }

  private openAnalysisGlobal(row: GlobalScoreRow): void {
    this.scene.launch("Analysis", {
      returnTo: "Hall",
      title: `Global · rank ${row.rank}${row.name ? ` · ${row.name}` : ""}`,
      subtitle: "Approximate points, from the leaderboard’s per-item shares",
      entries: row.breakdown,
    });
  }

  // --- Global tab -----------------------------------------------------------

  private buildGlobal(
    cx: number,
    tableW: number,
    contentTop: number,
    contentBottom: number,
  ): void {
    if (this.globalStatus !== "ready") {
      const msg =
        this.globalStatus === "loading"
          ? "Consulting the global hall…"
          : this.globalStatus === "disabled"
            ? "The global hall is beyond reach."
            : this.globalStatus === "error"
              ? "The global hall could not be reached.\nTap Global to try again."
              : "Consulting the global hall…";
      this.centerMessage(cx, (contentTop + contentBottom) / 2, msg, tableW);
      return;
    }

    const rows = this.globalRows ?? [];
    if (rows.length === 0) {
      this.centerMessage(
        cx,
        (contentTop + contentBottom) / 2,
        "No scores have been recorded yet.\nBe the first to earn a place.",
        tableW,
      );
      return;
    }

    const headerSize = Math.round(Phaser.Math.Clamp(tableW * 0.032, 11, 16));
    const cellSize = Math.round(Phaser.Math.Clamp(tableW * 0.04, 13, 20));

    // Leave a fixed header band at contentTop; the scrolling list starts below.
    // Three short columns don't need the whole table's width — stretched across
    // it, RANK and INITIALS end up marooned from each other.
    const gridW = Math.min(tableW * 0.88, 620);
    const grid = {
      x: cx - gridW / 2,
      y: contentTop + 34,
      width: gridW,
      height: 0,
    };
    // Header row sits just above the scrolling list, fixed.
    const rankX = grid.x + grid.width * 0.08;
    const nameX = grid.x + grid.width * 0.42;
    const scoreX = grid.x + grid.width * 0.98;
    this.header2(contentTop, rankX, "RANK", headerSize, 0.5);
    this.header2(contentTop, nameX, "INITIALS", headerSize, 0.5);
    this.header2(contentTop, scoreX, "SCORE", headerSize, 1);
    const rule = this.add.graphics();
    rule.lineStyle(1, COLORS.gold, 0.35);
    rule.lineBetween(
      grid.x,
      contentTop + headerSize,
      grid.x + grid.width,
      contentTop + headerSize,
    );

    // Reserve a strip below the list for the hint line, so it never collides
    // with the Return button.
    const hintReserve = 24;
    grid.height = Math.max(80, contentBottom - grid.y - hintReserve);

    const rowStep = Math.min(
      34,
      Math.max(22, grid.height / Math.max(rows.length, 1)),
    );
    const contentH = rows.length * rowStep;

    // Rows live in a track clipped/scrolled by a dedicated camera. Local coords
    // run 0..grid.width horizontally; column X are re-expressed relative to it.
    const track = this.add.container(grid.x, grid.y);
    const lRank = grid.width * 0.08;
    const lName = grid.width * 0.42;
    const lScore = grid.width * 0.98;

    rows.forEach((row, i) => {
      const y = i * rowStep + rowStep / 2;
      if (row.isYou) {
        track.add(
          this.add
            .rectangle(
              grid.width / 2,
              y,
              grid.width,
              rowStep,
              COLORS.goldLight,
              0.18,
            )
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
              grid.width / 2,
              y,
              grid.width,
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

    // Clip the track to the list's band with a dedicated camera. It stays
    // transparent, so the felt and the turning sigil the main camera drew show
    // through behind the rows. The clip is only ever needed vertically — the
    // rows are no wider than the table — so the viewport spans the full width,
    // which lets the scene slide carry the list clear off the screen instead of
    // having it wink out at the table's left edge partway across.
    const cam = this.ensureGridCamera();
    cam.setViewport(0, grid.y, this.scale.width, grid.height);
    cam.setScroll(0, grid.y);
    cam.ignore(this.children.list.filter((o) => o !== track));
    this.cameras.main.ignore(track);

    const overflow = Math.max(0, contentH - grid.height);
    const maxY = grid.y;
    const minY = grid.y - overflow;
    const inBounds = (p: Phaser.Input.Pointer) =>
      p.x >= grid.x &&
      p.x <= grid.x + grid.width &&
      p.y >= grid.y &&
      p.y <= grid.y + grid.height;
    const anyBreakdown = rows.some(
      (r) => r.breakdown && r.breakdown.length > 0,
    );

    // Map a pointer to the row under it (accounting for the scroll offset) so a
    // tap can open that run's points breakdown; a drag scrolls the list instead.
    const rowAt = (p: Phaser.Input.Pointer): GlobalScoreRow | undefined => {
      const i = Math.floor((p.y - track.y) / rowStep);
      return i >= 0 && i < rows.length ? rows[i] : undefined;
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
        const tappable = over && !!rowAt(p)?.breakdown?.length;
        this.input.setDefaultCursor(
          tappable ? "pointer" : over && overflow > 0 ? "grab" : "default",
        );
        return;
      }
      if (overflow > 0)
        track.y = Phaser.Math.Clamp(
          startTrackY + (p.y - startPointerY),
          minY,
          maxY,
        );
    };
    const onUp: PointerHandler = (p) => {
      // A pointerup that barely moved is a tap: open the row's breakdown.
      if (
        dragging &&
        Math.abs(p.x - startPointerX) < 6 &&
        Math.abs(p.y - startPointerY) < 6 &&
        inBounds(p)
      ) {
        const row = rowAt(p);
        if (row?.breakdown?.length) this.openAnalysisGlobal(row);
      }
      dragging = false;
    };
    const onWheel: WheelHandler = (p, _over, _dx, dy) => {
      if (overflow <= 0 || !inBounds(p)) return;
      track.y = Phaser.Math.Clamp(track.y - dy, minY, maxY);
    };

    this.input.on("pointerdown", onDown);
    this.input.on("pointermove", onMove);
    this.input.on("pointerup", onUp);
    this.input.on("pointerupoutside", onUp);
    this.input.on("wheel", onWheel);
    this.input$ = { down: onDown, move: onMove, up: onUp, wheel: onWheel };

    const hintText =
      overflow > 0
        ? anyBreakdown
          ? "drag or scroll for more · tap a row for its points"
          : "drag or scroll for more"
        : anyBreakdown
          ? "tap a row for its points"
          : "";
    if (hintText) {
      const hint = this.add
        .text(grid.x + grid.width / 2, grid.y + grid.height + 2, hintText, {
          fontFamily: SERIF,
          fontSize: "13px",
          color: CSS.dim,
          fontStyle: "italic",
        })
        .setOrigin(0.5, 0);
      this.gridCamera?.ignore(hint);
    }
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
    const cam = this.cameras.add(0, 0, 1, 1);
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

  private header2(
    y: number,
    x: number,
    label: string,
    size: number,
    originX: number,
  ): Phaser.GameObjects.Text {
    return this.add
      .text(x, y, label, {
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
