// Writes src/generated/licenses.json: the licence of every package the game
// ships, for the Credits & Licences screen (src/scenes/CreditsScene.ts).
//
//   npm run licenses
//
// "Ships" means the runtime dependencies in package.json and everything they
// depend on, minus the build-time tools listed below that only happen to sit
// in `dependencies`. Run it after adding or upgrading a dependency; CI-free
// projects forget, so `npm run licenses -- --check` fails when the committed
// file is stale.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src", "generated", "licenses.json");
/** In `dependencies` for Capacitor's tooling, but never part of a build. */
const BUILD_ONLY = new Set(["@capacitor/cli"]);

function packageDir(name, from) {
  // Node's own resolution order: nested node_modules first, then upward.
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === root || dirname(dir) === dir) break;
  }
  const top = join(root, "node_modules", name);
  if (existsSync(join(top, "package.json"))) return top;
  throw new Error(`cannot find ${name} (run npm install)`);
}

function licenceText(dir) {
  const file = readdirSync(dir).find((f) =>
    /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i.test(f),
  );
  return file ? readFileSync(join(dir, file), "utf8").trim() : "";
}

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const seen = new Map();
const queue = Object.keys(rootPkg.dependencies ?? {})
  .filter((name) => !BUILD_ONLY.has(name))
  .map((name) => ({ name, from: root }));

while (queue.length) {
  const { name, from } = queue.shift();
  const dir = packageDir(name, from);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  seen.set(key, {
    name: pkg.name,
    version: pkg.version,
    license:
      typeof pkg.license === "string"
        ? pkg.license
        : (pkg.license?.type ?? "UNKNOWN"),
    text: licenceText(dir),
  });
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    queue.push({ name: dep, from: dir });
}

const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const json = `${JSON.stringify(list, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = existsSync(out) ? readFileSync(out, "utf8") : "";
  if (current !== json) {
    console.error(
      "src/generated/licenses.json is stale: run `npm run licenses`.",
    );
    process.exit(1);
  }
  console.log("licenses.json is current.");
} else {
  writeFileSync(out, json);
  console.log(
    `Wrote ${list.length} licence(s) to src/generated/licenses.json:`,
  );
  for (const p of list) console.log(`  ${p.name} ${p.version} (${p.license})`);
}
