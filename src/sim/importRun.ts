// Reading a run that was actually played back into the simulation.
//
// The dev panel's "Export run" button writes the live run out through
// `serializeRunState` — the same function the active-run save uses — so a
// fixture and a save are the same object under two names, and both come back in
// through `hydrateRunState`. That is the whole trick: there is no second
// serializer to drift, and a fixture exported today still loads after the schema
// moves, because it loads through the code the game already maintains for saves.
//
// What a fixture is FOR: it is the yardstick. A bot that cannot reach, from the
// same trial, what a competent player reached is a bot whose capacity is too low
// to set that trial's goal from — and a goal set from it is a goal the player
// will meet on their opening roll. See benchmark.ts.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { hydrateRunState } from "../systems/ActiveRunPersistence";
import { rankOf, trialInRank } from "../config";
import type { RunState } from "../state/RunState";

export interface RunFixture {
  /** Where it came from, for report lines. */
  name: string;
  /** The player's own label from the export, when the file carried one. */
  label: string;
  state: RunState;
}

/**
 * Load one exported run.
 *
 * Three shapes are accepted, because there are three ways a run reaches a file
 * and it would be a poor tool that cared which:
 *
 *   - `{ kind: "…run-fixture", run }` — the dev panel's export.
 *   - `{ schema: 1, run }`            — the raw active-run save, copied straight
 *                                       out of localStorage.
 *   - a bare serialized run.
 */
export function loadRunFixture(path: string): RunFixture {
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Rethrown rather than wrapped: `Error.cause` is ES2022 and this project's
    // lib is ES2020, and the parse error's own stack is the useful part anyway.
    // All it is missing is which of the fixtures on the command line it was.
    (err as Error).message = `${path}: not JSON — ${(err as Error).message}`;
    throw err;
  }

  const envelope = parsed as { run?: unknown; label?: unknown };
  const runValue =
    envelope && typeof envelope === "object" && "run" in envelope
      ? envelope.run
      : parsed;

  const state = hydrateRunState(runValue);
  if (!state) {
    throw new Error(
      `${path}: not a run this build can read. The export must come from the ` +
        `dev panel's "Export run", or be the "${"the-order-of-order.active-run"}" ` +
        `localStorage value verbatim.`,
    );
  }

  return {
    name: basename(path).replace(/\.json$/i, ""),
    label:
      typeof envelope?.label === "string"
        ? envelope.label
        : describeFixture(state),
    state,
  };
}

export function loadRunFixtures(paths: readonly string[]): RunFixture[] {
  return paths.map(loadRunFixture);
}

/** A one-line description of where a run had got to. */
export function describeFixture(state: RunState): string {
  return (
    `trial ${state.trial} (rank ${rankOf(state.trial)}.${trialInRank(state.trial)})` +
    `, roll ${state.roll}, ${state.dice.length} dice, ${state.gold}g`
  );
}

/** The cards a run is holding, most copies first — the build, in one line. */
export function describeBuild(state: RunState): string {
  const owned = Object.entries(state.purchases).filter(([, n]) => (n ?? 0) > 0);
  if (owned.length === 0) return "(nothing bought)";
  return owned
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([id, n]) => ((n ?? 0) > 1 ? `${id}×${n}` : id))
    .join(", ");
}
