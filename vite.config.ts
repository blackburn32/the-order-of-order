import { execSync } from "node:child_process";
import { defineConfig } from "vite";

/** The commit this bundle is built from, which every run it plays records (see
 *  src/buildInfo.ts). Cloudflare's Workers Builds name it in the environment;
 *  anywhere else it is read from git, marked `-dirty` when the working tree
 *  holds changes the commit does not — such a build cannot be checked out
 *  again, and an audit should know that. */
function buildSha(): string {
  const ci = process.env.VITE_BUILD_SHA || process.env.WORKERS_CI_COMMIT_SHA;
  if (ci) return ci;
  try {
    const sha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const dirty =
      execSync("git status --porcelain --untracked-files=no", {
        encoding: "utf8",
      }).trim() !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  base: "./",
  define: {
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(buildSha()),
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5173,
    open: false,
  },
});
