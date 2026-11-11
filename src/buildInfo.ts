// Which build of the game this is, stamped into every run it plays (see
// systems/InputLog) so an audit can check a run out at the commit that
// produced it and replay it under the same rules.
//
// Set by vite.config.ts from the CI's commit variable or `git rev-parse`, with a
// `-dirty` suffix for a local build of uncommitted changes. The node-run
// simulations never go through Vite, so they read as "dev".

const env: Partial<ImportMetaEnv> = import.meta.env ?? {};

export const BUILD_SHA: string = env.VITE_BUILD_SHA || "dev";
