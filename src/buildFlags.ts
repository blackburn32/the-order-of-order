// Build-time feature switches, inlined by Vite from the `VITE_*` env vars.
//
// These are *build* settings, not gameplay tuning (that lives in src/config.ts)
// and not runtime player settings — the value is frozen into the bundle when it
// is built, so a given dist/ is either an itch.io build or it isn't.
//
// Targeted builds opt in through mode-specific files such as `.env.itch` and
// `.env.phone`; plain web builds leave the flags at their defaults below.

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

/** Whether this bundle is intended for the Capacitor phone app. */
export const PHONE_BUILD = flag(import.meta.env.VITE_PHONE_BUILD);
