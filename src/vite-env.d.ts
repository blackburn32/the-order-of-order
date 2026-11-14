/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the global leaderboard Worker (see worker/). Absent disables
   *  the global board entirely; the local Hall is unaffected. */
  readonly VITE_LEADERBOARD_API?: string;
  /** Build flag: "true"/"1" draws the gold frame around the game (see
   *  src/buildFlags.ts). Set by `.env.itch` for itch.io builds only. */
  readonly VITE_GOLD_BORDER?: string;
  /** Build flag: "true"/"1" ships the dev panel in a production bundle. Set by
   *  scripts/build-web.mjs for Cloudflare preview builds of non-main branches. */
  readonly VITE_DEV_PANEL?: string;
  /** Build flag: "true"/"1" identifies the Capacitor phone bundle. */
  readonly VITE_PHONE_BUILD?: string;
  /** The commit the bundle was built from, set by vite.config.ts (see
   *  src/buildInfo.ts). */
  readonly VITE_BUILD_SHA?: string;
  /** package.json's version, set by vite.config.ts (see src/buildInfo.ts). */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
