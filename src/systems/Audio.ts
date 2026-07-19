// All audio is synthesized with WebAudio: no binary assets.
// SFX are short envelopes; "music" is a low generative drone befitting a dice cult.

class AudioBus {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private droneNodes: AudioNode[] = [];

  musicVol = 0.5;
  sfxVol = 0.7;

  /** Create/resume the context. Must be called from a user-gesture handler. */
  ensure(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.musicGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.musicGain.connect(this.ctx.destination);
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
    if (this.musicGain) this.musicGain.gain.value = this.musicVol * 0.16;
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVol * 0.9;
  }

  // ---- music: ambient drone ------------------------------------------------

  startDrone(): void {
    this.ensure();
    if (!this.ctx || !this.musicGain || this.droneNodes.length > 0) return;
    const ctx = this.ctx;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    filter.Q.value = 1.2;
    filter.connect(this.musicGain);

    const freqs = [55, 82.5, 110.3]; // A1, E2, slightly detuned A2
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.33;
      osc.connect(g);
      g.connect(filter);
      osc.start();
      this.droneNodes.push(osc, g);
    }

    // Slow LFO breathing on the filter cutoff.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();
    this.droneNodes.push(lfo, lfoGain, filter);

    // A faint high shimmer.
    const shimmer = ctx.createOscillator();
    shimmer.type = 'sine';
    shimmer.frequency.value = 660;
    const sg = ctx.createGain();
    sg.gain.value = 0.015;
    shimmer.connect(sg);
    sg.connect(this.musicGain);
    shimmer.start();
    this.droneNodes.push(shimmer, sg);
  }

  stopDrone(): void {
    for (const node of this.droneNodes) {
      if (node instanceof OscillatorNode) {
        try {
          node.stop();
        } catch {
          // already stopped
        }
      }
      node.disconnect();
    }
    this.droneNodes = [];
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
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => this.tone(f, 0.3, 'triangle', i * 0.08, 0.24));
    this.tone(261.63, 0.6, 'sawtooth', 0, 0.08);
  }

  dud(): void {
    this.ensure();
    this.tone(140, 0.15, 'sine', 0, 0.1);
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
    const notes = [392, 493.88, 587.33, 783.99];
    notes.forEach((f, i) => this.tone(f, 0.3, 'triangle', i * 0.1, 0.22));
  }

  gameOver(): void {
    this.ensure();
    const notes = [440, 349.23, 293.66, 220];
    notes.forEach((f, i) => this.tone(f, 0.5, 'sawtooth', i * 0.22, 0.12));
  }
}

export const audio = new AudioBus();
