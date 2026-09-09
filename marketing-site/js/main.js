/**
 * Entry point for the landing page's ornament.
 *
 * Nothing here is load-bearing: the page is complete HTML and CSS before this
 * module runs, and every piece below is skipped outright when the visitor has
 * asked for reduced motion. The one exception is the sigils, which mount
 * either way — a still mark is still the game's mark, and only its rotation is
 * motion.
 */

import { mountSigils } from "./sigil.js";
import { mountAllMotes } from "./motes.js";
import {
  initCounters,
  initHeader,
  initMiniDie,
  initParallax,
  initPointerLight,
  initReveals,
  initTilt,
} from "./flourish.js";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

mountSigils();

initHeader(
  document.querySelector(".site-header"),
  document.querySelector(".scroll-progress"),
);

if (!reduced.matches) {
  mountAllMotes();
  initReveals();
  initParallax();
  initCounters();
  initTilt();
  initMiniDie(document.querySelector(".mini-die"));
  initPointerLight(document.querySelector(".hero"));
}
