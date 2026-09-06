import Phaser from "phaser";
import { COLORS, CSS } from "../art/palette";
import { loadSettings, saveSettings } from "../systems/SaveData";
import { beginRun } from "../systems/Tutorial";
import { bannerButton, checkboxRow } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { INTRO_PAGES, STORY_BUTTONS } from "../story";
import {
  buildPageDots,
  buildStoryFrame,
  type StoryFrame,
} from "../ui/storyPage";
import {
  PAGE_TURN,
  slideObjectsIn,
  slideObjectsOut,
  slideSceneIn,
  slideSceneOut,
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
  /** The button, the skip row and the dots. Held so the block can be rebuilt
   *  where it stands when the page turns, rather than rebuilt with the scene. */
  private controls: Phaser.GameObjects.GameObject[] = [];

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
    this.frame = buildStoryFrame(this, INTRO_PAGES, INTRO_AMBIENCE, BLOCK_TAIL);
    this.slideBackdrop = this.frame.backdrop;
    this.chapter = this.frame.page(INTRO_PAGES[this.page]);
    this.buildControls();
  }

  /** The block under the chapter: the Continue button, the skip row on the last
   *  page, and the dots. None of it moves between pages, so it is drawn outside
   *  the chapter's container and redrawn in place as the page changes. */
  private buildControls(): void {
    for (const control of this.controls) control.destroy();
    this.controls = [];

    const { blockTop, blockX, blockWidth, blockBottom } = this.frame;
    const last = this.page === INTRO_PAGES.length - 1;

    // The button takes whatever the block has left once the row and the dots
    // are spoken for, so a short viewport shrinks it rather than pushing it off
    // the foot of the screen or into the column beside it.
    const label = last ? STORY_BUTTONS.beginRun : STORY_BUTTONS.continue;
    const button = bannerButton(
      this,
      blockX,
      0,
      label,
      () => {
        if (last) this.leave(() => beginRun(this));
        else this.nextPage();
      },
      blockWidth,
      Math.max(1, blockBottom - blockTop - BLOCK_TAIL),
    );
    button.y = blockTop + button.height / 2;
    this.controls.push(button);

    // The skip row only exists on the last page, but its height is reserved on
    // every page: the dots are part of the furniture now, and they must not
    // step down the screen when the row appears under them.
    const rowY = button.y + button.height / 2 + ROW_GAP;
    if (last) {
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
      this.controls.push(row);
    }

    this.controls.push(
      ...buildPageDots(
        this,
        blockX,
        rowY + DOTS_GAP,
        INTRO_PAGES.length,
        this.page,
      ),
    );
  }

  /** Send the current chapter to the left, draw the next one, then bring it in
   *  from the right — a page turning in a book. Only the chapter travels — the
   *  room behind it and the controls beneath it hold their place, so the page
   *  turns within the screen rather than the whole screen turning over. */
  private nextPage(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    const outgoing = this.chapter;
    slideObjectsOut(
      this,
      [outgoing],
      () => {
        outgoing.destroy();
        this.page += 1;
        this.chapter = this.frame.page(INTRO_PAGES[this.page]);
        this.buildControls();
        // slideObjectsOut disables input before invoking its completion. Re-arm
        // it so slideObjectsIn can own the incoming chapter's lock and restore
        // it.
        this.input.enabled = true;
        slideObjectsIn(
          this,
          [this.chapter],
          () => {
            this.transitioning = false;
          },
          PAGE_TURN,
        );
      },
      PAGE_TURN,
    );
  }

  private leave(complete: () => void): void {
    if (this.transitioning) return;
    this.transitioning = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }
}
