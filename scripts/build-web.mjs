import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import console from "node:console";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketingRoot = resolve(projectRoot, "marketing-site");
const outputRoot = resolve(projectRoot, "site-dist");

function runNode(entryPoint, args = []) {
  const result = spawnSync(
    process.execPath,
    [resolve(projectRoot, entryPoint), ...args],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Type-check before replacing the last successful combined build.
runNode("node_modules/typescript/bin/tsc", ["--noEmit"]);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await cp(marketingRoot, outputRoot, {
  recursive: true,
  filter(source) {
    const pathFromMarketingRoot = relative(marketingRoot, source);
    if (!pathFromMarketingRoot) return true;

    const [topLevelName] = pathFromMarketingRoot.split(sep);
    return topLevelName !== "dist" && pathFromMarketingRoot !== "README.md";
  },
});

runNode("node_modules/vite/bin/vite.js", [
  "build",
  "--base=/game/",
  "--outDir=site-dist/game",
  "--emptyOutDir",
]);

console.log(
  "Combined web build ready in site-dist/ (marketing at /, game at /game/).",
);
