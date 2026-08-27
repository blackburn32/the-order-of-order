import type Phaser from "phaser";
import { newRun, type RunState } from "../state/RunState";
import { DicePool, setBucketThreshold } from "../systems/DicePool";
import {
  ACTIVE_RUN_STORAGE_KEY,
  clearActiveRun,
  createFreshShopCheckpoint,
  hydrateRunState,
  initializeActiveRunStorage,
  restoreActiveRun,
  saveActiveRun,
  serializeRunState,
  type ResumableCheckpoint,
} from "../systems/ActiveRunPersistence";
import { TutorialStage, type TutorialState } from "../systems/Tutorial";
import { installStorage, seedGlobalRandom } from "./localStorageShim";

class TestRegistry {
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    return this.values.get(key);
  }
  set(key: string, value: unknown): this {
    this.values.set(key, value);
    return this;
  }
}

function registry(
  run: RunState,
  tutorial: TutorialState = { active: true, stage: TutorialStage.Shop },
): Phaser.Data.DataManager {
  return new TestRegistry()
    .set("run", run)
    .set("tutorial", tutorial) as unknown as Phaser.Data.DataManager;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`Active-run persistence check failed: ${message}`);
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function populatedRun(): RunState {
  const run = newRun(["prism", "coupon_book", "grindstone"]);
  run.trial = 14;
  run.roll = 17;
  run.endless = true;
  run.bossModifiers = ["hoard"];
  run.boonNextShop = true;
  run.bossesCleared = 4;
  run.trialCleared = true;
  run.score = 1234567890123456789012345678901234567890n;
  run.trialScore = run.score + 1n;
  run.totalScore = run.score * 99n;
  run.gold = 37;
  run.goldEarned = 101;
  run.trialRollGold = { titheBowl: 3, luckyCoin: 2 };
  run.scoringNumbers = [1, 2, 3, 4];
  run.loadedSizes = [6];
  run.wildSizes = [20];
  run.royalSealSizes = [100];
  run.afflictions = ["reckoning", "longNight"];
  run.ownedUnique = ["coupon_book"];
  run.purchases = { prism: 7, coupon_book: 1 };
  run.dicePoints = { starter: run.score, foundry: 999999999999999999999n };
  run.itemPoints = { prism: run.totalScore - run.score };
  run.dice = DicePool.fromStacks([
    {
      sides: 6,
      maxFaceBonus: 0,
      loaded: false,
      wildFace: false,
      source: "starter",
      count: 2_250,
    },
    {
      sides: 20,
      maxFaceBonus: 4,
      loaded: true,
      wildFace: true,
      source: "centurion",
      count: 19,
    },
  ]);
  return run;
}

async function main(): Promise<void> {
  installStorage([]);
  seedGlobalRandom(0x0d0e0f10);

  const fresh = newRun();
  const freshHydrated = hydrateRunState(
    JSON.parse(JSON.stringify(serializeRunState(fresh))),
  );
  check(freshHydrated, "fresh RunState hydrates");
  check(
    stableJson(serializeRunState(freshHydrated)) ===
      stableJson(serializeRunState(fresh)),
    "fresh RunState round-trips exactly",
  );

  const populated = populatedRun();
  const hydrated = hydrateRunState(
    JSON.parse(JSON.stringify(serializeRunState(populated))),
  );
  check(hydrated, "populated RunState hydrates");
  check(hydrated.totalScore === populated.totalScore, "large bigint is exact");
  check(
    stableJson(hydrated.dice.summarize()) ===
      stableJson(populated.dice.summarize()),
    "bucket-backed DicePool summary is exact",
  );

  setBucketThreshold(10_000);
  const listHydrated = hydrateRunState(
    JSON.parse(JSON.stringify(serializeRunState(newRun()))),
  );
  check(
    listHydrated && !listHydrated.dice.bucketed,
    "list-backed DicePool restores as a list",
  );
  setBucketThreshold(2_000);

  const outcome = {
    phase: "advanced" as const,
    completedTrial: 4,
    completedScore: 9_999_999_999_999_999_999n,
    completedGoal: 8_888_888_888_888_888_888n,
    goldEarned: 8,
    goldBreakdown: { base: 1, rolls: 2, interest: 3, items: 2, total: 8 },
    goldForfeited: 0,
    rollGold: { titheBowl: 1, luckyCoin: 1, total: 2 },
    totalGoldEarned: 40,
    diceAdded: 3,
    insuranceUsed: false,
    bossCleared: false,
  };
  const shop = createFreshShopCheckpoint(populated);
  shop.packs[0].sold = true;
  shop.packChoices = shop.offers
    .slice(0, 2)
    .map((offer) => ({ ...offer, cost: 0 }));
  shop.openingPackId = shop.packs[0].id;
  shop.rerollsThisVisit = 2;
  shop.purchasesMade = 1;
  shop.couponFreebieClaimedThisVisit = true;
  shop.pickerOffer = shop.packChoices[0];
  shop.pickedIndices = [0];

  const checkpoints: ResumableCheckpoint[] = [
    { scene: "TrialOverview" },
    { scene: "Game", unlocked: ["prism"] },
    { scene: "TrialResults", outcome, unlocked: ["coupon_book"] },
    shop,
    { scene: "Victory" },
  ];
  const sourceRegistry = registry(populated);
  for (const checkpoint of checkpoints) {
    saveActiveRun(sourceRegistry, checkpoint);
    const restored = restoreActiveRun(registry(newRun()));
    check(restored, `${checkpoint.scene} envelope restores`);
    check(
      stableJson(restored.checkpoint) === stableJson(checkpoint),
      `${checkpoint.scene} checkpoint payload round-trips`,
    );
  }

  localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, "{not json");
  await initializeActiveRunStorage();
  check(!restoreActiveRun(registry(newRun())), "malformed JSON fails safely");
  check(
    !localStorage.getItem(ACTIVE_RUN_STORAGE_KEY),
    "malformed JSON is removed",
  );

  localStorage.setItem(
    ACTIVE_RUN_STORAGE_KEY,
    JSON.stringify({ schema: 999, savedAt: Date.now() }),
  );
  await initializeActiveRunStorage();
  check(!restoreActiveRun(registry(newRun())), "unknown schema fails safely");

  saveActiveRun(sourceRegistry, { scene: "Game", unlocked: [] });
  clearActiveRun();
  check(
    !localStorage.getItem(ACTIVE_RUN_STORAGE_KEY),
    "finalization clears the active run",
  );
  check(
    !restoreActiveRun(registry(newRun())),
    "a finalized run cannot restore",
  );

  console.log("Active-run persistence checks passed.");
}

void main();
