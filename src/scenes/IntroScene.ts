import Phaser from "phaser";
import { COLORS, CSS } from "../art/palette";
import { loadSettings, saveSettings } from "../systems/SaveData";
import { bannerButton, checkboxRow } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { INTRO_PAGES, STORY_BUTTONS } from "../story";
import {
  buildPageDots,
  buildStoryFrame,
  type StoryFrame,
} from "../ui/storyPage";
import {
  slideSceneIn,
  slideSceneOut,
  turnPage,
  type PageTurn,
} from "../ui/sceneSlide";

/** Fixed sigil brightness for the backdrop. Set below the other rooms' values:
 *  the page art already owns the middle of the screen here, so the sigil is
 *  only ever read at the margins around it, where the menu's brightness would
 *  compete with the art instead of framing it. */
const INTRO_AMBIENCE = 0.35;

/** Air under the button, before the skip row. */
const ROW_GAP = 24;
/** Air between the skip row and the dots. */
const DOTS_GAP = 34;
/** What the control block needs below its button: the skip row's slot — held
 *  on every page, not just the one that fills it — and then the dots. Declared
 *  to the frame so the copy above stops clear of the whole block. */
const BLOCK_TAIL = ROW_GAP + DOTS_GAP + 12;

export class IntroScene extends Phaser.Scene {
  private page = 0;
  private skip = false;
  private transitioning = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private frame!: StoryFrame;
  private chapter!: Phaser.GameObjects.Container;
  /** The page turn in flight, if any. Continue stays live while it runs, and a
   *  press then lands it at once and moves on to the step after it. */
  private turn?: PageTurn;
  /** Where the skip row's slot sits under the button. */
  private rowY = 0;
  /** The skip row and the dots — the parts of the control block that change
   *  with the page. Held so they can be redrawn in place as the page turns,
   *  while the button itself stays put and stays live. */
  private marks: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Intro");
  }

  create(): void {
    this.page = 0;
    this.skip = false;
    this.transitioning = false;
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);
  }

  private build(): void {
    // A resize rebuilds the scene from nothing, pages and all; the page index
    // already names the page being turned to, so draw that one at rest.
    this.turn?.cancel();
    this.turn = undefined;
    this.marks = [];
    this.frame = buildStoryFrame(this, INTRO_PAGES, INTRO_AMBIENCE, BLOCK_TAIL);
    this.slideBackdrop = this.frame.backdrop;
    this.chapter = this.frame.page(INTRO_PAGES[this.page]);
    this.buildControls();
  }

  /** The block under the chapter: the Continue button — which says the same
   *  thing on the last page as on the first — the skip row on the last page,
   *  and the dots. None of it moves between pages, so it is drawn outside the
   *  chapter's container; the button is built once and the rest is redrawn in
   *  place as the page changes. */
  private buildControls(): void {
    const { blockTop, blockX, blockWidth, blockBottom } = this.frame;

    // The button takes whatever the block has left once the row and the dots
    // are spoken for, so a short viewport shrinks it rather than pushing it off
    // the foot of the screen or into the column beside it.
    const label = STORY_BUTTONS.continue;
    const button = bannerButton(
      this,
      blockX,
      0,
      label,
      () => this.advance(),
      blockWidth,
      Math.max(1, blockBottom - blockTop - BLOCK_TAIL),
    );
    button.y = blockTop + button.height / 2;

    // The skip row only exists on the last page, but its height is reserved on
    // every page: the dots are part of the furniture now, and they must not
    // step down the screen when the row appears under them.
    this.rowY = button.y + button.height / 2 + ROW_GAP;
    this.buildMarks();
  }

  /** The skip row, on the last page, and the dots under it. */
  private buildMarks(): void {
    for (const mark of this.marks) mark.destroy();
    this.marks = [];

    const { blockX, blockWidth } = this.frame;
    const rowY = this.rowY;
    if (this.page === INTRO_PAGES.length - 1) {
      this.skip = !loadSettings().showIntro;
      const row = checkboxRow(
        this,
        blockX,
        rowY,
        "Skip the intro on future runs",
        this.skip,
        (value) => {
          this.skip = value;
          const settings = loadSettings();
          settings.showIntro = !value;
          saveSettings(settings);
        },
        26,
        // The row sits on the dark felt, so use light text and a parchment
        // border instead of the panel-friendly ink defaults. Its label is a
        // full sentence, so it is also the first thing to overrun the folded
        // layout's column — hence the width budget.
        {
          textColor: CSS.ivory,
          boxStroke: COLORS.parchment,
          maxWidth: blockWidth,
        },
      );
      row.setDepth(1);
      this.marks.push(row);
    }

    this.marks.push(
      ...buildPageDots(
        this,
        blockX,
        rowY + DOTS_GAP,
        INTRO_PAGES.length,
        this.page,
      ),
    );
  }

  /** Continue: turn to the next chapter, or leave from the last one. Pressed
   *  while a page is still turning, it lands that turn at once and carries on
   *  to the step after it, rather than waiting the animation out. */
  private advance(): void {
    this.turn?.finish();
    if (this.page === INTRO_PAGES.length - 1) {
      this.leave(() => this.scene.start("Character"));
    } else {
      this.nextPage();
    }
  }

  /** Send the current chapter to the left, draw the next one, then bring it in
   *  from the right — a page turning in a book. Only the chapter travels — the
   *  room behind it and the controls beneath it hold their place, so the page
   *  turns within the screen rather than the whole screen turning over. */
  private nextPage(): void {
    this.page += 1;
    this.turn = turnPage(
      this,
      this.chapter,
      () => {
        this.chapter = this.frame.page(INTRO_PAGES[this.page]);
        this.buildMarks();
        return this.chapter;
      },
      () => {
        this.turn = undefined;
      },
    );
  }

  private leave(complete: () => void): void {
    if (this.transitioning) return;
    this.transitioning = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }
}
