import Phaser from "phaser";
import { COLORS, CSS } from "../art/palette";
import { loadSettings, saveSettings } from "../systems/SaveData";
import { beginRun } from "../systems/Tutorial";
import { bannerButton, checkboxRow } from "../ui/widgets";
import { responsive } from "../ui/layout";
import { INTRO_PAGES } from "../story";
import {
  buildPageDots,
  buildStoryFrame,
  type StoryFrame,
} from "../ui/storyPage";
import {
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
    this.frame = buildStoryFrame(this, INTRO_PAGES, INTRO_AMBIENCE);
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

    const cx = this.scale.width / 2;
    const last = this.page === INTRO_PAGES.length - 1;

    const label = last ? "Begin" : "Continue";
    const button = bannerButton(this, cx, 0, label, () => {
      if (last) this.leave(() => beginRun(this));
      else this.nextPage();
    });
    button.y = this.frame.blockTop + button.height / 2;
    this.controls.push(button);

    // The skip row only exists on the last page, but its height is reserved on
    // every page: the dots are part of the furniture now, and they must not
    // step down the screen when the row appears under them.
    const rowY = button.y + button.height / 2 + 24;
    if (last) {
      this.skip = !loadSettings().showIntro;
      const row = checkboxRow(
        this,
        cx,
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
        // border instead of the panel-friendly ink defaults.
        { textColor: CSS.ivory, boxStroke: COLORS.parchment },
      );
      row.setDepth(1);
      this.controls.push(row);
    }

    this.controls.push(
      ...buildPageDots(this, cx, rowY + 34, INTRO_PAGES.length, this.page),
    );
  }

  /** Send the current chapter to the right, draw the next one, then bring it in
   *  from the left. Only the chapter travels — the room behind it and the
   *  controls beneath it hold their place, so the page turns within the screen
   *  rather than the whole screen turning over. */
  private nextPage(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    const outgoing = this.chapter;
    slideObjectsOut(this, [outgoing], () => {
      outgoing.destroy();
      this.page += 1;
      this.chapter = this.frame.page(INTRO_PAGES[this.page]);
      this.buildControls();
      // slideObjectsOut disables input before invoking its completion. Re-arm
      // it so slideObjectsIn can own the incoming chapter's lock and restore it.
      this.input.enabled = true;
      slideObjectsIn(this, [this.chapter], () => {
        this.transitioning = false;
      });
    });
  }

  private leave(complete: () => void): void {
    if (this.transitioning) return;
    this.transitioning = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }
}
