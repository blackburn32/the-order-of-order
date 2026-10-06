import Phaser from "phaser";
import { getRun } from "../state/RunState";
import {
  endingById,
  markEndingSeen,
  rollKingsDemands,
  type EndingDef,
  type EndingId,
} from "../systems/Endings";
import {
  createFreshShopCheckpoint,
  saveActiveRun,
  type ResumableCheckpoint,
} from "../systems/ActiveRunPersistence";
import { STORY_BUTTONS } from "../story";
import { responsive } from "../ui/layout";
import {
  buildPageDots,
  buildSkipLink,
  buildStoryFrame,
  type StoryFrame,
} from "../ui/storyPage";
import {
  slideSceneIn,
  slideSceneOut,
  turnPage,
  type PageTurn,
} from "../ui/sceneSlide";
import { bannerButton } from "../ui/widgets";
import { streamFor } from "../systems/Rng";

/** Fixed sigil brightness for the backdrop. Set at the top of the range rather
 *  than the intro's dim margin light: these are the screens where the Order's
 *  work has just landed, and the room should read as answering it. */
const ENDING_AMBIENCE = 0.8;

/** Air under the button, before the skip link. */
const ROW_GAP = 24;
/** Air between the skip link and the dots. */
const DOTS_GAP = 34;
/** What the control block needs below its button: the skip link's slot — held
 *  on every page, including the last one that leaves it empty — then the dots
 *  and a little air under them. Declared to the frame so the copy above stops
 *  clear of the whole block rather than of the button alone. */
const BLOCK_TAIL = ROW_GAP + DOTS_GAP + 12;

export interface EndingSceneData {
  id: EndingId;
}

/**
 * A story act, told a page at a time.
 *
 * Structurally the intro's twin — both drive `ui/storyPage` — but where the
 * intro always ends in a new run, an act ends wherever its definition says: the
 * King's writ, the shop, the duel it stands in front of, or the Victory screen.
 * The act is marked as seen the moment it is entered rather than when it ends,
 * so a reload part way through resumes at the destination instead of retelling
 * the story.
 */
export class EndingScene extends Phaser.Scene {
  private def!: EndingDef;
  private page = 0;
  private transitioning = false;
  private slideBackdrop: Phaser.GameObjects.GameObject[] = [];
  private frame!: StoryFrame;
  private act!: Phaser.GameObjects.Container;
  /** The page turn in flight, if any. Continue stays live while it runs, and a
   *  press then lands it at once and moves on to the step after it. */
  private turn?: PageTurn;
  /** Where the skip link's slot sits under the button. */
  private rowY = 0;
  /** The skip link and the dots — the parts of the control block that change
   *  with the page. The button is built once and stays put, and live, as pages
   *  turn. */
  private marks: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("Ending");
  }

  init(data?: EndingSceneData): void {
    const def = data?.id ? endingById(data.id) : null;
    // A checkpoint naming an act this build no longer has is not worth failing
    // over — the run is intact, so fall through to wherever the act led.
    this.def = def ?? endingById("peace")!;
    this.page = 0;
    this.transitioning = false;
  }

  create(): void {
    const state = getRun(this.registry);
    markEndingSeen(state, this.def.id);
    saveActiveRun(this.registry, { scene: "Ending", id: this.def.id });
    responsive(this, () => this.build());
    slideSceneIn(this, this.slideBackdrop);
  }

  private build(): void {
    // A resize rebuilds the scene from nothing, pages and all; the page index
    // already names the page being turned to, so draw that one at rest.
    this.turn?.cancel();
    this.turn = undefined;
    this.marks = [];
    this.frame = buildStoryFrame(
      this,
      this.def.pages,
      ENDING_AMBIENCE,
      BLOCK_TAIL,
    );
    this.slideBackdrop = this.frame.backdrop;
    this.act = this.frame.page(this.def.pages[this.page]);
    this.buildControls();
  }

  /** The block under the act. Drawn outside the page's container, so only the
   *  story travels; the dots are redrawn where they stand as the page turns. */
  private buildControls(): void {
    const { blockTop, blockX, blockWidth, blockBottom } = this.frame;

    // The button takes whatever the block has left once the dots are spoken
    // for, so a short viewport shrinks it rather than pushing it off the foot
    // of the screen or into the column beside it. Its label is the same on the
    // last page as on every other: an act ends by being continued out of.
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

    this.rowY = button.y + button.height / 2 + ROW_GAP;
    this.buildMarks();
  }

  /** The skip link, on every page but the last, and the dots under it. */
  private buildMarks(): void {
    for (const mark of this.marks) mark.destroy();
    this.marks = [];

    const { blockX, blockWidth } = this.frame;
    const last = this.def.pages.length - 1;
    if (this.page < last) {
      this.marks.push(
        buildSkipLink(this, blockX, this.rowY, blockWidth, () =>
          this.skipToEnd(),
        ),
      );
    }
    this.marks.push(
      ...buildPageDots(
        this,
        blockX,
        this.rowY + DOTS_GAP,
        this.def.pages.length,
        this.page,
      ),
    );
  }

  /** Continue: turn to the next page, or leave from the last one. Pressed
   *  while a page is still turning, it lands that turn at once and carries on
   *  to the step after it, rather than waiting the animation out. */
  private advance(): void {
    this.turn?.finish();
    if (this.page === this.def.pages.length - 1) this.finish();
    else this.nextPage();
  }

  /** Skip: turn straight to the act's last page, landing any turn in flight
   *  first. The act still ends by Continue from there, so its hand-off is the
   *  same one a reader who turned every page would get. */
  private skipToEnd(): void {
    this.turn?.finish();
    const last = this.def.pages.length - 1;
    if (this.page < last) this.turnTo(last);
  }

  private nextPage(): void {
    this.turnTo(this.page + 1);
  }

  /** Send the current page to the left and bring the one at `page` in from the
   *  right — the intro's page turn, for the same reason: the room and the
   *  controls stay put, and only the act itself moves. */
  private turnTo(page: number): void {
    this.page = page;
    this.turn = turnPage(
      this,
      this.act,
      () => {
        this.act = this.frame.page(this.def.pages[this.page]);
        this.buildMarks();
        return this.act;
      },
      () => {
        this.turn = undefined;
      },
    );
  }

  /** Hand off to whatever the act leads to, saving that as the checkpoint first
   *  so a reload lands past the story rather than back inside it. */
  private finish(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    const state = getRun(this.registry);
    const checkpoint = this.destination(state);
    saveActiveRun(this.registry, checkpoint);
    slideSceneOut(
      this,
      () => this.scene.start(checkpoint.scene, checkpoint),
      this.slideBackdrop,
    );
  }

  private destination(
    state: ReturnType<typeof getRun>,
  ): ResumableCheckpoint & { scene: string } {
    switch (this.def.next) {
      case "Tribute":
        return {
          scene: "Tribute",
          gift: this.def.gift ?? "kingsDemands",
          // Rolled here, once, and carried on the checkpoint: a reload must
          // face the same demands rather than dealing itself a kinder writ.
          choices:
            this.def.gift === "betrayal"
              ? ["betrayal"]
              : rollKingsDemands(
                  state,
                  streamFor(state.seed, "demands", state.trial),
                ),
        };
      case "Shop":
        return createFreshShopCheckpoint(state);
      case "Victory":
        return { scene: "Victory" };
      case "Game":
      default:
        return { scene: "Game", unlocked: [] };
    }
  }
}
