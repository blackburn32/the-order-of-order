/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOOTLOCKER_GAME_KEY?: string;
  readonly VITE_LOOTLOCKER_LEADERBOARD_KEY?: string;
  readonly VITE_LOOTLOCKER_GAME_VERSION?: string;
  /** Build flag: "true"/"1" draws the gold frame around the game (see
   *  src/buildFlags.ts). Set by `.env.itch` for itch.io builds only. */
  readonly VITE_GOLD_BORDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
