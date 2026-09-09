/**
 * Drifting gold motes, the landing-page cousin of `AmbientLayer`'s mote field
 * in the game: each one runs its own slow rise and its own fade, deliberately
 * out of phase, so the field never pulses as one.
 *
 * A canvas rather than a pile of animated elements — thirty additive sprites
 * are one draw loop here and thirty composited layers otherwise, and the loop
 * parks itself the moment its section leaves the viewport.
 */

const SPRITE_SIZE = 64;

/** Cap the backing store: past 2× the motes are soft gradients nobody is
 *  inspecting, and a full-bleed hero at 3× is a lot of fill rate for them. */
const MAX_DPR = 2;

let sprite;

/** A soft radial dot, matching the game's `spark` texture. Built once and
 *  reused by every field on the page. */
function getSprite() {
  if (sprite) return sprite;
  sprite = document.createElement("canvas");
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;
  const ctx = sprite.getContext("2d");
  const half = SPRITE_SIZE / 2;
  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0, "rgba(255, 233, 176, 1)");
  grad.addColorStop(0.35, "rgba(255, 217, 119, 0.65)");
  grad.addColorStop(1, "rgba(255, 217, 119, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return sprite;
}

function seed(count) {
  const motes = [];
  for (let i = 0; i < count; i++) {
    // One in seven is a slower, fatter ember, so the field has a foreground.
    const ember = i % 7 === 0;
    motes.push({
      x: Math.random(),
      y: Math.random(),
      size: ember ? 10 + Math.random() * 9 : 3 + Math.random() * 6,
      // Rise amplitude and period, in the same ranges the game tweens over.
      rise: 30 + Math.random() * 60,
      risePeriod: (ember ? 11000 : 6000) + Math.random() * 8000,
      risePhase: Math.random() * Math.PI * 2,
      sway: 6 + Math.random() * 16,
      swayPeriod: 9000 + Math.random() * 11000,
      swayPhase: Math.random() * Math.PI * 2,
      minAlpha: ember ? 0.05 : 0.08,
      maxAlpha: (ember ? 0.22 : 0.4) * (0.6 + Math.random() * 0.4),
      fadePeriod: 1800 + Math.random() * 2400,
      fadePhase: Math.random() * Math.PI * 2,
    });
  }
  return motes;
}

/**
 * Attach a mote field to `host`, filling it. Returns a teardown function.
 *
 * The field is inert until it scrolls into view and stops again when it
 * leaves, so a page with four of them still only ever animates the one or two
 * the reader is looking at.
 */
export function mountMotes(host, count) {
  const canvas = document.createElement("canvas");
  canvas.className = "mote-field";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  const motes = seed(count);
  let width = 0;
  let height = 0;
  let frame = 0;
  let visible = false;

  const resize = () => {
    const rect = host.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const draw = (now) => {
    frame = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    const dot = getSprite();
    for (const m of motes) {
      const alpha =
        m.minAlpha +
        ((m.maxAlpha - m.minAlpha) *
          (1 + Math.sin((now / m.fadePeriod) * Math.PI * 2 + m.fadePhase))) /
          2;
      if (alpha <= 0.005) continue;
      const x =
        m.x * width +
        Math.sin((now / m.swayPeriod) * Math.PI * 2 + m.swayPhase) * m.sway;
      const y =
        m.y * height -
        ((1 + Math.sin((now / m.risePeriod) * Math.PI * 2 + m.risePhase)) / 2) *
          m.rise;
      ctx.globalAlpha = alpha;
      ctx.drawImage(dot, x - m.size / 2, y - m.size / 2, m.size, m.size);
    }
    ctx.globalAlpha = 1;
  };

  const start = () => {
    if (frame || !visible || document.hidden) return;
    frame = requestAnimationFrame(draw);
  };

  const stop = () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) start();
      else stop();
    },
    { rootMargin: "120px" },
  );
  observer.observe(host);

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener("visibilitychange", onVisibility);

  const sizeObserver = new ResizeObserver(resize);
  sizeObserver.observe(host);
  resize();

  return () => {
    stop();
    observer.disconnect();
    sizeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.remove();
  };
}

/** Fill every `[data-motes]` slot on the page; the value is the mote count. */
export function mountAllMotes(root = document) {
  const teardowns = [];
  for (const host of root.querySelectorAll("[data-motes]")) {
    teardowns.push(mountMotes(host, Number(host.dataset.motes) || 18));
  }
  return () => teardowns.forEach((fn) => fn());
}
