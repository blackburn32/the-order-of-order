/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LOOTLOCKER_GAME_KEY?: string;
  readonly VITE_LOOTLOCKER_LEADERBOARD_KEY?: string;
  readonly VITE_LOOTLOCKER_GAME_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
