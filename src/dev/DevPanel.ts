import Phaser from "phaser";
import {
  canLoad,
  canShrink,
  DIE_LADDER,
  DieSides,
  makeDie,
} from "../systems/Dice";
import {
  WIN_TRIAL,
  isMirrorTrial,
  rankOf,
  trialInRank,
  trialName,
} from "../config";
import {
  BOSS_MODIFIERS,
  BossModifierId,
  bossesForRank,
  bossModifierCount,
  goalFor,
  rollBossModifiers,
} from "../systems/Boss";
import {
  CHARACTER_ORDER,
  CHARACTERS,
  type CharacterId,
} from "../systems/Characters";
import { DicePool } from "../systems/DicePool";
import { getRun, RunState } from "../state/RunState";
import {
  openTrial,
  prepareDuel,
  setFullBudgetAllTrials,
  trialComplete,
} from "../sim/engine";
import { serializeRunState } from "../systems/ActiveRunPersistence";
import { rankOf as rankOfTrial } from "../config";
import { rivalScore } from "../systems/Rival";
import { trialRollTarget } from "../systems/Trial";
import { formatScore } from "../ui/formatScore";
import type { ItemsData } from "../scenes/ItemsScene";
import {
  ALL_SHOP_ITEM_IDS,
  applyOffer,
  offerFor,
  ShopItemId,
} from "../systems/Shop";

const PRESET_COUNTS = [10, 100, 1000, 1500, 3000, 10000, 100000];

/** The scenes a run is played on. A dev change to the run restarts whichever
 *  of these is showing, so it draws from the changed state. */
const RUN_SCENES = ["Game", "Shop"];

/** How often the run summary at the top of the panel re-reads the run. */
const SUMMARY_REFRESH_MS = 500;

const INPUT_CSS = `width:100%;box-sizing:border-box;margin-top:2px;background:#1a1526;color:#e9d8a6;
  border:1px solid #5a4a2e;border-radius:3px;padding:3px 5px;font:inherit;`;
const LABEL_CSS = "display:block;margin-top:6px;font-size:11px;opacity:.85;";
const RULE = `<hr style="border:none;border-top:1px solid #5a4a2e;margin:10px 0 8px;" />`;

function heading(text: string): string {
  return `<h4 style="margin:0 0 6px;font-size:12px;color:#e6c65a;">${text}</h4>`;
}

/** A panel button. Red commits a change to the run; blue is everything else. */
function button(
  id: string,
  label: string,
  tone: "commit" | "other" = "commit",
): string {
  const bg = tone === "commit" ? "#8a1f2b" : "#1f6b8a";
  return `<button id="${id}" style="margin-top:6px;width:100%;padding:5px;background:${bg};
    color:#e9d8a6;border:none;border-radius:3px;cursor:pointer;font:inherit;font-weight:bold;">
    ${label}</button>`;
}

/**
 * Dev-only overlay (excluded from production builds via `import.meta.env.DEV`)
 * for reshaping the live run — its dice, novice, trial, points, gold and cards —
 * without having to play to the state being tested.
 * Plain HTML/DOM, not a Phaser GameObject: far simpler than wiring up
 * Phaser's DOM Element support for a handful of form controls that never
 * need to appear in the actual game.
 */
export function installDevPanel(game: Phaser.Game): void {
  if (!import.meta.env.DEV) return;

  // Read back before anything renders, so a session that was left measuring is
  // still measuring after a reload rather than silently reverting to real play.
  setFullBudgetAllTrials(fullBudgetPreference());

  const toggle = document.createElement("button");
  toggle.textContent = "DEV ▾";
  toggle.style.cssText = `
    position: fixed; top: 8px; right: 8px; z-index: 1001;
    background: rgba(10,8,16,0.85); color: #e6c65a; border: 1px solid #c9a227;
    border-radius: 4px; padding: 4px 8px; font: 11px system-ui, sans-serif; cursor: pointer;
  `;
  document.body.appendChild(toggle);

  // Scrolls within the viewport rather than running off the bottom of it, so
  // every section stays reachable on a phone. The run summary and the status
  // line stick to its top: an action's result reads there wherever the button
  // that caused it has been scrolled to.
  const panel = document.createElement("div");
  panel.style.cssText = `
    position: fixed; top: 36px; right: 8px; z-index: 1000; width: 220px;
    max-height: calc(100dvh - 44px); overflow-y: auto; overscroll-behavior: contain;
    box-sizing: border-box;
    background: rgba(10,8,16,0.92); color: #e9d8a6; font: 12px/1.4 system-ui, sans-serif;
    border: 1px solid #c9a227; border-radius: 6px; padding: 0 10px 8px;
  `;
  panel.innerHTML = `
    <div style="position:sticky;top:0;z-index:1;margin:0 -10px 6px;padding:6px 10px;
      background:#0a0810;border-bottom:1px solid #5a4a2e;">
      <div id="dp-summary" style="font-size:11px;white-space:pre-line;"></div>
      <div id="dp-status" style="margin-top:3px;font-size:11px;color:#e6c65a;"></div>
    </div>
    ${heading("Trial")}
    <label style="${LABEL_CSS}margin-top:2px;">Points</label>
    <input id="dp-points" type="text" value="0" style="${INPUT_CSS}" />
    <div style="display:flex;gap:4px;margin-top:4px;">
      <button id="dp-points-goal" style="flex:1;padding:3px 6px;background:#3a3050;color:#e9d8a6;
        border:none;border-radius:3px;cursor:pointer;font:11px inherit;">Goal</button>
      <button id="dp-points-under" style="flex:1;padding:3px 6px;background:#3a3050;color:#e9d8a6;
        border:none;border-radius:3px;cursor:pointer;font:11px inherit;">Goal − 1</button>
    </div>
    ${button("dp-set-points", "Set points")}
    ${button("dp-complete", "Complete trial")}
    <label style="${LABEL_CSS}margin-top:10px;">Jump to trial (1-${WIN_TRIAL}, then endless)</label>
    <input id="dp-round" type="number" min="1" max="1000" value="1" style="${INPUT_CSS}" />
    <label style="${LABEL_CSS}">Boss modifier (the rank's Boss Trial)</label>
    <select id="dp-boss" style="${INPUT_CSS}"></select>
    ${button("dp-set-round", "Go to its trial overview")}
    ${RULE}
    ${heading("Cards")}
    ${button("dp-pick", "Open card picker")}
    ${button("dp-grant-all", "Grant ALL cards (free)", "other")}
    ${RULE}
    ${heading("Gold")}
    <input id="dp-gold" type="number" min="0" max="9999" value="20" style="${INPUT_CSS}" />
    ${button("dp-set-gold", "Set gold")}
    ${RULE}
    ${heading("Dice Setup")}
    <label style="${LABEL_CSS}margin-top:2px;">Dice count</label>
    <input id="dp-count" type="number" min="0" max="1000000" value="6" style="${INPUT_CSS}" />
    <div id="dp-presets" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;"></div>
    <label style="${LABEL_CSS}margin-top:8px;">Die type</label>
    <select id="dp-type" style="${INPUT_CSS}">
      <option value="mixed">Mixed (cycle all types)</option>
      <option value="random">Random per die</option>
      ${DIE_LADDER.map((s) => `<option value="${s}">d${s}</option>`).join("")}
    </select>
    <label style="display:flex;align-items:center;gap:5px;margin-top:8px;font-size:11px;opacity:.85;">
      <input id="dp-bonus" type="checkbox" style="margin:0;" />
      Max-face bonus (Rollplayer/Centurion)
    </label>
    ${button("dp-apply", "Apply")}
    ${RULE}
    ${heading("Novice")}
    <select id="dp-character" style="${INPUT_CSS}">
      ${CHARACTER_ORDER.map(
        (id) => `<option value="${id}">${CHARACTERS[id].name}</option>`,
      ).join("")}
    </select>
    ${button("dp-set-character", "Switch novice")}
    ${RULE}
    ${heading("Measurement")}
    <label style="display:flex;align-items:flex-start;gap:5px;margin-top:4px;font-size:11px;opacity:.85;">
      <input id="dp-full-budget" type="checkbox" style="margin:2px 0 0;" />
      <span>Play every trial to full budget<br />
        <span style="opacity:.6;">Trials never stop at the goal. No unused-roll gold.</span></span>
    </label>
    ${button("dp-export-run", "Export run (JSON)", "other")}
  `;
  document.body.appendChild(panel);
  // Typing into the panel is not playing the game: keep keys away from
  // Phaser's window-level keyboard listener (and from the ` toggle below).
  panel.addEventListener("keydown", (e) => e.stopPropagation());

  const presetsEl = panel.querySelector("#dp-presets") as HTMLDivElement;
  const countInput = panel.querySelector("#dp-count") as HTMLInputElement;
  const typeSelect = panel.querySelector("#dp-type") as HTMLSelectElement;
  const bonusCheckbox = panel.querySelector("#dp-bonus") as HTMLInputElement;
  const pointsInput = panel.querySelector("#dp-points") as HTMLInputElement;
  const roundInput = panel.querySelector("#dp-round") as HTMLInputElement;
  const goldInput = panel.querySelector("#dp-gold") as HTMLInputElement;
  const characterSelect = panel.querySelector(
    "#dp-character",
  ) as HTMLSelectElement;
  const bossSelect = panel.querySelector("#dp-boss") as HTMLSelectElement;
  const fullBudgetCheckbox = panel.querySelector(
    "#dp-full-budget",
  ) as HTMLInputElement;
  const summary = panel.querySelector("#dp-summary") as HTMLDivElement;
  const status = panel.querySelector("#dp-status") as HTMLDivElement;

  const refreshSummary = () => {
    summary.textContent = runSummary(game);
  };
  const report = (msg: string) => {
    status.textContent = msg;
    refreshSummary();
  };
  const on = (id: string, handler: () => void) =>
    panel.querySelector(`#${id}`)!.addEventListener("click", handler);

  {
    const random = document.createElement("option");
    random.value = "";
    random.textContent = "(random)";
    bossSelect.appendChild(random);
    for (const boss of BOSS_MODIFIERS) {
      const opt = document.createElement("option");
      opt.value = boss.id;
      opt.textContent = boss.name;
      bossSelect.appendChild(opt);
    }
  }

  on("dp-points-goal", () => {
    pointsInput.value = String(currentTarget(game) ?? 0n);
  });
  on("dp-points-under", () => {
    const target = currentTarget(game) ?? 0n;
    pointsInput.value = String(target > 0n ? target - 1n : 0n);
  });
  on("dp-set-points", () => {
    const points = parseScoreInput(pointsInput.value);
    report(
      points === null
        ? `Bad points "${pointsInput.value}" — use an integer or e.g. 1.5e35.`
        : setPoints(game, points),
    );
  });
  on("dp-complete", () => report(completeTrial(game)));

  on("dp-set-round", () => {
    const trial = Math.max(1, Math.floor(Number(roundInput.value) || 1));
    const boss = (bossSelect.value || null) as BossModifierId | null;
    report(jumpToTrial(game, trial, boss));
  });

  on("dp-set-character", () =>
    report(setCharacter(game, characterSelect.value as CharacterId)),
  );

  on("dp-set-gold", () => {
    const gold = Math.max(0, Math.floor(Number(goldInput.value) || 0));
    report(setGold(game, gold));
  });

  on("dp-pick", () => report(openCardPicker(game, report)));
  on("dp-grant-all", () => report(grantAllItems(game)));

  fullBudgetCheckbox.checked = fullBudgetPreference();
  fullBudgetCheckbox.addEventListener("change", () => {
    const enabled = fullBudgetCheckbox.checked;
    setFullBudgetPreference(enabled);
    report(
      enabled
        ? "Trials now play their whole roll budget out."
        : "Trials end at the goal again.",
    );
  });

  on("dp-export-run", () => void exportRun(game, report));

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

  on("dp-apply", () => {
    const count = Math.max(0, Math.floor(Number(countInput.value) || 0));
    applyDiceSetup(game, count, typeSelect.value, bonusCheckbox.checked);
    report(
      `Set ${count} dice (${typeSelect.options[typeSelect.selectedIndex].text}).`,
    );
  });

  // The summary follows the run as it is played, but only while it is on show.
  let summaryTimer: number | undefined;
  let visible = true;
  const applyVisibility = () => {
    panel.style.display = visible ? "block" : "none";
    toggle.textContent = visible ? "DEV ▾" : "DEV ▸";
    window.clearInterval(summaryTimer);
    summaryTimer = undefined;
    if (!visible) return;
    // Opened onto the novice, trial and points the run actually holds, so each
    // control reads as a current setting rather than as a proposal.
    const state = liveRun(game);
    if (state) {
      characterSelect.value = state.character;
      roundInput.value = String(state.trial);
      pointsInput.value = String(state.score);
    }
    refreshSummary();
    summaryTimer = window.setInterval(refreshSummary, SUMMARY_REFRESH_MS);
  };
  applyVisibility();
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

/** The run in the registry, if one has been dealt. Unlike `getRun`, never deals
 *  one: the summary polls this from the menu, where there is no run to read. */
function liveRun(game: Phaser.Game): RunState | undefined {
  return game.registry.get("run") as RunState | undefined;
}

/** What the trial being played is scored against: its goal, or in the duel the
 *  Order of Disorder's total. */
function currentTarget(game: Phaser.Game): bigint | undefined {
  const state = liveRun(game);
  if (!state) return undefined;
  return isMirrorTrial(state.trial) ? rivalScore(state) : goalFor(state);
}

/** The panel's header: where the run stands, in the HUD's own figures. */
function runSummary(game: Phaser.Game): string {
  const state = liveRun(game);
  if (!state) return "No run.";
  const duel = isMirrorTrial(state.trial);
  const target = currentTarget(game) ?? 0n;
  const scene = activeSceneKeys(game).join(", ");
  return (
    `Trial ${state.trial} (${rankOf(state.trial)}-${trialInRank(state.trial)}) · ` +
    `roll ${state.roll}/${trialRollTarget(state)} · ${state.gold}g\n` +
    `${formatScore(state.score)} / ${duel ? "rival " : ""}${formatScore(target)}` +
    `${state.trialCleared ? " · cleared" : ""}\n` +
    `Scene: ${scene || "—"}`
  );
}

/** Parse a dev-entered score: a decimal integer (separators allowed, so the
 *  HUD's own "1,234,567" pastes), or `<mantissa>e<exp>` shorthand as the HUD
 *  prints large ones (`1e35`, `1.23e35`), expanded into a bigint. Returns null
 *  on anything else. */
function parseScoreInput(raw: string): bigint | null {
  const s = raw.trim().replace(/[,_\s]/g, "");
  const sci = /^(\d+)(?:\.(\d+))?e\+?(\d+)$/i.exec(s);
  if (sci) {
    const fraction = sci[2] ?? "";
    const digits = BigInt(sci[1] + fraction);
    const exp = Number(sci[3]) - fraction.length;
    return exp >= 0
      ? digits * 10n ** BigInt(exp)
      : digits / 10n ** BigInt(-exp);
  }
  if (/^\d+$/.test(s)) return BigInt(s);
  return null;
}

// ---- scene helpers ---------------------------------------------------------

function activeSceneKeys(game: Phaser.Game): string[] {
  return game.scene.getScenes(true).map((scene) => scene.scene.key);
}

/** Restart whichever run scene is showing so the change renders. */
function refreshActiveScene(game: Phaser.Game): void {
  for (const key of RUN_SCENES) {
    if (game.scene.isActive(key)) game.scene.getScene(key).scene.restart();
  }
}

/** Leave everything on screen — overlays, paused and sleeping scenes included —
 *  for `key`, as though the game had routed there itself. */
function goToScene(game: Phaser.Game, key: string, data?: object): void {
  for (const scene of game.scene.getScenes(false)) {
    const sys = scene.sys;
    if (sys.isActive() || sys.isPaused() || sys.isSleeping()) {
      game.scene.stop(scene.scene.key);
    }
  }
  game.scene.start(key, data);
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
    // The removal cards refuse to empty the grid, so there must be something
    // left behind: another die, or another size.
    case "dismissal":
      return state.dice.length > 1 ? { index: state.dice.length - 1 } : null;
    case "winnowing":
      return Object.keys(state.dice.sizeCounts()).length > 1
        ? { index: state.dice.length - 1 }
        : null;
    default:
      return {}; // no target needed
  }
}

/**
 * Put the run on the Trial Overview in front of `trial`, as though the ladder
 * had just landed there: the trial's state is reset the way `resolveTrialEnd`
 * resets it on advance, and the rank gets its modifiers the way a real rank
 * does, so the overview previews it and Begin plays it — story beat included.
 * `boss` forces one of the rank's modifiers; null rolls them all. Returns a
 * status message.
 */
function jumpToTrial(
  game: Phaser.Game,
  trial: number,
  boss: BossModifierId | null,
): string {
  const state = getRun(game.registry);
  state.trial = trial;
  state.roll = 0;
  state.score = 0n;
  state.trialScore = 0n;
  state.trialCleared = false;
  state.trialRollGold = { titheBowl: 0, luckyCoin: 0, offering: 0 };
  state.bonusRollsThisRound = 0;
  // Opened like any trial the ladder lands on, so the trial-start passives
  // (The Inner Circle, A Full Choir) can be tested by jumping.
  state.trialOpenPending = true;
  // Past the final rank the ladder only continues for an endless run, so a jump
  // there implies one — otherwise the very first resolve would declare victory.
  if (trial > WIN_TRIAL) state.endless = true;
  // A fresh roll, as on a rank's Lesser Trial. The duel's rank rolls nothing,
  // and a forced modifier has nowhere to go there either.
  state.bossModifiers = bossesForRank(state, trial);
  if (boss && state.bossModifiers.length > 0) {
    state.bossModifiers = [
      boss,
      ...rollBossModifiers(bossModifierCount(state) - 1, Math.random, [boss]),
    ];
  }
  // The mirror is stood up from the grid as it is now; one from an earlier
  // duel is not this one.
  state.rival = null;
  prepareDuel(state);
  game.registry.set("run", state);
  goToScene(game, "TrialOverview");
  const names = state.bossModifiers
    .map((id) => BOSS_MODIFIERS.find((b) => b.id === id)?.name ?? id)
    .join(", ");
  return `Before trial ${trial} — rank ${rankOf(trial)} ${trialName(trial)}${names ? ` (${names})` : ""}.`;
}

/**
 * Set the trial's points outright. Crossing the goal this way does not end the
 * trial: the engine only notices a clear as a roll resolves, so the next roll
 * ends it — which is the way to test a clear with a specific roll count spent.
 */
function setPoints(game: Phaser.Game, points: bigint): string {
  const state = getRun(game.registry);
  state.score = points;
  if (points > state.trialScore) state.trialScore = points;
  game.registry.set("run", state);
  refreshActiveScene(game);
  const target = currentTarget(game) ?? 0n;
  const duel = isMirrorTrial(state.trial);
  const over = points >= target;
  return (
    `Points set to ${formatScore(points)}.` +
    (over && !duel ? " At the goal: the next roll clears the trial." : "")
  );
}

/**
 * Clear the trial being played and hand it to the table to resolve, exactly as
 * a winning roll would: the Game scene resolves a trial it finds already
 * complete on entry, so the payout, the results screen and the shop that
 * follow are the real ones. Works from the table or from the Trial Overview in
 * front of it; anywhere else there is no trial in hand to complete.
 */
function completeTrial(game: Phaser.Game): string {
  const scenes = activeSceneKeys(game);
  if (!scenes.includes("Game") && !scenes.includes("TrialOverview")) {
    return "No trial in hand — use this on the table or its overview.";
  }
  const state = getRun(game.registry);
  // The trial-start passives run as the table opens. A trial completed before
  // that still gets them, so its payout reads the grid it would have played.
  openTrial(state);
  if (isMirrorTrial(state.trial)) {
    // The duel is won by being ahead when the rolls run out.
    const rival = rivalScore(state);
    if (state.score <= rival) state.score = rival + 1n;
  } else {
    const goal = goalFor(state);
    if (state.score < goal) state.score = goal;
    state.trialCleared = true;
  }
  if (state.score > state.trialScore) state.trialScore = state.score;
  // The duel, and a full-budget measuring session, only end on the last roll.
  if (!trialComplete(state)) state.roll = trialRollTarget(state);
  game.registry.set("run", state);
  // Read before the table resolves the trial and moves the ladder on.
  const done = `Completed trial ${state.trial} with ${formatScore(state.score)}.`;
  goToScene(game, "Game", { unlocked: [] });
  return done;
}

/**
 * Swap the run's novice mid-run, for testing a character's rules without
 * playing to them from the selection screen.
 *
 * Deliberately NOT what the game does — a run is played as one novice from its
 * first roll, and nothing in the rules lets it change hands. So the two pieces
 * of state a character seeds rather than merely governs have to be re-seeded
 * here by hand: the grid's ceiling, which the pool was built with, and the
 * purse, which is only ever set once at `newRun`. Everything else (the shop
 * discount, the size storm) is read live off the id and needs nothing.
 */
function setCharacter(game: Phaser.Game, id: CharacterId): string {
  const state = getRun(game.registry);
  const who = CHARACTERS[id];
  state.character = id;
  state.dice.setCeiling(who.gridCeiling);
  // The purse is re-seeded only while the run has not really begun, so switching
  // on trial 1 shows the character's true opening and switching later does not
  // hand the player a fresh one.
  if (state.trial === 1 && state.roll === 0 && state.rollsTaken === 0) {
    state.gold = who.startingGold;
    state.goldEarned = who.startingGold;
    state.peakGold = who.startingGold;
  }
  game.registry.set("run", state);
  refreshActiveScene(game);
  const over =
    state.dice.length > who.gridCeiling
      ? ` Grid holds ${state.dice.length}, over the ceiling — it will not grow, and nothing is culled.`
      : "";
  return `Playing as ${who.name}.${over}`;
}

/** Set the run's purse outright, for testing the shop without playing to it. */
function setGold(game: Phaser.Game, gold: number): string {
  const state = getRun(game.registry);
  state.gold = gold;
  if (gold > state.peakGold) state.peakGold = gold;
  game.registry.set("run", state);
  refreshActiveScene(game);
  return `Set gold to ${gold}.`;
}

/** Grant one shop item to the run for free, auto-targeting dice where the item
 *  would normally prompt. Leaves redrawing to the caller. Returns why it could
 *  not be granted, or null once it has been. */
function grantItem(state: RunState, id: ShopItemId): string | null {
  const offer = { ...offerFor(id, state), cost: 0 };
  const targets = autoTargets(state, id);
  if (!targets) return "No eligible die";
  if (!applyOffer(state, offer, targets.index, targets.indices)) {
    return "Its conditions aren't met";
  }
  return null;
}

/**
 * Open the Codex as a card picker over whatever is showing: every card, tap to
 * grant it, tap again for another copy. The scene underneath is redrawn once
 * the picker closes, rather than under it on every tap. Returns a status
 * message; `report` hears the tally when the picker closes.
 */
function openCardPicker(
  game: Phaser.Game,
  report: (msg: string) => void,
): string {
  // One picker at a time, and never one stacked on the Codex it is made from.
  for (const key of ["ItemAnalysis", "Items"]) {
    if (game.scene.isActive(key)) game.scene.stop(key);
  }
  const base = game.scene.getScenes(true, true)[0];
  if (!base) return "Nothing on screen to open the picker over.";

  const state = getRun(game.registry);
  const owned = (id: ShopItemId) => state.purchases[id] ?? 0;
  let granted = 0;
  const data: ItemsData = {
    returnTo: base.scene.key,
    picker: {
      title: "Grant Cards",
      caption: (id) => `Owned ${owned(id)} · tap to grant`,
      copies: owned,
      onPick: (id) => {
        const refused = grantItem(state, id);
        if (refused) return refused;
        granted++;
        game.registry.set("run", state);
        return `Granted · owned ${owned(id)}`;
      },
      onClose: () => {
        if (granted > 0) refreshActiveScene(game);
        report(`Granted ${granted} card${granted === 1 ? "" : "s"}.`);
      },
    },
  };
  game.scene.start("Items", data);
  return "Tap a card to grant it; tap again for another copy.";
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
    if (grantItem(state, id)) {
      skipped.push(offerFor(id, state).name);
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

// ---- measurement helpers ---------------------------------------------------

/** Where the full-budget toggle remembers itself. Not part of the game's own
 *  settings: it is a dev instrument, and a production build never reads it. */
const FULL_BUDGET_KEY = "the-order-of-order.dev.full-budget";

function fullBudgetPreference(): boolean {
  try {
    return localStorage.getItem(FULL_BUDGET_KEY) === "1";
  } catch {
    return false;
  }
}

function setFullBudgetPreference(enabled: boolean): void {
  setFullBudgetAllTrials(enabled);
  try {
    if (enabled) localStorage.setItem(FULL_BUDGET_KEY, "1");
    else localStorage.removeItem(FULL_BUDGET_KEY);
  } catch {
    // Private-mode storage. The toggle still applies to this session.
  }
}

/** The exported envelope. `run` is exactly what the active-run save writes, so
 *  `hydrateRunState` reads a fixture and a save through the same door — see
 *  sim/importRun.ts. The rest is there for a human reading the file. */
interface ExportedRun {
  kind: "the-order-of-order.run-fixture";
  version: 1;
  exportedAt: number;
  label: string;
  run: ReturnType<typeof serializeRunState>;
}

function fixtureLabel(state: RunState): string {
  const rank = rankOfTrial(state.trial);
  return `trial-${state.trial}-rank-${rank}-roll-${state.roll}`;
}

/**
 * Write the live run out as a balance fixture: to the clipboard, and as a file
 * the browser downloads. Two routes because the clipboard fails silently on an
 * unfocused page and the download fails silently when downloads are blocked;
 * between them one of the two always lands.
 */
async function exportRun(
  game: Phaser.Game,
  report: (msg: string) => void,
): Promise<void> {
  const state = getRun(game.registry);
  const label = fixtureLabel(state);
  const payload: ExportedRun = {
    kind: "the-order-of-order.run-fixture",
    version: 1,
    exportedAt: Date.now(),
    label,
    run: serializeRunState(state),
  };
  const json = JSON.stringify(payload, null, 2);

  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${label}.json`;
  link.click();
  URL.revokeObjectURL(url);

  let copied = false;
  try {
    await navigator.clipboard.writeText(json);
    copied = true;
  } catch {
    // No clipboard permission, or the page is not focused. The download stands.
  }
  report(
    `Exported ${label}.json (${state.dice.length} dice, ${state.gold}g)` +
      (copied ? " — also on the clipboard." : "."),
  );
}
