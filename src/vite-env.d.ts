/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the global leaderboard Worker (see worker/). Absent disables
   *  the global board entirely; the local Hall is unaffected. */
  readonly VITE_LEADERBOARD_API?: string;
  /** Optional shared key matching the Worker's SUBMIT_KEY secret. Ships in the
   *  bundle, so it filters bots rather than authenticating anyone. */
  readonly VITE_LEADERBOARD_SUBMIT_KEY?: string;
  /** Build flag: "true"/"1" draws the gold frame around the game (see
   *  src/buildFlags.ts). Set by `.env.itch` for itch.io builds only. */
  readonly VITE_GOLD_BORDER?: string;
  /** Build flag: "true"/"1" identifies the Capacitor phone bundle. */
  readonly VITE_PHONE_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
