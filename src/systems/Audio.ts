import pranceUrl from '../../audio/songs/prance.mp3?url';

// SFX are synthesized with WebAudio; background music is a decoded, natively
// looped buffer routed through the same bus.

const PRANCE_SAMPLE_RATE = 44_100;
const PRANCE_LOOP_START = 174_832 / PRANCE_SAMPLE_RATE;
const PRANCE_LOOP_END = 3_703_086 / PRANCE_SAMPLE_RATE;
const MUSIC_TRIM = 0.16;
const DUCK_ATTACK_SECONDS = 0.02;

class AudioBus {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private musicDuckGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicLoad: Promise<void> | null = null;
  private duckUntil = 0;

  musicVol = 0.5;
  sfxVol = 0.7;

  /** Create/resume the context. Must be called from a user-gesture handler. */
  ensure(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.musicGain = this.ctx.createGain();
      this.musicDuckGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.musicGain.connect(this.musicDuckGain);
      this.musicDuckGain.connect(this.ctx.destination);
      this.sfxGain.connect(this.ctx.destination);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(musicVol: number, sfxVol: number): void {
    this.musicVol = musicVol;
    this.sfxVol = sfxVol;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (this.musicGain) this.musicGain.gain.value = this.musicVol * MUSIC_TRIM;
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVol * 0.9;
  }

  // ---- music ---------------------------------------------------------------

  /** Start the soundtrack once and let it persist across scene changes. */
  startMusic(): void {
    this.ensure();
    if (!this.ctx || !this.musicGain || this.musicSource || this.musicLoad) return;
    const ctx = this.ctx;
    const destination = this.musicGain;

    this.musicLoad = (async () => {
      const response = await fetch(pranceUrl);
      if (!response.ok) throw new Error(`Unable to load soundtrack (${response.status})`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = Math.min(PRANCE_LOOP_START, buffer.duration);
      source.loopEnd = Math.min(PRANCE_LOOP_END, buffer.duration);
      source.connect(destination);
      source.start(0, source.loopStart);
      this.musicSource = source;
    })()
      .catch((error: unknown) => {
        console.warn('Unable to start background music', error);
      })
      .finally(() => {
        this.musicLoad = null;
      });
  }

  /** Briefly lower the music for a prominent cue, then restore it smoothly. */
  private duckMusic(level: number, holdSeconds: number, releaseSeconds: number): void {
    if (!this.ctx || !this.musicDuckGain) return;
    const now = this.ctx.currentTime;
    this.duckUntil = Math.max(this.duckUntil, now + holdSeconds);

    const gain = this.musicDuckGain.gain;
    gain.cancelAndHoldAtTime(now);
    gain.linearRampToValueAtTime(level, now + DUCK_ATTACK_SECONDS);
    gain.setValueAtTime(level, this.duckUntil);
    gain.linearRampToValueAtTime(1, this.duckUntil + releaseSeconds);
  }

  // ---- sfx -----------------------------------------------------------------

  private tone(freq: number, dur: number, type: OscillatorType, delay = 0, peak = 0.25): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noiseBurst(dur: number, delay = 0, peak = 0.3, cutoff = 2400): void {
    if (!this.ctx || !this.sfxGain) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = peak;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t0);
  }

  click(): void {
    this.ensure();
    this.tone(880, 0.06, 'triangle', 0, 0.12);
  }

  roll(diceCount: number): void {
    this.ensure();
    const bursts = Math.min(8, 2 + Math.ceil(diceCount / 4));
    for (let i = 0; i < bursts; i++) {
      this.noiseBurst(0.05 + Math.random() * 0.04, i * 0.06 + Math.random() * 0.03, 0.22, 1800 + Math.random() * 1600);
    }
  }

  score(points: number): void {
    this.ensure();
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    const count = Math.min(4, 1 + Math.floor(points / 3));
    for (let i = 0; i < count; i++) this.tone(notes[i], 0.22, 'triangle', i * 0.07, 0.2);
  }

  jackpot(): void {
    this.ensure();
    this.duckMusic(0.3, 0.8, 0.4);
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => this.tone(f, 0.3, 'triangle', i * 0.08, 0.24));
    this.tone(261.63, 0.6, 'sawtooth', 0, 0.08);
  }

  dud(): void {
    this.ensure();
    this.tone(140, 0.15, 'sine', 0, 0.1);
  }

  /** Whetstone filing a die down a step: a short metallic grind (filtered
   *  noise scrape) plus a quick descending chirp. */
  shrink(): void {
    this.ensure();
    this.noiseBurst(0.14, 0, 0.16, 1100);
    this.tone(720, 0.13, 'triangle', 0, 0.13);
    this.tone(520, 0.16, 'triangle', 0.07, 0.11);
  }

  buy(): void {
    this.ensure();
    this.tone(659.25, 0.12, 'triangle', 0, 0.2);
    this.tone(987.77, 0.18, 'triangle', 0.09, 0.2);
  }

  deny(): void {
    this.ensure();
    this.tone(196, 0.2, 'square', 0, 0.08);
    this.tone(185, 0.25, 'square', 0.1, 0.08);
  }

  roundUp(): void {
    this.ensure();
    this.duckMusic(0.35, 0.7, 0.4);
    const notes = [392, 493.88, 587.33, 783.99];
    notes.forEach((f, i) => this.tone(f, 0.3, 'triangle', i * 0.1, 0.22));
  }

  gameOver(): void {
    this.ensure();
    this.duckMusic(0.25, 1.3, 0.5);
    const notes = [440, 349.23, 293.66, 220];
    notes.forEach((f, i) => this.tone(f, 0.5, 'sawtooth', i * 0.22, 0.12));
  }

  victory(): void {
    this.ensure();
    this.duckMusic(0.2, 2, 0.6);
    // Rising major arpeggio (C-E-G-C-E-G) resolving on a held high C,
    // over a sustained low root — grander and longer than jackpot().
    const arp = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
    arp.forEach((f, i) => this.tone(f, 0.3, 'triangle', i * 0.12, 0.22));
    this.tone(2093, 1.2, 'triangle', arp.length * 0.12, 0.24); // held high C7
    this.tone(130.81, 1.6, 'sawtooth', 0, 0.09); // sustained low C3 root
  }
}

export const audio = new AudioBus();
