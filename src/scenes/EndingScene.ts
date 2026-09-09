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
import { bannerButton } from "../ui/widgets";
import { streamFor } from "../systems/Rng";

/** Fixed sigil brightness for the backdrop. Set at the top of the range rather
 *  than the intro's dim margin light: these are the screens where the Order's
 *  work has just landed, and the room should read as answering it. */
const ENDING_AMBIENCE = 0.8;

/** Air under the button, before the dots. */
const DOTS_GAP = 24;
/** What the control block needs below its button: the gap, the dots and a
 *  little air under them. Declared to the frame so the copy above stops clear
 *  of the whole block rather than of the button alone. */
const BLOCK_TAIL = DOTS_GAP + 12;

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
  /** The button and the dots — the block that holds its place as pages turn. */
  private controls: Phaser.GameObjects.GameObject[] = [];

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

  /** The block under the act. Drawn outside the page's container and redrawn
   *  where it stands as the page turns, so only the story travels. */
  private buildControls(): void {
    for (const control of this.controls) control.destroy();
    this.controls = [];

    const { blockTop, blockX, blockWidth, blockBottom } = this.frame;
    const last = this.page === this.def.pages.length - 1;

    // The button takes whatever the block has left once the dots are spoken
    // for, so a short viewport shrinks it rather than pushing it off the foot
    // of the screen or into the column beside it.
    const label = last ? this.def.button : STORY_BUTTONS.continue;
    const button = bannerButton(
      this,
      blockX,
      0,
      label,
      () => {
        if (last) this.finish();
        else this.nextPage();
      },
      blockWidth,
      Math.max(1, blockBottom - blockTop - BLOCK_TAIL),
    );
    button.y = blockTop + button.height / 2;
    this.controls.push(button);

    this.controls.push(
      ...buildPageDots(
        this,
        blockX,
        button.y + button.height / 2 + DOTS_GAP,
        this.def.pages.length,
        this.page,
      ),
    );
  }

  /** Send the current page to the left and bring the next one in from the
   *  right — the intro's page turn, for the same reason: the room and the
   *  controls stay put, and only the act itself moves. */
  private nextPage(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    const outgoing = this.act;
    slideObjectsOut(
      this,
      [outgoing],
      () => {
        outgoing.destroy();
        this.page += 1;
        this.act = this.frame.page(this.def.pages[this.page]);
        this.buildControls();
        // slideObjectsOut disables input before invoking its completion. Re-arm
        // it so slideObjectsIn can own the incoming page's lock and restore it.
        this.input.enabled = true;
        slideObjectsIn(
          this,
          [this.act],
          () => {
            this.transitioning = false;
          },
          PAGE_TURN,
        );
      },
      PAGE_TURN,
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
