// Audit one run: replay it from its record and check it reaches the score it
// claims.
//
//   npm run audit -- run.json                 a board blob (gzipped or not), a
//                                             Hall entry, or an active-run save
//   npm run audit -- --api=https://… --member=ID [--daily=YYYY-MM-DD]
//                                             fetch a board row's blob and score
//   npm run audit -- run.json --score=123     the score to check against, when
//                                             the file does not carry one
//   npm run audit -- run.json --character=roland
//                                             the novice, for an old blob
//
// Exits 0 when the run replays to its claimed score, 1 when it does not (or
// cannot be replayed), 2 on a usage error.
//
// Replay a run under the build that played it: check out the commit the report
// names first. Rules move between builds, and a fair run played under old ones
// will not replay under new ones.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { formatSeed } from "../systems/Rng";
import { hydrateRunState } from "../systems/ActiveRunPersistence";
import { decodeAnalysis } from "../systems/GlobalScores";
import { isCharacterId, DEFAULT_CHARACTER } from "../systems/Characters";
import { readInputLog } from "../systems/InputLog";
import type { ShopItemId } from "../systems/Items";
import { isSeed } from "../systems/Rng";
import { installStorage } from "./localStorageShim";
import { replayRun, type RunRecord } from "./replay";

installStorage([]);

interface Claim {
  record: RunRecord;
  score?: bigint;
  /** Where the record came from, for the report. */
  source: string;
  /** The build the record says finished the run, when it says. */
  build?: string;
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function usage(message: string): never {
  console.error(`audit: ${message}`);
  console.error(
    "usage: npm run audit -- <file> [--score=N] [--character=ID]\n" +
      "       npm run audit -- --api=URL --member=ID [--daily=YYYY-MM-DD]",
  );
  process.exit(2);
}

/** Text from bytes that may be gzipped, as board blobs are. */
function text(bytes: Uint8Array): string {
  const gz = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return Buffer.from(gz ? gunzipSync(bytes) : bytes).toString("utf8");
}

/** Read whichever of the three shapes a run's record comes in. */
function claimFrom(raw: string, source: string): Claim {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    usage(`${source} is not JSON`);
  }

  // An active-run save or a dev-panel export: the whole run, mid-flight.
  if (parsed.run && typeof parsed.run === "object") {
    const state = hydrateRunState(parsed.run);
    if (!state) usage(`${source} holds a run this build cannot read`);
    return {
      source: `${source} (active run)`,
      score: state.totalScore,
      record: {
        seed: state.seed,
        unlocks: state.shopUnlocks,
        character: state.character,
        tutorialArmed: state.tutorialArmed,
        forcedRolls: state.forcedRolls,
        daily: state.dailyRite?.day,
        log: state.inputLog,
      },
    };
  }

  // A Hall entry, as the Hall keeps it in localStorage.
  if (Array.isArray(parsed.inputLog)) {
    if (!isSeed(parsed.seed)) usage(`${source} has no seed`);
    return {
      source: `${source} (Hall entry)`,
      score:
        parsed.score !== undefined
          ? BigInt(parsed.score as string | number)
          : undefined,
      build: typeof parsed.build === "string" ? parsed.build : undefined,
      record: {
        seed: parsed.seed,
        unlocks: (parsed.unlocks as ShopItemId[] | undefined) ?? [],
        character: isCharacterId(parsed.character)
          ? parsed.character
          : DEFAULT_CHARACTER,
        tutorialArmed: parsed.tutorialArmed === true,
        forcedRolls: (parsed.forcedRolls as string[] | undefined) ?? [],
        daily: typeof parsed.daily === "string" ? parsed.daily : undefined,
        log: readInputLog(parsed.inputLog),
      },
    };
  }

  // A board blob.
  const blob = decodeAnalysis(raw);
  if (!blob) usage(`${source} is not a run record this build can read`);
  if (blob.seed === undefined) usage(`${source} carries no seed`);
  if (!blob.inputLog?.length) usage(`${source} carries no input log`);
  return {
    source: `${source} (board blob)`,
    build: blob.build,
    record: {
      seed: blob.seed,
      unlocks: blob.unlocks ?? [],
      character: blob.character ?? DEFAULT_CHARACTER,
      tutorialArmed: blob.tutorialArmed === true,
      forcedRolls: blob.forcedRolls ?? [],
      daily: blob.daily,
      log: blob.inputLog,
    },
  };
}

/** Fetch a board row's blob, and its score off the board itself. */
async function claimFromBoard(
  api: string,
  member: string,
  daily?: string,
): Promise<Claim> {
  const base = api.replace(/\/+$/, "");
  const prefix = daily ? `${base}/v1/daily/${daily}` : `${base}/v1`;
  const blobRes = await fetch(`${prefix}/runs/${encodeURIComponent(member)}`);
  if (!blobRes.ok) usage(`no blob for ${member} (HTTP ${blobRes.status})`);
  const claim = claimFrom(
    text(new Uint8Array(await blobRes.arrayBuffer())),
    `board run ${member}`,
  );
  const topRes = await fetch(`${prefix}/top?limit=1000`);
  if (topRes.ok) {
    const { rows } = (await topRes.json()) as {
      rows: { memberId: string; score: string; character: string }[];
    };
    const row = rows.find((r) => r.memberId === member);
    if (row) {
      claim.score = BigInt(row.score);
      if (isCharacterId(row.character)) claim.record.character = row.character;
    }
  }
  return claim;
}

function headSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const api = arg("api");
  const member = arg("member");
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  let claim: Claim;
  if (api || member) {
    if (!api || !member) usage("--api and --member go together");
    claim = await claimFromBoard(api, member, arg("daily"));
  } else if (file) {
    claim = claimFrom(text(readFileSync(file)), file);
  } else {
    usage("name a run file, or --api and --member");
  }
  const score = arg("score");
  if (score !== undefined) claim.score = BigInt(score);
  const character = arg("character");
  if (character !== undefined) {
    if (!isCharacterId(character)) usage(`unknown character ${character}`);
    claim.record.character = character;
  }
  const daily = arg("daily");
  if (daily) claim.record.daily = daily;

  const result = replayRun(claim.record);
  const head = headSha();
  const builds = result.builds;
  const lines = [
    `Run         ${claim.source}`,
    `Seed        ${formatSeed(claim.record.seed)}${claim.record.daily ? `  (Daily Rite ${claim.record.daily})` : ""}`,
    `Novice      ${claim.record.character}`,
    `Inputs      ${claim.record.log.length} logged`,
    `Builds      ${builds.length ? builds.join(" → ") : "none logged"}${claim.build && !builds.includes(claim.build) ? `, finished on ${claim.build}` : ""}`,
    `Checkout    ${head ?? "unknown"}`,
  ];
  console.log(lines.join("\n"));

  const finishedOn = claim.build ?? builds[builds.length - 1];
  if (finishedOn && head && !finishedOn.startsWith(head))
    console.log(
      `\n  note   this checkout is not the build that played the run; for a` +
        ` faithful replay, git checkout ${finishedOn.replace(/-dirty$/, "")}`,
    );
  if (builds.length > 1)
    console.log(
      "  note   the run was resumed across builds; each stretch replays here" +
        " under this checkout's rules",
    );
  if (finishedOn?.endsWith("-dirty"))
    console.log(
      "  note   a -dirty build had uncommitted changes, which no checkout has",
    );

  console.log(
    `\nReplayed    ${result.end}, rank ${result.rank} trial ${result.trial}${result.endless ? " (endless)" : ""}, ${result.rolls} rolls`,
  );
  console.log(`Score       ${result.score}`);
  if (claim.score !== undefined) console.log(`Claimed     ${claim.score}`);

  const problems: string[] = [];
  if (!result.ok)
    problems.push(
      `the log stops replaying at entry ${result.at}: ${result.error}`,
    );
  if (result.devActions.length)
    problems.push(
      `the dev panel touched the run: ${result.devActions.join(", ")}`,
    );
  if (result.riggedOutsideTutorial)
    problems.push(
      `${result.riggedOutsideTutorial} roll(s) logged as tutorial-rigged on a run not played under the tutorial`,
    );
  if (claim.score === undefined)
    problems.push("no claimed score to check against (pass --score=N)");
  else if (result.ok && claim.score !== result.score)
    problems.push(
      `the replay scores ${result.score}, but the run claims ${claim.score}`,
    );

  if (problems.length === 0) {
    console.log("\nVerdict     LEGIT: the run replays to its claimed score");
    return;
  }
  console.log("\nVerdict     NOT VERIFIED");
  for (const p of problems) console.log(`  -      ${p}`);
  process.exit(1);
}

void main();
