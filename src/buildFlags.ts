// Build-time feature switches, inlined by Vite from the `VITE_*` env vars.
//
// These are *build* settings, not gameplay tuning (that lives in src/config.ts)
// and not runtime player settings — the value is frozen into the bundle when it
// is built, so a given dist/ is either an itch.io build or it isn't.
//
// The itch.io builds turn theirs on via `.env.itch`, which is loaded by
// `npm run package:itch` / `npm run dev:itch` (both pass `--mode itch`). Every
// other build (plain `npm run build` for GitHub Pages, the Capacitor/Android
// bundle, `npm run dev`) leaves them at the defaults below.

/** Env vars are strings; anything but an explicit truthy value reads as off. */
function flag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** The gold frame around the outside of the page.
 *
 *  It exists to give the game a visible edge inside itch.io's embed iframe,
 *  where the game sits on the page's own background. Anywhere the game owns
 *  the whole viewport — a Pages deploy, the Android app — the frame just reads
 *  as a stray line at the screen edge, so it is off by default. */
export const GOLD_BORDER = flag(import.meta.env.VITE_GOLD_BORDER);
