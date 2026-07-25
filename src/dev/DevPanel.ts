import Phaser from "phaser";
import {
  canLoad,
  canShrink,
  DIE_LADDER,
  DieSides,
  makeDie,
} from "../systems/Dice";
import { DicePool } from "../systems/DicePool";
import { getRun, RunState } from "../state/RunState";
import {
  ALL_SHOP_ITEM_IDS,
  applyOffer,
  offerFor,
  ShopItemId,
} from "../systems/Shop";
import {
  fetchTopScores,
  getInitials,
  globalScoresEnabled,
  submitScore,
} from "../systems/GlobalScores";
import { scoreToWireOrdinal } from "../systems/LeaderboardWire";

const PRESET_COUNTS = [10, 100, 1000, 1500, 3000, 10000, 100000];

/**
 * Dev-only overlay (excluded from production builds via `import.meta.env.DEV`)
 * for setting the run's dice count/composition instantly, without having to
 * play through the shop — mainly for testing grid rendering at scale.
 * Plain HTML/DOM, not a Phaser GameObject: far simpler than wiring up
 * Phaser's DOM Element support for a handful of form controls that never
 * need to appear in the actual game.
 */
export function installDevPanel(game: Phaser.Game): void {
  if (!import.meta.env.DEV) return;

  const toggle = document.createElement("button");
  toggle.textContent = "DEV ▾";
  toggle.style.cssText = `
    position: fixed; top: 8px; right: 8px; z-index: 1001;
    background: rgba(10,8,16,0.85); color: #e6c65a; border: 1px solid #c9a227;
    border-radius: 4px; padding: 4px 8px; font: 11px system-ui, sans-serif; cursor: pointer;
  `;
  document.body.appendChild(toggle);

  const panel = document.createElement("div");
  panel.style.cssText = `
    position: fixed; top: 36px; right: 8px; z-index: 1000; width: 220px;
    background: rgba(10,8,16,0.92); color: #e9d8a6; font: 12px/1.4 system-ui, sans-serif;
    border: 1px solid #c9a227; border-radius: 6px; padding: 8px 10px;
  `;
  panel.innerHTML = `
    <h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">Dice Setup</h4>
    <label style="display:block;margin-top:6px;font-size:11px;opacity:.85;">Dice count</label>
    <input id="dp-count" type="number" min="0" max="1000000" value="6"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;" />
    <div id="dp-presets" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;"></div>
    <label style="display:block;margin-top:8px;font-size:11px;opacity:.85;">Die type</label>
    <select id="dp-type"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;">
      <option value="mixed">Mixed (cycle all types)</option>
      <option value="random">Random per die</option>
      ${DIE_LADDER.map((s) => `<option value="${s}">d${s}</option>`).join("")}
    </select>
    <label style="display:flex;align-items:center;gap:5px;margin-top:8px;font-size:11px;opacity:.85;">
      <input id="dp-bonus" type="checkbox" style="margin:0;" />
      Max-face bonus (Rollplayer/Centurion)
    </label>
    <button id="dp-apply" style="margin-top:8px;width:100%;padding:5px;background:#8a1f2b;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Apply
    </button>
    <hr style="border:none;border-top:1px solid #5a4a2e;margin:10px 0 8px;" />
    <h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">Set Round</h4>
    <label style="display:block;margin-top:2px;font-size:11px;opacity:.85;">Round number</label>
    <input id="dp-round" type="number" min="1" max="1000" value="1"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;" />
    <button id="dp-set-round" style="margin-top:8px;width:100%;padding:5px;background:#8a1f2b;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Set (restarts round)
    </button>
    <hr style="border:none;border-top:1px solid #5a4a2e;margin:10px 0 8px;" />
    <h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">Grant Item</h4>
    <select id="dp-item"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;"></select>
    <button id="dp-grant" style="margin-top:8px;width:100%;padding:5px;background:#8a1f2b;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Grant (free)
    </button>
    <button id="dp-grant-all" style="margin-top:6px;width:100%;padding:5px;background:#1f6b8a;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Grant ALL items (free)
    </button>
    <hr style="border:none;border-top:1px solid #5a4a2e;margin:10px 0 8px;" />
    <h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">Leaderboard Test</h4>
    <label style="display:block;margin-top:2px;font-size:11px;opacity:.85;">Score (int or 1e35)</label>
    <input id="dp-lb-score" type="text" value="1e35"
      style="width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
             border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;" />
    <button id="dp-lb-submit" style="margin-top:8px;width:100%;padding:5px;background:#1f6b8a;
      color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
      Submit &amp; read back
    </button>
    <div id="dp-status" style="margin-top:6px;font-size:11px;opacity:.75;"></div>
  `;
  document.body.appendChild(panel);

  const presetsEl = panel.querySelector("#dp-presets") as HTMLDivElement;
  const countInput = panel.querySelector("#dp-count") as HTMLInputElement;
  const typeSelect = panel.querySelector("#dp-type") as HTMLSelectElement;
  const bonusCheckbox = panel.querySelector("#dp-bonus") as HTMLInputElement;
  const roundInput = panel.querySelector("#dp-round") as HTMLInputElement;
  const itemSelect = panel.querySelector("#dp-item") as HTMLSelectElement;
  const lbScoreInput = panel.querySelector("#dp-lb-score") as HTMLInputElement;
  const status = panel.querySelector("#dp-status") as HTMLDivElement;

  // Item names come from `offerFor`; the argument state only affects a couple
  // of *descriptions*, never the names, so a throwaway current state is fine.
  const nameState = getRun(game.registry);
  for (const id of ALL_SHOP_ITEM_IDS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = offerFor(id, nameState).name;
    itemSelect.appendChild(opt);
  }

  panel.querySelector("#dp-set-round")!.addEventListener("click", () => {
    const round = Math.max(1, Math.floor(Number(roundInput.value) || 1));
    status.textContent = setRound(game, round);
  });

  panel.querySelector("#dp-grant")!.addEventListener("click", () => {
    status.textContent = grantItem(game, itemSelect.value as ShopItemId);
  });

  panel.querySelector("#dp-grant-all")!.addEventListener("click", () => {
    status.textContent = grantAllItems(game);
  });

  panel.querySelector("#dp-lb-submit")!.addEventListener("click", () => {
    void submitLeaderboardTest(lbScoreInput.value, (msg) => {
      status.textContent = msg;
    });
  });

  for (const n of PRESET_COUNTS) {
    const b = document.createElement("button");
    b.textContent = String(n);
    b.style.cssText = `
      flex: 1 1 auto; padding: 3px 6px; background: #3a3050; color: #e9d8a6;
      border: none; border-radius: 3px; cursor: pointer; font: 11px inherit;
    `;
    b.onclick = () => {
      countInput.value = String(n);
    };
    presetsEl.appendChild(b);
  }

  typeSelect.value = "6";

  panel.querySelector("#dp-apply")!.addEventListener("click", () => {
    const count = Math.max(0, Math.floor(Number(countInput.value) || 0));
    applyDiceSetup(game, count, typeSelect.value, bonusCheckbox.checked);
    status.textContent = `Set ${count} dice (${typeSelect.options[typeSelect.selectedIndex].text}).`;
  });

  let visible = true;
  const applyVisibility = () => {
    panel.style.display = visible ? "block" : "none";
    toggle.textContent = visible ? "DEV ▾" : "DEV ▸";
  };
  toggle.onclick = () => {
    visible = !visible;
    applyVisibility();
  };
  window.addEventListener("keydown", (e) => {
    if (e.key === "`") {
      visible = !visible;
      applyVisibility();
    }
  });
}

/** Parse a dev-entered score: a plain decimal integer, or `<mantissa>e<exp>`
 *  shorthand (e.g. `1e35`, `25e30`) expanded losslessly into a bigint. Returns
 *  null on anything else. */
function parseScoreInput(raw: string): bigint | null {
  const s = raw.trim();
  const sci = /^(\d+)e(\d+)$/i.exec(s);
  if (sci) return BigInt(sci[1]) * 10n ** BigInt(sci[2]);
  if (/^\d+$/.test(s)) return BigInt(s);
  return null;
}

/** Submit a large score to the live LootLocker board under the current initials,
 *  then read the top back and report where our exact value landed — a manual
 *  end-to-end check that the int64 ordinal projection round-trips. Reports each
 *  stage through `report` so the async progress is visible in the panel. */
async function submitLeaderboardTest(
  raw: string,
  report: (msg: string) => void,
): Promise<void> {
  const score = parseScoreInput(raw);
  if (score === null) {
    report(`Bad score "${raw}" — use an integer or e.g. 1e35.`);
    return;
  }
  if (!globalScoresEnabled()) {
    report("Leaderboard disabled (LootLocker keys not configured).");
    return;
  }
  const wire = scoreToWireOrdinal(score);
  report(`Submitting ${score.toString()} (wire ${wire.toString()})…`);

  const ok = await submitScore(score, getInitials() || "DEV", {}, {}, false);
  if (!ok) {
    report(`Submit FAILED for ${score.toString()} (wire ${wire.toString()}).`);
    return;
  }

  const rows = await fetchTopScores();
  if (!rows) {
    report("Submitted OK, but read-back failed (network/disabled).");
    return;
  }
  const mine = rows.find((r) => r.isYou && r.score === score);
  if (mine) {
    report(
      `OK: rank #${mine.rank}, exact score ${mine.score.toString()} round-tripped (wire ${wire.toString()}).`,
    );
  } else {
    const top = rows[0];
    report(
      `Submitted (wire ${wire.toString()}). Exact row not in top ${rows.length}` +
        (top ? `; current #1 is ${top.score.toString()}.` : "."),
    );
  }
}

/** Restart whichever gameplay scene is showing so the granted change renders. */
function refreshActiveScene(game: Phaser.Game): void {
  const active = game.scene.getScenes(true)[0];
  if (active && (active.scene.key === "Game" || active.scene.key === "Shop")) {
    active.scene.restart();
  }
}

/** Auto-pick eligible die target(s) for an item that normally prompts the
 *  player, so the dev panel can grant it without the shop's picker UI. */
function autoTargets(
  state: RunState,
  id: ShopItemId,
): { index?: number; indices?: number[] } | null {
  switch (id) {
    case "shrink": {
      const i = state.dice.findIndex(canShrink);
      return i === -1 ? null : { index: i };
    }
    case "loaded_die": {
      const i = state.dice.findIndex(canLoad);
      return i === -1 ? null : { index: i };
    }
    case "twin":
    case "wild_face":
      return state.dice.length === 0 ? null : { index: 0 };
    case "royal_seal": {
      const i = state.dice.findIndex(
        (die) => !state.royalSealSizes.includes(die.sides),
      );
      return i === -1 ? null : { index: i };
    }
    case "grindstone": {
      // Size-wide shrink now: one shrinkable die names the size.
      const i = state.dice.findIndex(canShrink);
      return i === -1 ? null : { index: i };
    }
    default:
      return {}; // no target needed
  }
}

/** Jump the run to a given round, restarting it fresh (roll/score reset) so
 *  the round can be played from the top — mainly for testing the win at
 *  WIN_ROUND without grinding through every round. Returns a status message. */
function setRound(game: Phaser.Game, round: number): string {
  const state = getRun(game.registry);
  state.round = round;
  state.roll = 0;
  state.score = 0n;
  state.bonusRollsThisRound = 0;
  game.registry.set("run", state);
  refreshActiveScene(game);
  return `Set to round ${round} (roll/score reset).`;
}

/** Grant any shop item to the current run for free, auto-targeting dice where
 *  the item would normally prompt. Returns a status message. */
function grantItem(game: Phaser.Game, id: ShopItemId): string {
  const state = getRun(game.registry);
  const offer = { ...offerFor(id, state), cost: 0n };

  const targets = autoTargets(state, id);
  if (!targets) return `No eligible die to target for ${offer.name}.`;

  if (!applyOffer(state, offer, targets.index, targets.indices)) {
    return `Could not grant ${offer.name} (item's own conditions not met).`;
  }

  game.registry.set("run", state);
  refreshActiveScene(game);
  return `Granted ${offer.name}.`;
}

/** Grant every shop item to the current run for free in one pass. Iterates in
 *  ITEMS order so Two Bricks seeds the grid before target-consuming items run,
 *  auto-targeting each against the live (mutating) state. Skips items whose own
 *  conditions can't be met. Refreshes the scene once at the end. Returns a
 *  status message with the granted/skipped tally. */
function grantAllItems(game: Phaser.Game): string {
  const state = getRun(game.registry);
  let granted = 0;
  const skipped: string[] = [];

  for (const id of ALL_SHOP_ITEM_IDS) {
    const offer = { ...offerFor(id, state), cost: 0n };
    const targets = autoTargets(state, id);
    if (!targets || !applyOffer(state, offer, targets.index, targets.indices)) {
      skipped.push(offer.name);
      continue;
    }
    granted++;
  }

  game.registry.set("run", state);
  refreshActiveScene(game);
  const tail = skipped.length ? ` Skipped: ${skipped.join(", ")}.` : "";
  return `Granted ${granted} item${granted === 1 ? "" : "s"}.${tail}`;
}

function applyDiceSetup(
  game: Phaser.Game,
  count: number,
  type: string,
  maxFaceBonus: boolean,
): void {
  const state = getRun(game.registry);

  const dice = [];
  for (let i = 0; i < count; i++) {
    let sides: DieSides;
    if (type === "mixed") {
      sides = DIE_LADDER[i % DIE_LADDER.length];
    } else if (type === "random") {
      sides = DIE_LADDER[Math.floor(Math.random() * DIE_LADDER.length)];
    } else {
      sides = Number(type) as DieSides;
    }
    dice.push(makeDie(sides, { maxFaceBonus }));
  }
  state.dice = DicePool.fromDice(dice);
  game.registry.set("run", state);
  refreshActiveScene(game);
}
