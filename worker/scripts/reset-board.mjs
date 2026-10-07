// Wipes the global board: every row in D1 and every analysis blob in R2.
//
// For after a rebalance, when old scores no longer compare with new ones. The
// schema, index and Worker are untouched — no redeploy or `db:init` needed.
//
//   npm run board:reset                 # remote, with a backup and a prompt
//   npm run board:reset -- --local      # the `wrangler dev` database instead
//   npm run board:reset -- --yes        # skip the prompt (scripts, CI)
//   npm run board:reset -- --keep-blobs # D1 only; leave R2 alone
//
// Order matters. The board rows are exported, then the blob keys are read,
// then the rows are deleted, and only then are the blobs deleted. A failure
// part-way through the blob pass leaves orphans nothing points at, which are
// harmless (the client only fetches analyses for rows with has_analysis = 1)
// and are overwritten by that player's next submission anyway. Re-running the
// script does not find them again: its key list comes from D1.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(WORKER_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
// Passed explicitly: the repo root has the site's own wrangler.jsonc, and
// wrangler prefers it over this directory's wrangler.toml.
const CONFIG = join(WORKER_DIR, "wrangler.toml");
const BLOB_DELETE_CONCURRENCY = 6;

const args = new Set(process.argv.slice(2));
const LOCAL = args.has("--local");
const YES = args.has("--yes");
const KEEP_BLOBS = args.has("--keep-blobs");
const TARGET = LOCAL ? "--local" : "--remote";

const unknown = [...args].filter(
  (a) => !["--local", "--yes", "--keep-blobs"].includes(a),
);
if (unknown.length) {
  console.error(`Unknown option(s): ${unknown.join(" ")}`);
  process.exit(2);
}

// Read the names from wrangler.toml rather than repeating them here, so a
// renamed database or bucket cannot leave this script pointed at the old one.
const toml = readFileSync(CONFIG, "utf8");
const tomlValue = (key) => {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match) throw new Error(`wrangler.toml has no ${key}`);
  return match[1];
};
const DATABASE = tomlValue("database_name");
const BUCKET = tomlValue("bucket_name");

/** Runs wrangler and resolves with its stdout; rejects with stderr on failure. */
function wrangler(...wranglerArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER, ...wranglerArgs, "--config", CONFIG], {
      cwd: WORKER_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`wrangler ${wranglerArgs.join(" ")}\n${err || out}`)),
    );
  });
}

/** One SQL statement's result rows. */
async function query(sql) {
  const out = await wrangler("d1", "execute", DATABASE, TARGET, "--json", "--command", sql);
  return JSON.parse(out)[0].results;
}

async function confirm() {
  if (YES) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type "${DATABASE}" to wipe it: `);
  rl.close();
  return answer.trim() === DATABASE;
}

const where = LOCAL ? "LOCAL" : "REMOTE";
const [{ rows }] = await query("SELECT COUNT(*) AS rows FROM runs");
const blobKeys = KEEP_BLOBS
  ? []
  : (await query("SELECT member_id FROM runs WHERE has_analysis = 1")).map(
      (r) => r.member_id,
    );

console.log(`${where} board "${DATABASE}": ${rows} row(s).`);
console.log(
  KEEP_BLOBS
    ? `R2 bucket "${BUCKET}": left alone (--keep-blobs).`
    : `R2 bucket "${BUCKET}": ${blobKeys.length} analysis blob(s) to delete.`,
);

if (rows === 0 && blobKeys.length === 0) {
  console.log("Nothing to reset.");
  process.exit(0);
}
if (!(await confirm())) {
  console.log("Aborted; nothing changed.");
  process.exit(1);
}

// The backup holds initials and device ids, so backups/ is gitignored. D1 Time
// Travel (30 days, remote only) is the second line of defence.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(WORKER_DIR, "backups", `board-${where.toLowerCase()}-${stamp}.sql`);
mkdirSync(dirname(backup), { recursive: true });
await wrangler("d1", "export", DATABASE, TARGET, "--table", "runs", "--output", backup);
console.log(`Backed up the board to ${relative(process.cwd(), backup)}`);

await wrangler(
  "d1", "execute", DATABASE, TARGET,
  "--command", "DELETE FROM runs; DELETE FROM throttle;",
);
console.log(`Cleared runs and throttle.`);

let deleted = 0;
const failed = [];
const queue = [...blobKeys];
await Promise.all(
  Array.from({ length: BLOB_DELETE_CONCURRENCY }, async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      try {
        await wrangler("r2", "object", "delete", `${BUCKET}/${key}`, TARGET);
        deleted++;
      } catch (e) {
        failed.push({ key, message: e.message });
      }
    }
  }),
);
if (blobKeys.length) console.log(`Deleted ${deleted}/${blobKeys.length} analysis blob(s).`);

if (failed.length) {
  // Orphans are harmless (see the header), so this is a warning, not a retry.
  console.warn(`\n${failed.length} blob(s) could not be deleted and are now orphaned:`);
  for (const { key, message } of failed) console.warn(`  ${key}: ${message.split("\n")[1] ?? message}`);
  process.exitCode = 1;
} else {
  console.log("Board reset.");
}
