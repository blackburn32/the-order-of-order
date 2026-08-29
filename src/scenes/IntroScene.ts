import Phaser from "phaser";
import { COLORS, CSS } from "../art/palette";
import { loadSettings, saveSettings } from "../systems/SaveData";
import { beginRun } from "../systems/Tutorial";
import { bannerButton, checkboxRow } from "../ui/widgets";
import { destroyAllChildren, responsive } from "../ui/layout";
import { buildPageDots, buildStoryPage, type StoryPage } from "../ui/storyPage";
import { slideSceneIn, slideSceneOut } from "../ui/sceneSlide";

// The premise of the Order, one screen at a time. Pages without an `image` show
// a placeholder 4:3 rectangle until real art drops in.
const PAGES: StoryPage[] = [
  {
    title: "A Gathering Chaos",
    blurb:
      "Across the realm, order frays. Numbers fall as they please, and the wild churn of chance brings great peril to every living thing.",
    image: "intro-volcano",
  },
  {
    title: "The Brave Monks",
    blurb:
      "In the high monasteries, a devoted few refuse to yield. Searching the old vaults, they uncover a relic of impossible make.",
    image: "intro-monastery",
  },
  {
    title: "The Sacred Dice",
    blurb:
      "The artifact is a set of dice — and rolled with discipline, they can bind the chaos and restore the world’s order. The rite is yours to perform.",
    image: "intro-dice-twirl",
  },
  {
    title: "The Race is On",
    blurb:
      "Humble monk, take up the dice and roll the sacred numbers. The Order of Order is depending on you to bring balance back to the realm before it's too late!",
    image: "intro-dice-earth",
  },
];

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
    const W = this.scale.width;
    const cx = W / 2;
    const last = this.page === PAGES.length - 1;

    const layout = buildStoryPage(
      this,
      PAGES[this.page],
      PAGES,
      INTRO_AMBIENCE,
    );
    this.slideBackdrop = layout.backdrop;

    const label = last ? "Begin" : "Continue";
    const button = bannerButton(this, cx, 0, label, () => {
      if (last) this.leave(() => beginRun(this));
      else this.nextPage();
    });
    button.y = layout.blockTop + button.height / 2;
    let cursorY = button.y + button.height / 2 + 24;

    // Final page: the skip checkbox sits below the button.
    if (last) {
      this.skip = !loadSettings().showIntro;
      const row = checkboxRow(
        this,
        cx,
        cursorY,
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
      cursorY += 34;
    }

    buildPageDots(this, cx, cursorY, PAGES.length, this.page);
  }

  /** Send the current chapter to the right, rebuild the next one, then bring
   *  it in from the left. The ambient layer hands its sigil into the rebuild,
   *  so the room morphs rather than blinking between random glyphs. */
  private nextPage(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    slideSceneOut(
      this,
      () => {
        this.page += 1;
        destroyAllChildren(this);
        this.build();
        // slideSceneOut disables input before invoking its completion. Re-arm it
        // so slideSceneIn can own the incoming panel's input lock and restore it.
        this.input.enabled = true;
        slideSceneIn(this, this.slideBackdrop, () => {
          this.transitioning = false;
        });
      },
      this.slideBackdrop,
    );
  }

  private leave(complete: () => void): void {
    if (this.transitioning) return;
    this.transitioning = true;
    slideSceneOut(this, complete, this.slideBackdrop);
  }
}
