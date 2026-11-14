// Pages outside the game, and how to open one from inside it.

import { PHONE_BUILD } from "../buildFlags";

/** The privacy policy (marketing-site/privacy/). Every store listing links the
 *  same page. */
export const PRIVACY_URL = "https://the-order-of-order.com/privacy/";

/** Open a page outside the game. The Android app hands a top-level navigation
 *  to an outside URL to the system browser (Capacitor does), which keeps the
 *  game running behind it; a browser opens a new tab instead of leaving. */
export function openExternal(url: string): void {
  if (PHONE_BUILD) {
    window.location.href = url;
    return;
  }
  window.open(url, "_blank", "noopener");
}
