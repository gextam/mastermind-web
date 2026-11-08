/* ============================================================================
   MASTERMIND — sound design on top of the shared synthesizer (ZEUS.AudioEngine):
   peg handling (plastic ticks, wooden knocks), key-peg clinks, the row marker,
   the shield creaking open, win fanfare, loss sting, the solver's thinking
   ticks, a quiet study-room ambience with a clock. Everything is synthesized.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, A = root.ZEUS.audio;
  MM.audio = A;
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const S = MM.sfx = {};
  let ambience = null;

  S.pick = function () {
    if (!A.ready) return; const t = A.now();
    A.noise({ t: t, type: 'highpass', freq: 3200, gain: 0.12, dur: 0.01, d: 0.012, s: 0.1, r: 0.015 });
    A.tone({ t: t, freq: 2400, freqEnd: 2900, sweep: 0.03, gain: 0.05, a: 0.001, d: 0.025, s: 0.1, r: 0.02, dur: 0.025 });
  };
  /* a peg dropping into a hole: wooden knock + plastic tick, pitch varies with the column */
  S.place = function (col) {
    if (!A.ready) return; const t = A.now(), k = 1 + (col || 0) * 0.04;
    A.thump(t, { freq: 190 * k, gain: 0.32, dur: 0.06 });
    A.noise({ t: t, type: 'lowpass', freq: 1200, gain: 0.3, dur: 0.02, d: 0.025, s: 0.2, r: 0.03 });
    A.tone({ t: t + 0.004, freq: 1900 * k, freqEnd: 1300 * k, sweep: 0.04, gain: 0.06, a: 0.001, d: 0.035, s: 0.1, r: 0.03, dur: 0.035 });
    A.noise({ t: t + 0.05, type: 'highpass', freq: 2500, gain: 0.05, dur: 0.008, d: 0.01, s: 0.1, r: 0.01 });
  };
  S.remove = function () {
    if (!A.ready) return; const t = A.now();
    A.tone({ t: t, freq: 900, freqEnd: 1500, sweep: 0.05, gain: 0.05, a: 0.001, d: 0.04, s: 0.1, r: 0.03, dur: 0.04 });
    A.noise({ t: t, type: 'highpass', freq: 2800, gain: 0.08, dur: 0.012, d: 0.015, s: 0.1, r: 0.02 });
  };
  S.slide = function () {
    if (!A.ready) return; const t = A.now();
    A.noise({ t: t, type: 'bandpass', freq: 500, freqEnd: 1400, sweep: 0.14, Q: 1.2, gain: 0.08, a: 0.01, d: 0.1, s: 0.3, r: 0.06, dur: 0.12 });
    A.thump(t + 0.14, { freq: 160, gain: 0.12, dur: 0.05 });
  };
  /* key pegs: black is lower and duller, white higher and brighter */
  S.keyPeg = function (kind, i) {
    if (!A.ready) return; const t = A.now(), k = 1 + (i || 0) * 0.03;
    if (kind === 'black') {
      A.tone({ t: t, freq: 560 * k, freqEnd: 420 * k, sweep: 0.05, gain: 0.1, a: 0.001, d: 0.05, s: 0.1, r: 0.04, dur: 0.05, filter: { type: 'lowpass', freq: 2200 } });
      A.noise({ t: t, type: 'lowpass', freq: 900, gain: 0.18, dur: 0.012, d: 0.02, s: 0.2, r: 0.02 });
    } else {
      A.tone({ t: t, freq: 1250 * k, freqEnd: 980 * k, sweep: 0.04, gain: 0.08, a: 0.001, d: 0.05, s: 0.1, r: 0.05, dur: 0.05 });
      A.noise({ t: t, type: 'highpass', freq: 2600, gain: 0.14, dur: 0.01, d: 0.015, s: 0.2, r: 0.02 });
    }
  };
  S.submit = function () {
    if (!A.ready) return; const t = A.now();
    A.click();
    A.thump(t + 0.02, { freq: 140, gain: 0.22, dur: 0.07 });
  };
  S.deny = function () { if (A.ready) A.deny(); };
  S.click = function () { if (A.ready) A.click(); };
  S.tick = function () { if (A.ready) A.tick(); };
  /* the codemaker's shield swinging open: hinge creak then a soft knock */
  S.shield = function () {
    if (!A.ready) return; const t = A.now();
    A.noise({ t: t, type: 'bandpass', freq: 260, freqEnd: 900, sweep: 0.5, Q: 6, gain: 0.12, a: 0.05, d: 0.35, s: 0.5, r: 0.15, dur: 0.5 });
    A.tone({ t: t, type: 'sawtooth', freq: 180, freqEnd: 320, sweep: 0.45, gain: 0.03, a: 0.05, d: 0.3, s: 0.4, r: 0.1, dur: 0.45, filter: { type: 'lowpass', freq: 700 } });
    A.thump(t + 0.62, { freq: 120, gain: 0.3, dur: 0.08 });
    A.noise({ t: t + 0.62, type: 'lowpass', freq: 800, gain: 0.2, dur: 0.03, d: 0.03, s: 0.2, r: 0.04 });
  };
  S.win = function (big) {
    if (!A.ready) return; const t = A.now();
    A.duck(3);
    const chords = big ? [[60, 64, 67], [65, 69, 72], [67, 71, 74], [72, 76, 79, 84]] : [[60, 64, 67], [67, 71, 74], [72, 76, 79]];
    const durs = big ? [0.22, 0.22, 0.22, 1.6] : [0.2, 0.2, 1.3];
    let tt = t + 0.05;
    chords.forEach((ch, i) => { ch.forEach(n => A.brass(midi(n), tt, durs[i], 0.07 + (big ? 0.02 : 0))); if (i === chords.length - 1) A.bell(midi(ch[0] + 12), tt, { gain: 0.1, dur: 1.8 }); tt += durs[i] + 0.03; });
    for (let k = 0; k < (big ? 14 : 8); k++) A.bell(2200 + Math.random() * 2400, t + 0.3 + k * 0.08 + Math.random() * 0.04, { gain: 0.03, dur: 0.5 });
    [72, 76, 79, 84].forEach((n, i) => A.pluck(midi(n), t + 0.1 + i * 0.07, { gain: 0.16, dur: 1.2, send: 0.4 }));
  };
  S.lose = function () {
    if (!A.ready) return; const t = A.now();
    A.pad([midi(45), midi(48), midi(52)], t, 1.6, 0.1, { cut: 800, a: 0.05, r: 1.0 });
    A.tone({ t: t + 0.1, type: 'sawtooth', freq: 220, freqEnd: 150, sweep: 1.2, gain: 0.05, a: 0.02, d: 0.6, s: 0.4, r: 0.5, dur: 1.0, filter: { type: 'lowpass', freq: 600 } });
    A.thump(t, { freq: 80, gain: 0.35, dur: 0.14 });
  };
  S.hint = function () {
    if (!A.ready) return; const t = A.now();
    [76, 79, 83].forEach((n, i) => A.bell(midi(n), t + i * 0.06, { gain: 0.07, dur: 0.8 }));
  };
  S.think = function (i) {
    if (!A.ready) return; const t = A.now();
    A.tone({ t: t, type: 'square', freq: 1400 + (i % 3) * 120, gain: 0.025, a: 0.001, d: 0.02, s: 0.1, r: 0.01, dur: 0.02, filter: { type: 'lowpass', freq: 3000 } });
  };
  S.newGame = function () {
    if (!A.ready) return; const t = A.now();
    A.noise({ t: t, type: 'bandpass', freq: 900, freqEnd: 300, sweep: 0.25, Q: 1, gain: 0.12, a: 0.01, d: 0.2, s: 0.3, r: 0.1, dur: 0.22 });
    for (let k = 0; k < 4; k++) A.thump(t + 0.05 + k * 0.045, { freq: 170 + k * 12, gain: 0.14, dur: 0.05 });
  };
  /* study-room ambience: a faint warm hum, a clock, an occasional creak of the lamp */
  S.ambienceStart = function () {
    if (!A.ready || ambience) return;
    const ctx = A.ctx, t = A.now();
    const src = ctx.createBufferSource(); src.buffer = A.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180; f.Q.value = 0.4;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(A.music); src.start(t);
    g.gain.setTargetAtTime(0.05, t, 2.0);
    let beat = 0;
    const timer = setInterval(() => {
      if (!A.ready || A.muted) return; const now = A.now(); beat++;
      A.tone({ t: now, freq: beat % 2 ? 2100 : 1800, gain: 0.012, a: 0.001, d: 0.02, s: 0.05, r: 0.02, dur: 0.02, dest: A.music });
      A.noise({ t: now, type: 'highpass', freq: 4000, gain: 0.015, dur: 0.004, d: 0.006, s: 0.1, r: 0.006, dest: A.music });
      if (Math.random() < 0.05) A.noise({ t: now + Math.random() * 0.6, type: 'bandpass', freq: rnd(300, 600), freqEnd: rnd(500, 900), sweep: 0.3, Q: 5, gain: 0.025, a: 0.05, d: 0.2, s: 0.3, r: 0.1, dur: 0.3, dest: A.music });
    }, 1000);
    ambience = { src: src, g: g, timer: timer };
  };
  S.ambienceStop = function () {
    if (!ambience) return; const t = A.now();
    clearInterval(ambience.timer); ambience.g.gain.setTargetAtTime(0, t, 0.5); ambience.src.stop(t + 2); ambience = null;
  };
})(window);
