// Removes one player from the boards: their global row, every daily row, and
// the analysis blobs behind them.
//
// For a deletion request sent by email (the privacy policy offers one, against
// the member id the game's Settings screen shows), and for a row that has to
// come down — offensive initials the filter missed, or a run `board:audit`
// could not verify. Players with the game can do the same themselves from
// Settings, which calls `DELETE /v1/players/me`.
//
//   npm run player:delete -- <member-id>            # remote, with a prompt
//   npm run player:delete -- <member-id> --local    # the `wrangler dev` database
//   npm run player:delete -- <member-id> --yes      # skip the prompt
//
// Several ids may be given at once.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(
  WORKER_DIR,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
// Passed explicitly: the repo root has the site's own wrangler.jsonc, and
// wrangler prefers it over this directory's wrangler.toml.
const CONFIG = join(WORKER_DIR, "wrangler.toml");

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const ids = argv.filter((a) => !a.startsWith("--"));
const LOCAL = flags.has("--local");
const YES = flags.has("--yes");
const TARGET = LOCAL ? "--local" : "--remote";

const unknown = [...flags].filter((a) => !["--local", "--yes"].includes(a));
if (unknown.length || ids.length === 0) {
  if (unknown.length) console.error(`Unknown option(s): ${unknown.join(" ")}`);
  console.error(
    "usage: npm run player:delete -- <member-id>... [--local] [--yes]",
  );
  process.exit(2);
}
// The same shape the Worker accepts, which also keeps the ids safe to splice
// into the SQL below.
const bad = ids.filter((id) => !/^[A-Za-z0-9_-]{8,64}$/.test(id));
if (bad.length) {
  console.error(`Not a member id: ${bad.join(", ")}`);
  process.exit(2);
}

const toml = readFileSync(CONFIG, "utf8");
const tomlValue = (key) => {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`wrangler.toml has no ${key}`);
  return match[1];
};
const DATABASE = tomlValue("database_name");
const BUCKET = tomlValue("bucket_name");

function wrangler(...wranglerArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WRANGLER, ...wranglerArgs, "--config", CONFIG],
      {
        cwd: WORKER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(`wrangler ${wranglerArgs.join(" ")}\n${err || out}`),
          ),
    );
  });
}

async function query(sql) {
  const out = await wrangler(
    "d1",
    "execute",
    DATABASE,
    TARGET,
    "--json",
    "--command",
    sql,
  );
  return JSON.parse(out)[0].results;
}

const list = ids.map((id) => `'${id}'`).join(", ");
const runs = await query(
  `SELECT member_id, initials, rank, score_len, has_analysis FROM runs WHERE member_id IN (${list})`,
);
const daily = await query(
  `SELECT member_id, day, has_analysis FROM daily_runs WHERE member_id IN (${list})`,
);

const where = LOCAL ? "LOCAL" : "REMOTE";
console.log(`${where} board "${DATABASE}":`);
for (const row of runs)
  console.log(
    `  global  ${row.member_id}  ${row.initials || "—"}  rank ${row.rank}`,
  );
for (const row of daily) console.log(`  daily   ${row.member_id}  ${row.day}`);
if (runs.length === 0 && daily.length === 0) {
  console.log("  nothing held for these ids.");
  process.exit(0);
}

if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Delete ${runs.length + daily.length} row(s)? [y/N] `,
  );
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Aborted; nothing changed.");
    process.exit(1);
  }
}

const keys = [
  ...runs.filter((r) => r.has_analysis === 1).map((r) => r.member_id),
  ...daily
    .filter((r) => r.has_analysis === 1)
    .map((r) => `daily/${r.day}/${r.member_id}`),
];
// Blobs first, the same order the Worker uses, so no row outlives its blob.
let failed = 0;
for (const key of keys) {
  try {
    await wrangler("r2", "object", "delete", `${BUCKET}/${key}`, TARGET);
  } catch (e) {
    failed++;
    console.warn(
      `  could not delete blob ${key}: ${e.message.split("\n")[1] ?? e.message}`,
    );
  }
}
await wrangler(
  "d1",
  "execute",
  DATABASE,
  TARGET,
  "--command",
  `DELETE FROM runs WHERE member_id IN (${list}); DELETE FROM daily_runs WHERE member_id IN (${list});`,
);
console.log(
  `Deleted ${runs.length} global and ${daily.length} daily row(s), ${keys.length - failed}/${keys.length} blob(s).`,
);
if (failed) process.exitCode = 1;
