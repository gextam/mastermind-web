/* ============================================================================
   ZEUS — synthesized sound engine (Web Audio, no external files).
   Mechanical reel sounds, thunder/lightning, harp (Karplus-Strong) plucks,
   bells, brass fanfares, pads, win roll-ups and two looping music beds.
   ========================================================================== */
(function (root) {
  'use strict';
  const ZEUS = root.ZEUS || (root.ZEUS = {});
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  function AudioEngine() {
    this.ctx = null;
    this.ready = false;
    this.volume = parseFloat(lsGet('mastermind.volume', '0.8'));
    /* ?mute=1 in the URL starts silent (handy for automated testing) */
    this.muted = lsGet('mastermind.muted', '0') === '1' || /[?&]mute=1/.test(root.location ? root.location.search : '');
    this._ks = new Map();
    this._rollupNodes = [];
    this._seq = null;
    this._loop = null;
    this._antic = null;
    this._lastTick = [];
    this._musicLevel = 0.5;
    this._pendingMusic = null;
  }
  const P = AudioEngine.prototype;

  /* ------------------------------------------------------------ setup */
  P.init = function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return false;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 18; this.comp.ratio.value = 5;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.22;
    this.master.connect(this.comp); this.comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = this._musicLevel; this.music.connect(this.master);
    this.reverb = ctx.createConvolver(); this.reverb.buffer = this._impulse(2.4, 3.0);
    this.reverbGain = ctx.createGain(); this.reverbGain.gain.value = 0.4;
    this.reverb.connect(this.reverbGain); this.reverbGain.connect(this.master);
    this.noiseBuf = this._noiseBuffer(2.0);
    this.shaper = ctx.createWaveShaper(); this.shaper.curve = this._distCurve(30);
    this.shaperOut = ctx.createGain(); this.shaperOut.gain.value = 0.5;
    this.shaper.connect(this.shaperOut); this.shaperOut.connect(this.sfx);
    this.ready = true;
    this._warm();
    if (this._pendingMusic) { const m = this._pendingMusic; this._pendingMusic = null; this.startMusic(m); }
    return true;
  };
  P._impulse = function (sec, decay) {
    const ctx = this.ctx, sr = ctx.sampleRate, len = Math.floor(sr * sec);
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1; lp += (w - lp) * 0.25;
        d[i] = lp * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  };
  P._noiseBuffer = function (sec) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  };
  P._distCurve = function (k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
    return c;
  };
  P._warm = function () {
    const notes = [50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 79, 81, 83, 86, 88];
    notes.forEach(n => this._ksBuffer(midi(n), 0.55));
  };
  P.now = function () { return this.ctx ? this.ctx.currentTime : 0; };
  P.setVolume = function (v) {
    this.volume = clamp(v, 0, 1); lsSet('mastermind.volume', String(this.volume));
    if (this.master && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.now(), 0.02);
  };
  P.setMuted = function (m) {
    this.muted = !!m; lsSet('mastermind.muted', m ? '1' : '0');
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.now(), 0.02);
  };
  P.toggleMute = function () { this.setMuted(!this.muted); return this.muted; };

  /* ------------------------------------------------------- primitives */
  P._g = function (v, dest, send) {
    const g = this.ctx.createGain(); g.gain.value = v; g.connect(dest || this.sfx);
    if (send) { const s = this.ctx.createGain(); s.gain.value = send; g.connect(s); s.connect(this.reverb); }
    return g;
  };
  P._adsr = function (param, t, peak, a, d, s, r, dur) {
    peak = Math.max(0.0002, peak);
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(peak, t + a);
    const sus = Math.max(0.0001, peak * s);
    param.exponentialRampToValueAtTime(sus, t + a + d);
    const rel = Math.max(t + a + d, t + dur);
    param.setValueAtTime(sus, rel);
    param.exponentialRampToValueAtTime(0.0001, rel + r);
    return rel + r;
  };
  P.tone = function (o) {
    const ctx = this.ctx, t = o.t != null ? o.t : ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(Math.max(1, o.freq), t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqEnd), t + (o.sweep || o.dur || 0.1));
    if (o.detune) osc.detune.value = o.detune;
    const g = this._g(1, o.dest, o.send);
    const end = this._adsr(g.gain, t, o.gain || 0.2, o.a || 0.005, o.d || 0.05, o.s == null ? 0.6 : o.s, o.r || 0.08, o.dur || 0.1);
    let node = osc;
    if (o.filter) {
      const f = ctx.createBiquadFilter(); f.type = o.filter.type || 'lowpass';
      f.frequency.setValueAtTime(o.filter.freq, t);
      if (o.filter.freqEnd) f.frequency.exponentialRampToValueAtTime(o.filter.freqEnd, t + (o.filter.sweep || o.dur || 0.1));
      f.Q.value = o.filter.Q || 0.7; osc.connect(f); node = f;
    }
    node.connect(g); osc.start(t); osc.stop(end + 0.05);
    return osc;
  };
  P.noise = function (o) {
    const ctx = this.ctx, t = o.t != null ? o.t : ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.freq || 1000, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(10, o.freqEnd), t + (o.sweep || o.dur || 0.1));
    f.Q.value = o.Q || 0.8;
    const g = this._g(1, o.dest, o.send);
    const end = this._adsr(g.gain, t, o.gain || 0.2, o.a || 0.002, o.d || 0.03, o.s == null ? 0.5 : o.s, o.r || 0.05, o.dur || 0.05);
    src.connect(f); f.connect(g); src.start(t, Math.random() * 1.5); src.stop(end + 0.05);
    return src;
  };
  P._ksBuffer = function (freq, bright) {
    const key = Math.round(freq * 10) + ':' + bright.toFixed(2);
    let buf = this._ks.get(key);
    if (buf) return buf;
    const ctx = this.ctx, sr = ctx.sampleRate, dur = 1.6;
    const N = Math.max(2, Math.round(sr / freq)), len = Math.floor(sr * dur);
    buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0), ring = new Float32Array(N);
    let last = 0;
    for (let i = 0; i < N; i++) { const w = Math.random() * 2 - 1; last += (w - last) * (0.25 + 0.75 * bright); ring[i] = last; }
    const decay = Math.exp(Math.log(0.12) / Math.max(40, freq));
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const cur = ring[idx], nxt = ring[(idx + 1) % N];
      d[i] = cur; ring[idx] = decay * 0.5 * (cur + nxt); idx = (idx + 1) % N;
    }
    this._ks.set(key, buf);
    return buf;
  };
  P.pluck = function (freq, t, o) {
    o = o || {};
    const ctx = this.ctx, src = ctx.createBufferSource();
    src.buffer = this._ksBuffer(freq, o.bright == null ? 0.55 : o.bright);
    const g = this._g(o.gain || 0.3, o.dest, o.send == null ? 0.35 : o.send);
    src.connect(g); src.start(t); src.stop(t + (o.dur || 1.6));
    return src;
  };
  P.bell = function (freq, t, o) {
    o = o || {};
    const ratios = [1, 2.0, 3.0, 4.16, 5.43], amps = [1, 0.5, 0.3, 0.18, 0.12];
    const dur = o.dur || 1.4, gain = o.gain || 0.2;
    ratios.forEach((r, i) => this.tone({ t: t, freq: freq * r, gain: gain * amps[i], a: 0.002, d: dur * (1 - i * 0.14), s: 0.001, r: 0.1, dur: dur * (1 - i * 0.14), send: 0.5, dest: o.dest }));
  };
  P.brass = function (freq, t, dur, gain, dest) {
    [-7, 0, 7].forEach(det => this.tone({
      t: t, type: 'sawtooth', freq: freq, detune: det, gain: (gain || 0.15) / 3, a: 0.04, d: 0.12, s: 0.75, r: 0.18, dur: dur,
      filter: { type: 'lowpass', freq: 500, freqEnd: 2600, sweep: 0.12, Q: 1.2 }, send: 0.35, dest: dest
    }));
  };
  P.pad = function (freqs, t, dur, gain, o) {
    o = o || {};
    const per = (gain || 0.08) / freqs.length / 2;
    freqs.forEach(f => [-5, 5].forEach(det => this.tone({
      t: t, type: o.type || 'sawtooth', freq: f, detune: det, gain: per, a: o.a || 0.7, d: 0.3, s: 0.85, r: o.r || 1.2, dur: dur,
      filter: { type: 'lowpass', freq: o.cut || 900, Q: 0.5 }, send: 0.6, dest: o.dest
    })));
  };
  P.thump = function (t, o) {
    o = o || {};
    const f = o.freq || 90;
    this.tone({ t: t, freq: f, freqEnd: f * 0.45, sweep: o.dur || 0.12, gain: o.gain || 0.5, a: 0.002, d: 0.08, s: 0.3, r: 0.08, dur: o.dur || 0.12, send: o.send || 0.1, dest: o.dest });
  };
  P.thunder = function (t, o) {
    o = o || {};
    const ctx = this.ctx, inten = o.intensity == null ? 1 : o.intensity, dur = o.dur || 2.2;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(300 + 900 * inten, t); f.frequency.exponentialRampToValueAtTime(45, t + dur);
    const g = ctx.createGain();
    const n = 64, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      curve[i] = Math.min(1, u * 12) * Math.pow(1 - u, 1.6) * (0.55 + 0.45 * Math.random()) * 0.9 * inten;
    }
    curve[0] = 0.0001; curve[n - 1] = 0.0001;
    g.gain.setValueCurveAtTime(curve, t, dur);
    src.connect(f); f.connect(g); g.connect(o.dest || this.sfx);
    const s = ctx.createGain(); s.gain.value = 0.7; g.connect(s); s.connect(this.reverb);
    src.start(t, Math.random()); src.stop(t + dur + 0.1);
    this.tone({ t: t, freq: 48 + 10 * Math.random(), freqEnd: 28, sweep: dur, gain: 0.45 * inten, a: 0.03, d: dur * 0.6, s: 0.15, r: dur * 0.3, dur: dur * 0.6, dest: o.dest });
    if (inten > 0.6) this.noise({ t: t, type: 'highpass', freq: 900, gain: 0.5 * inten, a: 0.001, d: 0.05, s: 0.2, r: 0.06, dur: 0.05, dest: o.dest, send: 0.6 });
  };
  P.zap = function (t, o) {
    o = o || {};
    const g = o.gain || 0.4, ctx = this.ctx;
    this.noise({ t: t, type: 'bandpass', freq: 7000, freqEnd: 250, sweep: 0.22, Q: 1.2, gain: g, a: 0.001, d: 0.18, s: 0.05, r: 0.08, dur: 0.18, send: 0.5 });
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(2600, t); osc.frequency.exponentialRampToValueAtTime(90, t + 0.16);
    const gg = ctx.createGain(); this._adsr(gg.gain, t, g * 0.5, 0.001, 0.12, 0.05, 0.05, 0.12);
    osc.connect(gg); gg.connect(this.shaper); osc.start(t); osc.stop(t + 0.3);
    for (let i = 0; i < 6; i++) this.noise({ t: t + 0.02 + Math.random() * 0.2, type: 'highpass', freq: 4000, gain: g * 0.3, dur: 0.006, d: 0.008, s: 0.1, r: 0.01 });
  };

  /* --------------------------------------------------------------- UI */
  P.click = function () {
    if (!this.ready) return; const t = this.now();
    this.noise({ t: t, type: 'highpass', freq: 2500, gain: 0.18, dur: 0.012, d: 0.012, s: 0.2, r: 0.02 });
    this.tone({ t: t, freq: 2200, freqEnd: 1600, gain: 0.07, a: 0.001, d: 0.02, s: 0.1, r: 0.02, dur: 0.02 });
  };
  P.tick = function () {
    if (!this.ready) return; const t = this.now();
    this.tone({ t: t, freq: 1800, gain: 0.07, a: 0.001, d: 0.03, s: 0.1, r: 0.02, dur: 0.03 });
    this.noise({ t: t, type: 'highpass', freq: 3000, gain: 0.1, dur: 0.008, d: 0.01, s: 0.1, r: 0.01 });
  };
  P.deny = function () {
    if (!this.ready) return; const t = this.now();
    this.tone({ t: t, type: 'square', freq: 160, gain: 0.07, a: 0.005, d: 0.1, s: 0.5, r: 0.05, dur: 0.14, filter: { type: 'lowpass', freq: 900 } });
  };
  P.coinIn = function () {
    if (!this.ready) return; const t = this.now();
    [3200, 4100, 5200].forEach((f, i) => this.bell(f * (0.95 + Math.random() * 0.1), t + i * 0.06, { gain: 0.06, dur: 0.45 }));
  };

  /* ------------------------------------------------------------- reels */
  P.spinStart = function () {
    if (!this.ready) return; const t = this.now();
    this.thump(t, { freq: 150, gain: 0.35, dur: 0.07 });
    this.noise({ t: t, type: 'bandpass', freq: 1400, Q: 2, gain: 0.35, dur: 0.03, d: 0.03, s: 0.3, r: 0.03 });
    this.noise({ t: t + 0.02, type: 'bandpass', freq: 500, freqEnd: 2600, sweep: 0.4, Q: 1, gain: 0.12, a: 0.05, d: 0.2, s: 0.5, r: 0.15, dur: 0.3 });
    this.spinLoopStart();
  };
  P.spinLoopStart = function () {
    if (!this.ready || this._loop) return;
    const ctx = this.ctx, t = this.now();
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400; f.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.sfx); src.start(t);
    const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 47;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 160;
    const hg = ctx.createGain(); hg.gain.value = 0;
    hum.connect(hf); hf.connect(hg); hg.connect(this.sfx); hum.start(t);
    this._loop = { src: src, f: f, g: g, hum: hum, hg: hg };
  };
  P.spinLoopSet = function (s) {
    if (!this._loop) return; s = clamp(s, 0, 1); const t = this.now();
    this._loop.g.gain.setTargetAtTime(0.16 * s, t, 0.05);
    this._loop.f.frequency.setTargetAtTime(300 + 1100 * s, t, 0.05);
    this._loop.hg.gain.setTargetAtTime(0.03 * s, t, 0.05);
  };
  P.spinLoopStop = function () {
    if (!this._loop) return; const l = this._loop, t = this.now();
    l.g.gain.setTargetAtTime(0, t, 0.08); l.hg.gain.setTargetAtTime(0, t, 0.08);
    l.src.stop(t + 0.5); l.hum.stop(t + 0.5); this._loop = null;
  };
  P.reelTick = function (i) {
    if (!this.ready) return; const t = this.now();
    if (t - (this._lastTick[i] || 0) < 0.03) return;
    this._lastTick[i] = t;
    this.noise({ t: t, type: 'highpass', freq: 3000, gain: 0.045, dur: 0.008, d: 0.01, s: 0.1, r: 0.01 });
  };
  P.reelStop = function (i) {
    if (!this.ready) return; const t = this.now(), k = 1 + i * 0.035;
    this.thump(t, { freq: 115 * k, gain: 0.55, dur: 0.09 });
    this.noise({ t: t, type: 'lowpass', freq: 700, gain: 0.45, dur: 0.035, d: 0.04, s: 0.2, r: 0.04 });
    this.noise({ t: t, type: 'highpass', freq: 1800, gain: 0.25, dur: 0.006, d: 0.008, s: 0.1, r: 0.01 });
    this.tone({ t: t + 0.005, freq: 420 * k, freqEnd: 300 * k, sweep: 0.05, gain: 0.05, a: 0.001, d: 0.04, s: 0.1, r: 0.03, dur: 0.04 });
  };
  P.anticipationStart = function () {
    if (!this.ready || this._antic) return;
    const ctx = this.ctx, t = this.now();
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, t); osc.frequency.exponentialRampToValueAtTime(110, t + 2.6);
    const osc2 = ctx.createOscillator(); osc2.type = 'sawtooth';
    osc2.frequency.setValueAtTime(55.5, t); osc2.frequency.exponentialRampToValueAtTime(111, t + 2.6);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(160, t); f.frequency.exponentialRampToValueAtTime(2400, t + 2.6);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.14, t + 0.25);
    const trem = ctx.createGain(); trem.gain.value = 1;
    const lfo = ctx.createOscillator(); lfo.frequency.setValueAtTime(5, t); lfo.frequency.linearRampToValueAtTime(12, t + 2.6);
    const lg = ctx.createGain(); lg.gain.value = 0.5; lfo.connect(lg); lg.connect(trem.gain);
    osc.connect(f); osc2.connect(f); f.connect(trem); trem.connect(g); g.connect(this.sfx);
    const s = ctx.createGain(); s.gain.value = 0.4; g.connect(s); s.connect(this.reverb);
    osc.start(t); osc2.start(t); lfo.start(t);
    for (let k = 0; k < 7; k++) this.thump(t + 0.1 + k * 0.42 * Math.pow(0.93, k), { freq: 75, gain: 0.35, dur: 0.1 });
    for (let k = 0; k < 14; k++) this.noise({ t: t + Math.random() * 2.6, type: 'highpass', freq: 3500, gain: 0.06, dur: 0.006, d: 0.008, s: 0.1, r: 0.01 });
    this._antic = { osc: osc, osc2: osc2, lfo: lfo, g: g };
  };
  P.anticipationStop = function () {
    const a = this._antic; if (!a) return; const t = this.now();
    a.g.gain.cancelScheduledValues(t); a.g.gain.setValueAtTime(a.g.gain.value, t); a.g.gain.linearRampToValueAtTime(0, t + 0.12);
    a.osc.stop(t + 0.2); a.osc2.stop(t + 0.2); a.lfo.stop(t + 0.2); this._antic = null;
  };
  P.scatterLand = function (n) {
    if (!this.ready) return; const t = this.now();
    this.zap(t, { gain: 0.3 + 0.12 * n });
    this.thunder(t + 0.03, { intensity: 0.45 + 0.28 * n, dur: 1.2 + 0.5 * n });
  };
  P.wildLand = function () {
    if (!this.ready) return; const t = this.now();
    [1568, 1976, 2637].forEach((f, i) => this.bell(f, t + i * 0.05, { gain: 0.06, dur: 0.6 }));
    this.noise({ t: t, type: 'bandpass', freq: 5000, freqEnd: 9000, sweep: 0.2, Q: 3, gain: 0.08, dur: 0.2, a: 0.01, d: 0.1, s: 0.3, r: 0.1 });
  };
  P.zeusLand = function () {
    if (!this.ready) return; const t = this.now();
    this.pad([midi(40), midi(47), midi(52)], t, 0.9, 0.12, { cut: 1500, a: 0.05, r: 0.5 });
    this.noise({ t: t, type: 'bandpass', freq: 3000, freqEnd: 6000, sweep: 0.3, Q: 2, gain: 0.08, dur: 0.3, a: 0.01, d: 0.2, s: 0.3, r: 0.2 });
    for (let i = 0; i < 5; i++) this.noise({ t: t + Math.random() * 0.4, type: 'highpass', freq: 4000, gain: 0.08, dur: 0.006, d: 0.008, s: 0.1, r: 0.01 });
  };

  /* -------------------------------------------------------------- wins */
  const SCALE = [64, 67, 69, 71, 74, 76, 79, 81, 83, 86, 88, 91];
  P.lineWin = function (level, i) {
    if (!this.ready) return; const t = this.now();
    const n = 4 + level * 2, start = (i || 0) % 3;
    for (let k = 0; k < n; k++) this.pluck(midi(SCALE[(start + k) % SCALE.length]), t + k * 0.045, { gain: 0.2, dur: 1.2, send: 0.4 });
    if (level >= 1) this.bell(midi(SCALE[(start + n - 1) % SCALE.length]), t + n * 0.045, { gain: 0.1, dur: 1.2 });
    if (level >= 2) this.pad([midi(52), midi(59), midi(64)], t, 1.0, 0.08, { cut: 1200, a: 0.1, r: 0.6 });
  };
  P.rollupStart = function (duration, ratio) {
    if (!this.ready) return; this.rollupStop(false);
    const t = this.now(), step = ratio >= 15 ? 0.04 : 0.055;
    const n = Math.max(3, Math.floor(duration / step)), notes = [76, 79, 83, 88];
    for (let k = 0; k < n; k++) {
      const f = midi(notes[k % 4] + Math.min(7, Math.floor(k / 16)));
      this._rollupNodes.push(this.tone({ t: t + k * step, freq: f, gain: 0.085, a: 0.002, d: 0.045, s: 0.001, r: 0.02, dur: 0.045 }));
      this._rollupNodes.push(this.tone({ t: t + k * step, freq: f * 2, gain: 0.03, a: 0.002, d: 0.03, s: 0.001, r: 0.02, dur: 0.03 }));
    }
  };
  P.rollupStop = function (finalDing) {
    if (!this.ready) return; const t = this.now();
    this._rollupNodes.forEach(o => { try { o.stop(t); } catch (e) { /* already stopped */ } });
    this._rollupNodes = [];
    if (finalDing) { this.bell(midi(88), t, { gain: 0.16, dur: 1.6 }); this.bell(midi(95), t + 0.04, { gain: 0.1, dur: 1.6 }); }
  };
  P.bigWin = function (tier) {
    if (!this.ready) return; const t = this.now();
    this.duck(3 + tier);
    this.thunder(t, { intensity: 0.8 + 0.3 * tier, dur: 2.5 });
    this.noise({ t: t + 0.02, type: 'highpass', freq: 5000, gain: 0.18, a: 0.005, d: 1.6, s: 0.001, r: 0.3, dur: 1.6 });
    const chords = [[52, 56, 59], [57, 61, 64], [59, 63, 66], [64, 68, 71]], durs = [0.32, 0.32, 0.32, 1.8];
    let tt = t + 0.1;
    chords.forEach((ch, i) => {
      ch.forEach(n => this.brass(midi(n), tt, durs[i], 0.11 + 0.02 * tier));
      if (i === 3) { ch.forEach(n => this.brass(midi(n - 12), tt, durs[i], 0.08)); this.bell(midi(ch[0] + 12), tt, { gain: 0.12, dur: 2 }); }
      tt += durs[i] + 0.04;
    });
    for (let k = 0; k < 8; k++) this.thump(t + k * 0.07, { freq: 70, gain: 0.3, dur: 0.1 });
    if (tier >= 2) this.pad([midi(40), midi(47), midi(52), midi(56)], t + 0.3, 3.5, 0.12, { cut: 1400 });
    if (tier >= 3) for (let k = 0; k < 3; k++) this.thunder(t + 0.8 + k * 0.9, { intensity: 1, dur: 2 });
  };
  P.coinShower = function (duration) {
    if (!this.ready) return; const t = this.now();
    const n = Math.floor(duration / 0.09);
    for (let k = 0; k < n; k++) this.bell(2500 + Math.random() * 2700, t + k * 0.09 + Math.random() * 0.05, { gain: 0.035, dur: 0.4 });
  };
  P.featureTrigger = function () {
    if (!this.ready) return; const t = this.now();
    this.duck(4.5);
    this.zap(t, { gain: 0.6 });
    this.thunder(t + 0.05, { intensity: 1.3, dur: 3 });
    this.pad([midi(40), midi(47), midi(52), midi(55)], t + 0.2, 2.2, 0.14, { cut: 1200 });
    const tt = t + 1.2;
    [[52, 55, 59], [52, 56, 59]].forEach((ch, i) => ch.forEach(n => this.brass(midi(n), tt + i * 0.5, i ? 1.8 : 0.45, 0.12)));
    for (let k = 0; k < 6; k++) this.thump(t + 0.9 + k * 0.09, { freq: 65, gain: 0.35, dur: 0.12 });
  };
  P.banner = function () {
    if (!this.ready) return; const t = this.now();
    [64, 68, 71, 76].forEach((n, i) => this.bell(midi(n), t + i * 0.07, { gain: 0.11, dur: 1.6 }));
  };
  P.freeSpinsEnd = function () {
    if (!this.ready) return; const t = this.now();
    this.duck(3);
    [64, 68, 71, 76].forEach((n, i) => this.bell(midi(n), t + i * 0.08, { gain: 0.12, dur: 1.8 }));
    [52, 56, 59, 64].forEach(n => this.brass(midi(n), t + 0.3, 1.6, 0.09));
    this.noise({ t: t + 0.3, type: 'highpass', freq: 5000, gain: 0.12, a: 0.005, d: 1.4, s: 0.001, r: 0.3, dur: 1.4 });
  };
  P.lightning = function (intensity) {
    if (!this.ready) return; const t = this.now();
    intensity = intensity == null ? 1 : intensity;
    this.zap(t, { gain: 0.3 * intensity });
    this.thunder(t + 0.08 + Math.random() * 0.2, { intensity: intensity, dur: 1.5 + intensity });
  };
  P.duck = function (sec) {
    if (!this.music) return; const t = this.now();
    this.music.gain.cancelScheduledValues(t);
    this.music.gain.setTargetAtTime(0.12, t, 0.05);
    this.music.gain.setTargetAtTime(this._musicLevel, t + sec, 0.4);
  };

  /* ------------------------------------------------------------- music */
  P.startMusic = function (mode) {
    if (!this.ready) { this._pendingMusic = mode; return; }
    if (this._seq && this._seq.mode === mode) return;
    this.stopMusic(0.8);
    const ctx = this.ctx;
    const seq = { mode: mode, step: 0, bar: 0, next: this.now() + 0.15, bpm: mode === 'free' ? 116 : 64 };
    this._musicLevel = mode === 'free' ? 0.6 : 0.5;
    this.music.gain.cancelScheduledValues(this.now());
    this.music.gain.setTargetAtTime(this._musicLevel, this.now(), 0.5);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = mode === 'free' ? 520 : 380; f.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.music); src.start();
    g.gain.setTargetAtTime(mode === 'free' ? 0.06 : 0.04, this.now(), 1.0);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
    const lg = ctx.createGain(); lg.gain.value = 150; lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    seq.wind = { src: src, g: g, lfo: lfo };
    seq.timer = setInterval(() => this._pump(), 30);
    this._seq = seq;
  };
  P.stopMusic = function (fade) {
    const s = this._seq; if (!s) return;
    clearInterval(s.timer);
    const t = this.now(); fade = fade || 0.5;
    s.wind.g.gain.setTargetAtTime(0, t, fade / 3);
    s.wind.src.stop(t + fade + 0.5); s.wind.lfo.stop(t + fade + 0.5);
    this._seq = null;
  };
  P._pump = function () {
    const s = this._seq; if (!s || !this.ctx) return;
    const horizon = this.now() + 0.18, stepDur = 60 / s.bpm / 4;
    let guard = 0;
    while (s.next < horizon && guard++ < 64) {
      if (s.next >= this.now() - 0.05) this._playStep(s, s.next, stepDur);
      s.step++; if (s.step % 16 === 0) s.bar++;
      s.next += stepDur;
    }
  };
  const BASE_PROG = [[52, 55, 59], [53, 57, 60], [52, 55, 59], [50, 53, 57]];      // Em F Em Dm (phrygian colour)
  const FREE_PROG = [[52, 55, 59], [52, 55, 59], [48, 52, 55], [47, 51, 54]];      // Em Em C B
  const BASE_ARP = [0, 1, 2, 3, 4, 5, 4, 3];
  const FREE_ARP = [0, 2, 1, 3, 2, 4, 3, 5, 4, 3, 2, 1, 0, 2, 1, 3];
  P._playStep = function (s, t, stepDur) {
    const step = s.step % 16, bar = s.bar, m = this.music;
    if (s.mode === 'base') {
      const ch = BASE_PROG[bar % 4];
      const arp = [ch[0], ch[1], ch[2], ch[0] + 12, ch[1] + 12, ch[2] + 12];
      if (step % 2 === 0) this.pluck(midi(arp[BASE_ARP[step / 2]]), t, { gain: 0.15, dur: 1.5, dest: m, send: 0.5 });
      if (step === 0) this.pad([midi(ch[0] - 12), midi(ch[2] - 12), midi(ch[0])], t, 16 * stepDur + 0.2, 0.07, { cut: 700, a: 1.2, r: 1.5, dest: m });
      if (step === 9 && Math.random() < 0.3) this.pluck(midi(ch[2] + 24), t, { gain: 0.07, dur: 1.5, dest: m, send: 0.6 });
      if (step === 0 && Math.random() < 0.12) this.thunder(t + Math.random() * 2, { intensity: 0.35, dur: 2.5, dest: m });
    } else {
      const ch = FREE_PROG[bar % 4];
      const arp = [ch[0], ch[1], ch[2], ch[0] + 12, ch[1] + 12, ch[2] + 12];
      this.pluck(midi(arp[FREE_ARP[step]]), t, { gain: 0.12, dur: 1.0, dest: m, send: 0.4 });
      if (step === 0 || step === 6 || step === 8 || step === 12) {
        this.thump(t, { freq: step === 0 ? 62 : 58, gain: 0.45, dur: 0.14, dest: m });
        this.noise({ t: t, type: 'lowpass', freq: 220, gain: 0.25, dur: 0.05, d: 0.06, s: 0.2, r: 0.05, dest: m });
      }
      if (step === 0) this.pad([midi(ch[0] - 12), midi(ch[1]), midi(ch[2]), midi(ch[0] + 12)], t, 16 * stepDur + 0.1, 0.09, { cut: 1100, a: 0.3, r: 0.6, dest: m });
      if (step === 0 && bar % 2 === 1) ch.forEach(n => this.brass(midi(n + 12), t, 0.3, 0.05, m));
      if (step === 8 && bar % 4 === 3) ch.forEach(n => this.brass(midi(n + 12), t, 0.25, 0.05, m));
      if (step === 4 && Math.random() < 0.15) this.thunder(t, { intensity: 0.4, dur: 2, dest: m });
    }
  };

  ZEUS.AudioEngine = AudioEngine;
  ZEUS.audio = new AudioEngine();
})(typeof window !== 'undefined' ? window : globalThis);
