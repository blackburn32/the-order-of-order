/**
 * The page's small motions: things entering as you reach them, backgrounds
 * lagging behind the scroll, the run facts counting up, and the pointer
 * lighting the hero.
 *
 * All of it is decoration layered over a page that already reads without it —
 * `styles.css` only hides a `[data-reveal]` element when `html.js-motion` is
 * present, so no-script and reduced-motion visitors get the finished layout
 * with nothing to wait for.
 */

/** One scroll handler for the whole page, coalesced onto a frame. */
const scrollListeners = new Set();
let scrollFrame = 0;

function onScrollFrame() {
  scrollFrame = 0;
  for (const fn of scrollListeners) fn();
}

function requestScrollFrame() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(onScrollFrame);
}

function addScrollListener(fn) {
  if (scrollListeners.size === 0) {
    window.addEventListener("scroll", requestScrollFrame, { passive: true });
    window.addEventListener("resize", requestScrollFrame, { passive: true });
  }
  scrollListeners.add(fn);
  fn();
}

/* ------------------------------------------------------------------ reveal */

/** Stagger between siblings in the same group, in milliseconds. */
const STAGGER_MS = 90;

/** How far up the viewport an element's top must come before it arrives. A
 *  little inside the fold: it should already be settling by the time it is
 *  comfortably readable, not starting as it crosses the edge. */
const REVEAL_LINE = 0.88;

/**
 * Reveal `[data-reveal]` elements as they arrive. Siblings inside a
 * `[data-reveal-group]` come in one after another rather than all at once,
 * which is what makes a row of three cards read as dealt rather than switched
 * on.
 *
 * Position, rather than an IntersectionObserver: the observer only reports
 * threshold crossings, so an element jumped clean over — an anchor link, a
 * restored scroll position, a flick on a trackpad — never gets a callback and
 * would stay invisible for the rest of the visit. Anything at or above the
 * line is revealed whether or not it was ever watched crossing it.
 */
export function initReveals(root = document) {
  let pending = [...root.querySelectorAll("[data-reveal]")];
  if (pending.length === 0) return;

  for (const group of root.querySelectorAll("[data-reveal-group]")) {
    const members = [...group.querySelectorAll("[data-reveal]")];
    members.forEach((el, i) =>
      el.style.setProperty("--reveal-delay", i * STAGGER_MS + "ms"),
    );
  }

  const check = () => {
    if (pending.length === 0) {
      scrollListeners.delete(check);
      return;
    }
    // Read every position first, then write: interleaving the class changes
    // with the measurements would force a layout per element.
    const line = window.innerHeight * REVEAL_LINE;
    const arrived = pending.filter(
      (el) => el.getBoundingClientRect().top < line,
    );
    if (arrived.length === 0) return;
    pending = pending.filter((el) => !arrived.includes(el));
    for (const el of arrived) el.classList.add("is-revealed");
  };

  // One frame late, so whatever is already on screen at load still transitions
  // in rather than being born revealed.
  requestAnimationFrame(() => addScrollListener(check));
}

/* ---------------------------------------------------------------- parallax */

/**
 * Drift `[data-parallax]` elements against the scroll. The attribute value is
 * the strength: 0.1 is a background that barely lags, 0.3 is unmistakable.
 */
export function initParallax(root = document) {
  const targets = [...root.querySelectorAll("[data-parallax]")].map((el) => ({
    el,
    strength: Number(el.dataset.parallax) || 0.12,
  }));
  if (targets.length === 0) return;

  addScrollListener(() => {
    const middle = window.innerHeight / 2;
    for (const { el, strength } of targets) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < -200 || rect.top > window.innerHeight + 200) continue;
      // Negated, so the element travels *slower* than the page rather than
      // faster: at strength s it moves (1 - s) for every unit the page scrolls.
      const offset = -(rect.top + rect.height / 2 - middle) * strength;
      el.style.setProperty("--parallax", offset.toFixed(1) + "px");
    }
  });
}

/* ----------------------------------------------------------------- counters */

const COUNT_MS = 1100;

/** Animate every run of digits in the element's text up to its final value,
 *  leaving anything else (the en dash in "15–20") exactly where it is. */
function countUp(el) {
  const template = el.textContent;
  const numbers = template.match(/\d+/g);
  if (!numbers) return;
  const targets = numbers.map(Number);
  const start = performance.now();

  const step = (now) => {
    const t = Math.min(1, (now - start) / COUNT_MS);
    // Ease out: the last few counts should visibly slow rather than stop dead.
    const eased = 1 - Math.pow(1 - t, 3);
    let i = 0;
    el.textContent = template.replace(/\d+/g, () =>
      String(Math.round(targets[i++] * eased)),
    );
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = template;
  };
  requestAnimationFrame(step);
}

/** Start each `[data-countup]` the first time it is on screen. */
export function initCounters(root = document) {
  const targets = [...root.querySelectorAll("[data-countup]")];
  if (targets.length === 0) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        countUp(entry.target);
      }
    },
    { threshold: 0.6 },
  );
  for (const el of targets) observer.observe(el);
}

/* ------------------------------------------------------------ pointer light */

/** How far past the hero's own edges the pointer keeps steering the mark, as a
 *  fraction of the hero's size. Beyond that the drift simply holds. */
const POINTER_LIGHT_REACH = 0.35;

/**
 * A soft light that follows the pointer across the hero, and nudges the sigil
 * behind it. Pointer-driven only on a real pointer: on touch this would either
 * never fire or lurch on every tap.
 *
 * Listened for on the window rather than on the hero. The header is fixed over
 * the hero's top and the next section abuts its bottom, so a hero-bound
 * listener goes quiet the moment the pointer crosses either edge: the mark
 * freezes wherever it was and then snaps as the pointer comes back. Tracking
 * everywhere and clamping to `POINTER_LIGHT_REACH` instead means the value at
 * the boundary is the same from both sides, so there is nothing to jump — the
 * mark keeps answering the pointer through the header and the section below,
 * and comes to rest rather than being dragged around by a pointer two screens
 * away.
 */
export function initPointerLight(hero) {
  if (!hero || !window.matchMedia("(pointer: fine)").matches) return;

  let frame = 0;
  let clientX = 0;
  let clientY = 0;
  let seen = false;

  const reach = (value) =>
    Math.min(1 + POINTER_LIGHT_REACH, Math.max(-POINTER_LIGHT_REACH, value));

  const apply = () => {
    frame = 0;
    const rect = hero.getBoundingClientRect();
    // Nothing to light once the hero is off screen, and the rect is degenerate
    // if it is display:none at this width.
    if (!rect.width || !rect.height) return;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return;

    const x = reach((clientX - rect.left) / rect.width);
    const y = reach((clientY - rect.top) / rect.height);
    hero.style.setProperty("--pointer-x", (x * 100).toFixed(2) + "%");
    hero.style.setProperty("--pointer-y", (y * 100).toFixed(2) + "%");
    // A shallow counter-drift: enough that the mark feels like it sits behind
    // the art rather than printed on it.
    hero.style.setProperty(
      "--sigil-shift-x",
      ((0.5 - x) * 34).toFixed(1) + "px",
    );
    hero.style.setProperty(
      "--sigil-shift-y",
      ((0.5 - y) * 26).toFixed(1) + "px",
    );
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      clientX = event.clientX;
      clientY = event.clientY;
      seen = true;
      schedule();
    },
    { passive: true },
  );

  // The pointer is placed against the viewport, so scrolling past a resting
  // pointer changes where it falls on the hero just as moving it would. Without
  // this the mark holds a stale position through the scroll and lurches on the
  // next twitch of the mouse.
  addScrollListener(() => {
    if (seen) schedule();
  });

  hero.classList.add("has-pointer-light");
}

/* ------------------------------------------------------------------- tilt */

/** Maximum rotation of a tilted card, in degrees. */
const TILT_DEG = 7;

/** Lean `[data-tilt]` cards toward the pointer. */
export function initTilt(root = document) {
  const targets = [...root.querySelectorAll("[data-tilt]")];
  if (targets.length === 0 || !window.matchMedia("(pointer: fine)").matches) {
    return;
  }

  for (const el of targets) {
    el.addEventListener(
      "pointermove",
      (event) => {
        const rect = el.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width - 0.5;
        const py = (event.clientY - rect.top) / rect.height - 0.5;
        el.style.setProperty(
          "--tilt-y",
          (px * TILT_DEG * 2).toFixed(2) + "deg",
        );
        el.style.setProperty(
          "--tilt-x",
          (-py * TILT_DEG * 2).toFixed(2) + "deg",
        );
      },
      { passive: true },
    );
    el.addEventListener("pointerleave", () => {
      el.style.setProperty("--tilt-x", "0deg");
      el.style.setProperty("--tilt-y", "0deg");
    });
  }
}

/* ------------------------------------------------------- header and progress */

/** Thicken the header once the hero is behind it, and run the gold progress
 *  rule along its bottom edge. */
export function initHeader(header, progress) {
  if (!header) return;
  addScrollListener(() => {
    header.classList.toggle("is-scrolled", window.scrollY > 40);
    if (!progress) return;
    const span =
      document.documentElement.scrollHeight - window.innerHeight || 1;
    const ratio = Math.min(1, Math.max(0, window.scrollY / span));
    progress.style.setProperty("--progress", ratio.toFixed(4));
  });
}

/* ------------------------------------------------------------- the mini die */

/** How long a roll lasts. Keep in step with the `rotate` transition on
 *  `.mini-die` in styles.css — the face settles as the turn finishes. */
const MINI_DIE_ROLL_MS = 700;
/** Faces shown while it turns, before it settles back on its own. */
const MINI_DIE_SHUFFLES = 5;

/** Turn the header's die another revolution and cycle its face while it goes.
 *  It always lands back on the face it started with: on this page that is a 1,
 *  the only face that scores. */
export function initMiniDie(die) {
  if (!die) return;
  const settled = die.textContent.trim();
  const mark = die.closest("a") || die;
  const step = Math.round(MINI_DIE_ROLL_MS / (MINI_DIE_SHUFFLES + 1));
  let turns = 0;
  let shuffle = 0;
  let shown = settled;

  mark.addEventListener("pointerenter", () => {
    // Whole turns only, layered over the resting tilt `.mini-die` already
    // carries in its `transform`.
    turns += 1;
    die.style.rotate = turns * 360 + "deg";
    if (shuffle) return; // already mid-roll; the turn simply carries on

    let left = MINI_DIE_SHUFFLES;
    shuffle = setInterval(() => {
      if (left > 0) {
        left -= 1;
        // A different face each time, so it reads as a roll rather than a flicker.
        let face = shown;
        while (face === shown) face = String(1 + Math.floor(Math.random() * 6));
        shown = face;
      } else {
        clearInterval(shuffle);
        shuffle = 0;
        shown = settled;
      }
      die.textContent = shown;
    }, step);
  });
}
