import Phaser from "phaser";
import {
  detectEffectsTier,
  EffectsTier,
  prefersReducedMotion,
} from "../renderQuality";

/**
 * The single gate every visual flourish in the game asks before it draws
 * anything. Three independent inputs collapse into it:
 *
 * 1. **The player's Visual Effects setting** (`SaveData.visualEffects`, on by
 *    default). Off means off — the game falls back to exactly the feedback it
 *    had before any of this existed.
 * 2. **The device's effect tier** (`renderQuality.detectEffectsTier`). A
 *    Canvas fallback or a low-core phone can't carry a filter pass per object
 *    or a particle system, so `rich` stays false there and callers take the
 *    cheap path instead of the expensive one.
 * 3. **The OS reduce-motion preference**. Constrains a different axis from the
 *    tier: capable hardware still shouldn't shake the screen at someone who
 *    asked it not to, so `motion` gates shake, drift, and tumble jitter while
 *    still feedback (count-ups, tints, glows) carries on.
 *
 * Callers branch on `on` / `rich` / `motion` rather than re-deriving any of
 * this, and the helpers here are all self-gating: calling `burst` on a basic
 * device is a no-op, not a crash.
 *
 * Mirrors the `audio` singleton: one instance, initialized once at boot, with
 * the Settings scene pushing changes into it live.
 */
class Effects {
  private ceiling: EffectsTier = "basic";
  private reduceMotion = false;
  private allowed = true;

  /**
   * Called once from BootScene, which is the earliest point the *live*
   * renderer type is known (the Game config asks for WebGL, but Phaser may
   * have fallen back to Canvas).
   */
  init(renderType: number, enabled: boolean): void {
    this.ceiling = detectEffectsTier(renderType);
    this.reduceMotion = prefersReducedMotion();
    this.allowed = enabled;
  }

  /** Live update from the Settings toggle. */
  setEnabled(enabled: boolean): void {
    this.allowed = enabled;
  }

  /** Any flourish at all beyond the base game's own feedback. */
  get on(): boolean {
    return this.allowed;
  }

  /** Extra draw calls are affordable: filter passes, particle bursts, and
   *  continuously animated background art. */
  get rich(): boolean {
    return this.allowed && this.ceiling === "full";
  }

  /** Things may move on their own: camera shake, ambient drift, tumble jitter,
   *  and the brightness hits (`flash`) that pair with them. */
  get motion(): boolean {
    return this.allowed && !this.reduceMotion;
  }

  /** The tier in force right now, for display and debugging. */
  get tier(): EffectsTier | "off" {
    return this.allowed ? this.ceiling : "off";
  }

  // ---- helpers -------------------------------------------------------------

  /**
   * A scale pop that returns to exactly where it started. Reads the object's
   * current scale as the base, so it composes with the responsive layout's own
   * `setScale` instead of fighting it — but that also means an in-flight punch
   * must be killed (not left to yoyo from a mid-tween base) before a new one
   * starts.
   */
  punch(
    scene: Phaser.Scene,
    target: Phaser.GameObjects.Components.Transform,
    amount = 1.14,
    duration = 130,
  ): void {
    if (!this.allowed) return;
    scene.tweens.killTweensOf(target);
    const baseX = target.scaleX;
    const baseY = target.scaleY;
    scene.tweens.add({
      targets: target,
      scaleX: baseX * amount,
      scaleY: baseY * amount,
      duration,
      yoyo: true,
      ease: "Quad.easeOut",
      onComplete: () => target.setScale(baseX, baseY),
    });
  }

  /** Camera shake, for impacts the whole screen should feel. */
  shakeCamera(
    camera: Phaser.Cameras.Scene2D.Camera,
    duration = 180,
    intensity = 0.006,
  ): void {
    if (!this.motion) return;
    camera.shake(duration, intensity);
  }

  /**
   * Shake a single object rather than a camera. The dice grid is drawn by its
   * own scrolling camera whose scroll is recomputed on every pan, zoom, and
   * dice-count change — a camera shake there would fight that bookkeeping, so
   * the grid container is displaced directly instead. Its position is owned by
   * nothing else, so restoring it on completion is safe.
   */
  shakeObject(
    scene: Phaser.Scene,
    target: Phaser.GameObjects.Components.Transform,
    duration = 180,
    intensity = 8,
  ): void {
    if (!this.motion) return;
    const baseX = target.x;
    const baseY = target.y;
    scene.tweens.killTweensOf(target);
    // Tweening a property of a private object, rather than a counter tween
    // read back through `getValue()`, keeps the driving value under this
    // call's own control — nothing else can be holding a handle to it.
    const shake = { decay: 1 };
    scene.tweens.add({
      targets: shake,
      decay: 0,
      duration,
      ease: "Quad.easeIn",
      onUpdate: () => {
        target.x =
          baseX + Phaser.Math.FloatBetween(-1, 1) * intensity * shake.decay;
        target.y =
          baseY + Phaser.Math.FloatBetween(-1, 1) * intensity * shake.decay;
      },
      onComplete: () => target.setPosition(baseX, baseY),
    });
  }

  /** Full-screen colour hit. Gated on `motion` alongside shake: both are
   *  intensity effects, and reduce-motion is the closest signal we have that
   *  the player doesn't want the screen lunging at them. */
  flash(
    camera: Phaser.Cameras.Scene2D.Camera,
    color: number,
    duration = 320,
  ): void {
    if (!this.motion) return;
    const { red, green, blue } = Phaser.Display.Color.IntegerToColor(color);
    camera.flash(duration, red, green, blue);
  }

  /**
   * Ease a displayed number up to its new value. Scores are bigints and get
   * astronomically large in a winning run, so the interpolation is done in
   * bigint against a fixed-point progress rather than through a float that
   * would lose the low digits exactly when they're most visible.
   *
   * With effects off, the value snaps — callers get one `onUpdate(to)` and no
   * tween, so they don't need a separate code path.
   */
  countUp(
    scene: Phaser.Scene,
    from: bigint,
    to: bigint,
    duration: number,
    onUpdate: (value: bigint) => void,
  ): Phaser.Time.TimerEvent | undefined {
    if (!this.allowed || from === to) {
      onUpdate(to);
      return undefined;
    }
    // Driven off the scene clock rather than through a tween. A tween would
    // need a scratch object to interpolate, and the natural property names for
    // "how far along am I" (`progress`, `value`) are also keys Phaser's tween
    // builder reads as its own config, which makes the setup easy to get
    // subtly wrong. Reading the clock is a line longer and has no such edges.
    const STEPS = 1000n;
    const delta = to - from;
    const startedAt = scene.time.now;
    const event = scene.time.addEvent({
      delay: 16,
      loop: true,
      callback: () => {
        const t = Math.min(1, (scene.time.now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - t, 3); // cubic ease-out
        const steps = BigInt(Math.round(eased * 1000));
        onUpdate(t >= 1 ? to : from + (delta * steps) / STEPS);
        if (t >= 1) event.remove();
      },
    });
    return event;
  }

  /**
   * Attach a glow filter, returning its controller so callers can tween the
   * strength. Rich tier only: Phaser 4 filters are WebGL-only and cost this
   * object an extra render-to-texture plus a pass per filter, so this is for
   * the handful of always-on focal points (the roll seal, a rare shop card) —
   * never anything that scales with the dice count.
   */
  glow(
    target: Phaser.GameObjects.GameObject,
    color: number,
    outerStrength = 4,
  ): Phaser.Filters.Glow | undefined {
    if (!this.rich) return undefined;
    target.enableFilters();
    return target.filters?.external.addGlow(color, outerStrength, 0, 1);
  }

  /**
   * One-shot particle burst that cleans itself up. Rich tier only.
   * `tint` and `count` carry the weight of the moment; everything else is
   * tuned once here so bursts across the game read as the same material.
   */
  burst(
    scene: Phaser.Scene,
    x: number,
    y: number,
    opts: {
      count?: number;
      tint?: number;
      speed?: number;
      lifespan?: number;
      gravityY?: number;
      scale?: number;
    } = {},
  ): Phaser.GameObjects.Particles.ParticleEmitter | undefined {
    if (!this.rich) return undefined;
    const {
      count = 14,
      tint = 0xffd977,
      speed = 200,
      lifespan = 620,
      gravityY = 260,
      scale = 0.8,
    } = opts;

    const emitter = scene.add.particles(x, y, "spark", {
      speed: { min: speed * 0.35, max: speed },
      angle: { min: 0, max: 360 },
      lifespan: { min: lifespan * 0.6, max: lifespan },
      scale: { start: scale, end: 0 },
      alpha: { start: 1, end: 0 },
      gravityY,
      tint,
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
    });
    emitter.setDepth(60);
    emitter.explode(count);
    // Emitters don't self-destroy after an explode; give the longest-lived
    // particle time to fade before tearing the whole thing down.
    scene.time.delayedCall(lifespan + 200, () => emitter.destroy());
    return emitter;
  }

  /**
   * An expanding, fading ring — the "something just happened here" cue, used
   * for the roll press and for round transitions. Cheap enough (one image, one
   * tween) to run at any tier the player has left on.
   */
  shockwave(
    scene: Phaser.Scene,
    x: number,
    y: number,
    radius: number,
    color = 0xffd977,
    duration = 420,
  ): Phaser.GameObjects.Image | undefined {
    if (!this.allowed) return undefined;
    const ring = scene.add
      .image(x, y, "shockwave")
      .setTint(color)
      .setDepth(55)
      .setAlpha(0.75)
      .setBlendMode(Phaser.BlendModes.ADD);
    const startScale = (radius * 0.6) / (ring.width / 2);
    const endScale = (radius * 1.8) / (ring.width / 2);
    ring.setScale(startScale);
    scene.tweens.add({
      targets: ring,
      scaleX: endScale,
      scaleY: endScale,
      alpha: 0,
      duration,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
    return ring;
  }
}

export const fx = new Effects();
