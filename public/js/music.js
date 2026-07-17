/* 🎵 Procedural synthwave loop for game modes — no audio files.
 *
 * A tiny step sequencer on Web Audio: 64 16th-note steps over a 4-chord
 * minor progression. `setLevel(0..4)` layers instruments in and pushes the
 * tempo, so the track gets more intense the deeper you get:
 *   L0: pulsing bass + kick          (ambient menace)
 *   L1: + snare backbeat, offbeat hats
 *   L2: + 16th-note arpeggio
 *   L3: + detuned pad chords, driving hats
 *   L4: + lead octave stabs, max tempo, filter wide open
 */

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Am — F — C — G (roots kept above ~85 Hz so phone speakers can carry them)
const PROG = [45, 41, 48, 43];
// chord tones as semitone offsets for arp/pad (minor / major shapes)
const SHAPES = { 45: [0, 3, 7, 12], 41: [0, 4, 7, 12], 48: [0, 4, 7, 12], 43: [0, 4, 7, 12] };

export class MusicEngine {
  constructor() {
    this.level = 0;
    this.playing = false;
    this.muted = localStorage.getItem('camfun-music') === 'off';
  }

  start(ctx) {
    if (this.playing || !ctx) return;
    this.ctx = ctx;

    // one reusable noise buffer for hats/snares
    if (!this.noiseBuf) {
      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.15;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1100;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.master);
    this.master.connect(ctx.destination);

    this.step = 0;
    this.nextT = ctx.currentTime + 0.08;
    this.playing = true;
    this.applyLevel();
    this.timer = setInterval(() => this.pump(), 30);
  }

  stop(hard = false) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    const m = this.master, t = this.ctx.currentTime;
    if (hard) {
      m.disconnect();
    } else {
      m.gain.setValueAtTime(m.gain.value, t);
      m.gain.linearRampToValueAtTime(0, t + 0.8);
      setTimeout(() => { try { m.disconnect(); } catch (e) { /* ctx closed */ } }, 900);
    }
  }

  setLevel(n) {
    this.level = Math.max(0, Math.min(4, n));
    if (this.playing) this.applyLevel();
  }

  applyLevel() {
    // filter opens up as things heat up
    const f = this.filter, t = this.ctx.currentTime;
    f.frequency.cancelScheduledValues(t);
    f.frequency.setValueAtTime(f.frequency.value, t);
    f.frequency.linearRampToValueAtTime(1100 + this.level * 1400, t + 1.2);
  }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem('camfun-music', m ? 'off' : 'on');
    if (this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(m ? 0 : 0.15, t + 0.2);
    }
  }

  /* 16th-note duration at the current level's tempo (96 → 132 BPM) */
  spb() { return 60 / (96 + this.level * 9) / 4; }

  pump() {
    if (!this.playing) return;
    while (this.nextT < this.ctx.currentTime + 0.14) {
      this.scheduleStep(this.step, this.nextT);
      this.nextT += this.spb();
      this.step = (this.step + 1) % 64;
    }
  }

  scheduleStep(step, t) {
    const root = PROG[Math.floor(step / 16)];
    const inBar = step % 16;
    const L = this.level;

    // bass: driving 8ths, accent on the downbeat
    if (step % 2 === 0) {
      this.tone({
        type: 'sawtooth', midi: root - 12, t,
        gain: inBar === 0 ? 0.22 : 0.15, dur: 0.2, decay: true,
      });
    }
    // kick on quarters
    if (step % 4 === 0) this.kick(t);
    // snare backbeat (beats 2 and 4)
    if (L >= 1 && step % 8 === 4) this.snare(t);
    // hats: offbeat 8ths at L1, every 16th from L3
    if ((L >= 1 && step % 4 === 2) || (L >= 3 && step % 2 === 1)) {
      this.hat(t, step % 4 === 2 ? 0.07 : 0.04);
    }
    // arpeggio: chord tones cycling on 16ths
    if (L >= 2) {
      const shape = SHAPES[root];
      this.tone({
        type: 'square', midi: root + 12 + shape[step % 4], t,
        gain: 0.045, dur: 0.09, decay: true,
      });
    }
    // pad: two detuned saws sustained across each chord
    if (L >= 3 && inBar === 0) {
      const barDur = this.spb() * 16;
      this.tone({ type: 'sawtooth', midi: root + 12, t, gain: 0.035, dur: barDur, detune: -7 });
      this.tone({ type: 'sawtooth', midi: root + 19, t, gain: 0.03, dur: barDur, detune: 7 });
    }
    // lead octave stabs riding the top at max intensity
    if (L >= 4 && (inBar === 0 || inBar === 6 || inBar === 10)) {
      this.tone({ type: 'square', midi: root + 24, t, gain: 0.05, dur: 0.16, decay: true });
    }
  }

  tone({ type, midi, t, gain, dur, decay = false, detune = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.value = midiHz(midi);
    o.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    if (decay) g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    else {
      g.gain.setValueAtTime(gain, t + dur - 0.08);
      g.gain.linearRampToValueAtTime(0, t + dur);
    }
    o.connect(g).connect(this.filter);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  kick(t) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    // straight to master: the kick shouldn't lose punch to the lowpass
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.2);
  }

  noiseHit(t, { dur, hp, gain }) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + dur + 0.02);
  }

  hat(t, gain) { this.noiseHit(t, { dur: 0.04, hp: 6500, gain }); }

  snare(t) {
    this.noiseHit(t, { dur: 0.14, hp: 1600, gain: 0.16 });
    this.tone({ type: 'triangle', midi: 55, t, gain: 0.08, dur: 0.08, decay: true });
  }
}
