// Which build of the game this is, stamped into every run it plays (see
// systems/InputLog) so an audit can check a run out at the commit that
// produced it and replay it under the same rules.
//
// Set by vite.config.ts from the CI's commit variable or `git rev-parse`, with a
// `-dirty` suffix for a local build of uncommitted changes. The node-run
// simulations never go through Vite, so they read as "dev".

const env: Partial<ImportMetaEnv> = import.meta.env ?? {};

export const BUILD_SHA: string = env.VITE_BUILD_SHA || "dev";

/** The release version, from package.json (see vite.config.ts) — the same
 *  number the Android build carries. Shown in Settings. */
export const APP_VERSION: string = env.VITE_APP_VERSION || "dev";

/** The version and the short commit, as one line for the Settings screen and
 *  crash reports. */
export function versionLabel(): string {
  const sha = BUILD_SHA.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1");
  return `v${APP_VERSION} (${sha})`;
}
