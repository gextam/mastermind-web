/* ============================================================================
   MASTERMIND — rules engine, shared by the browser game and the Node server.
   Codes, black/white key-peg feedback, the code space, Knuth's minimax solver
   with a memoised decision tree, parsing of guesses in any notation, scoring.
   UMD: window.MM.Engine in the browser, module.exports in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MM = root.MM || {}; root.MM.Engine = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------------------------------------- palette */
  const PALETTE = [
    { id: 1, name: 'red', letter: 'R', hex: '#e3261f', aliases: ['crimson'] },
    { id: 2, name: 'orange', letter: 'O', hex: '#ff7f11', aliases: [] },
    { id: 3, name: 'yellow', letter: 'Y', hex: '#ffd42a', aliases: ['gold'] },
    { id: 4, name: 'green', letter: 'G', hex: '#21a83f', aliases: [] },
    { id: 5, name: 'blue', letter: 'B', hex: '#1f5fe0', aliases: ['navy'] },
    { id: 6, name: 'purple', letter: 'P', hex: '#7e35c4', aliases: ['violet'] },
    { id: 7, name: 'white', letter: 'W', hex: '#f4f4f4', aliases: ['ivory'] },
    { id: 8, name: 'black', letter: 'K', hex: '#1b1b1f', aliases: ['brown'] },
    { id: 9, name: 'cyan', letter: 'C', hex: '#19c6d9', aliases: ['turquoise', 'teal'] },
    { id: 10, name: 'pink', letter: 'N', hex: '#ff5fa8', aliases: ['magenta'] }
  ];
  const BLANK = { id: 0, name: 'empty', letter: '.', hex: null, aliases: ['blank', 'none', 'e', '_', '-'] };
  const LIMITS = { pegs: [2, 8], colors: [2, 10], maxGuesses: [1, 30], player: 24 };
  const MAX_ENUM = 2000000;             /* largest code space the solver enumerates */
  const PRESETS = {
    classic: { label: 'Classic', pegs: 4, colors: 6, maxGuesses: 10, allowDuplicates: true, allowBlanks: false, blurb: '4 pegs · 6 colours · 10 guesses' },
    mini: { label: 'Mini', pegs: 3, colors: 6, maxGuesses: 8, allowDuplicates: true, allowBlanks: false, blurb: '3 pegs · 6 colours · 8 guesses' },
    unique: { label: 'No repeats', pegs: 4, colors: 6, maxGuesses: 10, allowDuplicates: false, allowBlanks: false, blurb: '4 pegs · 6 colours · no repeated colours' },
    blanks: { label: 'With blanks', pegs: 4, colors: 6, maxGuesses: 12, allowDuplicates: true, allowBlanks: true, blurb: '4 pegs · 6 colours + empty · 12 guesses' },
    super: { label: 'Super', pegs: 5, colors: 8, maxGuesses: 12, allowDuplicates: true, allowBlanks: false, blurb: '5 pegs · 8 colours · 12 guesses' },
    grand: { label: 'Grand', pegs: 6, colors: 8, maxGuesses: 15, allowDuplicates: true, allowBlanks: false, blurb: '6 pegs · 8 colours · 15 guesses' }
  };

  function EngineError(code, message) { this.name = 'EngineError'; this.code = code; this.message = message; this.status = 400; }
  EngineError.prototype = Object.create(Error.prototype);
  EngineError.prototype.constructor = EngineError;

  /* ------------------------------------------------------------ config */
  function toInt(v, name, range) {
    const n = typeof v === 'string' ? parseInt(v, 10) : v;
    if (!Number.isInteger(n)) throw new EngineError('invalid_config', name + ' must be an integer');
    if (n < range[0] || n > range[1]) throw new EngineError('invalid_config', name + ' must be between ' + range[0] + ' and ' + range[1]);
    return n;
  }
  function toBool(v) { if (typeof v === 'string') return !(v === '' || v === '0' || v === 'false' || v === 'no'); return !!v; }
  function pick(input, snake, camel, def) {
    const v = input[snake] != null ? input[snake] : input[camel];
    return v == null ? def : v;
  }
  function presetFor(cfg) {
    const names = Object.keys(PRESETS);
    for (let i = 0; i < names.length; i++) {
      const p = PRESETS[names[i]];
      if (p.pegs === cfg.pegs && p.colors === cfg.colors && p.maxGuesses === cfg.maxGuesses && p.allowDuplicates === cfg.allowDuplicates && p.allowBlanks === cfg.allowBlanks) return names[i];
    }
    return 'custom';
  }
  function normalizeConfig(input) {
    input = input || {};
    const presetName = input.preset != null && input.preset !== '' ? String(input.preset).toLowerCase() : null;
    if (presetName && !PRESETS[presetName]) throw new EngineError('unknown_preset', 'Unknown preset "' + presetName + '". Presets: ' + Object.keys(PRESETS).join(', '));
    const base = presetName ? PRESETS[presetName] : PRESETS.classic;
    const cfg = {
      pegs: toInt(pick(input, 'pegs', 'pegs', base.pegs), 'pegs', LIMITS.pegs),
      colors: toInt(pick(input, 'colors', 'colours', base.colors), 'colors', LIMITS.colors),
      maxGuesses: toInt(pick(input, 'max_guesses', 'maxGuesses', base.maxGuesses), 'max_guesses', LIMITS.maxGuesses),
      allowDuplicates: toBool(pick(input, 'allow_duplicates', 'allowDuplicates', base.allowDuplicates)),
      allowBlanks: toBool(pick(input, 'allow_blanks', 'allowBlanks', base.allowBlanks))
    };
    if (!cfg.allowDuplicates && symbolCount(cfg) < cfg.pegs) throw new EngineError('invalid_config', 'Without repeated colours you need at least as many colours as pegs (' + cfg.pegs + ')');
    cfg.preset = presetFor(cfg);
    return cfg;
  }
  function symbolCount(cfg) { return cfg.colors + (cfg.allowBlanks ? 1 : 0); }
  function symbolList(cfg) { const s = []; if (cfg.allowBlanks) s.push(0); for (let i = 1; i <= cfg.colors; i++) s.push(i); return s; }
  function spaceSize(cfg) {
    const n = symbolCount(cfg), p = cfg.pegs;
    if (cfg.allowDuplicates) return Math.pow(n, p);
    let r = 1; for (let i = 0; i < p; i++) r *= (n - i); return r;
  }
  function difficulty(cfg) { return Math.log(spaceSize(cfg)) / Math.log(1296); }
  function paletteFor(cfg) {
    const out = [];
    if (cfg.allowBlanks) out.push({ id: 0, name: BLANK.name, letter: BLANK.letter, hex: null });
    for (let i = 0; i < cfg.colors; i++) { const c = PALETTE[i]; out.push({ id: c.id, name: c.name, letter: c.letter, hex: c.hex }); }
    return out;
  }
  function symbol(id) { return id === 0 ? BLANK : PALETTE[id - 1]; }
  function codeNames(ids) { return ids.map(id => symbol(id).name); }
  function codeLetters(ids) { return ids.map(id => symbol(id).letter).join(''); }
  function describeConfig(cfg) {
    return cfg.pegs + ' pegs, ' + cfg.colors + ' colours' + (cfg.allowBlanks ? ' plus empty' : '') + ', ' + cfg.maxGuesses + ' guesses, ' + (cfg.allowDuplicates ? 'repeats allowed' : 'no repeats') + ' (' + spaceSize(cfg).toLocaleString('en-US') + ' possible codes)';
  }

  /* ----------------------------------------------------------- parsing */
  function symbolId(item, cfg) {
    if (typeof item === 'number') {
      if (Number.isInteger(item) && item >= 1 && item <= cfg.colors) return item;
      if (item === 0 && cfg.allowBlanks) return 0;
      throw new EngineError('invalid_colour', item + ' is not a colour number of this game (1-' + cfg.colors + (cfg.allowBlanks ? ', or 0 for empty' : '') + ')');
    }
    const s = String(item).trim().toLowerCase();
    if (/^\d+$/.test(s)) return symbolId(parseInt(s, 10), cfg);
    if (cfg.allowBlanks && (s === BLANK.name || s === BLANK.letter || BLANK.aliases.indexOf(s) >= 0)) return 0;
    for (let i = 0; i < cfg.colors; i++) {
      const c = PALETTE[i];
      if (s === c.name || s === c.letter.toLowerCase() || c.aliases.indexOf(s) >= 0) return c.id;
    }
    throw new EngineError('invalid_colour', '"' + item + '" is not one of this game\'s colours: ' + paletteFor(cfg).map(p => p.name + ' (' + p.letter + ')').join(', '));
  }
  function parseCode(input, cfg) {
    let items;
    if (Array.isArray(input)) items = input;
    else if (typeof input === 'string') {
      const s = input.trim();
      if (!s) throw new EngineError('invalid_guess', 'The guess is empty');
      if (/[\s,;|/]/.test(s)) items = s.split(/[\s,;|/]+/).filter(Boolean);
      else if (s.length === cfg.pegs) items = s.split('');
      else if (/^\d+$/.test(s)) items = s.split('');
      else if (s.indexOf('-') > 0) items = s.split('-');
      else items = s.split('');
    } else throw new EngineError('invalid_guess', 'guess must be an array of colours (names, letters or numbers) or a string like "RGBY"');
    if (items.length !== cfg.pegs) throw new EngineError('invalid_guess', 'A code has exactly ' + cfg.pegs + ' pegs (got ' + items.length + ')');
    const ids = items.map(it => symbolId(it, cfg));
    if (!cfg.allowDuplicates) { const seen = {}; for (let i = 0; i < ids.length; i++) { if (seen[ids[i]]) throw new EngineError('invalid_guess', 'This game does not allow a colour twice in one code'); seen[ids[i]] = true; } }
    return ids;
  }

  /* --------------------------------------------------------- feedback */
  function feedback(secret, guess) {
    const p = secret.length, cs = new Int32Array(16), cg = new Int32Array(16);
    let black = 0;
    for (let i = 0; i < p; i++) { const a = secret[i], b = guess[i]; if (a === b) black++; else { cs[a]++; cg[b]++; } }
    let white = 0;
    for (let s = 0; s < 16; s++) white += cs[s] < cg[s] ? cs[s] : cg[s];
    return { black: black, white: white };
  }
  function packedFeedback(data, off, p, guess, cs, cg) {
    let black = 0;
    for (let i = 0; i < 11; i++) { cs[i] = 0; cg[i] = 0; }
    for (let i = 0; i < p; i++) { const a = data[off + i], b = guess[i]; if (a === b) black++; else { cs[a]++; cg[b]++; } }
    let white = 0;
    for (let s = 0; s < 11; s++) { const x = cs[s], y = cg[s]; white += x < y ? x : y; }
    return black * (p + 1) + white;
  }

  /* ------------------------------------------------------------ random */
  function defaultRng() {
    const c = (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) ? crypto : null;
    if (c) { const u = new Uint32Array(1); return function () { c.getRandomValues(u); return u[0] / 4294967296; }; }
    return Math.random;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function randomCode(cfg, rng) {
    rng = rng || defaultRng();
    const syms = symbolList(cfg), p = cfg.pegs, out = [];
    if (cfg.allowDuplicates) { for (let i = 0; i < p; i++) out.push(syms[Math.floor(rng() * syms.length)]); return out; }
    const pool = syms.slice();
    for (let i = 0; i < p; i++) { const j = i + Math.floor(rng() * (pool.length - i)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; out.push(pool[i]); }
    return out;
  }

  /* -------------------------------------------------------- code space */
  const ENUM_CACHE = new Map();
  function configKey(cfg) { return cfg.pegs + ':' + cfg.colors + ':' + (cfg.allowDuplicates ? 1 : 0) + ':' + (cfg.allowBlanks ? 1 : 0); }
  function enumerate(cfg) {
    const k = configKey(cfg);
    if (ENUM_CACHE.has(k)) return ENUM_CACHE.get(k);
    const n = spaceSize(cfg);
    if (n > MAX_ENUM) return null;
    const p = cfg.pegs, syms = symbolList(cfg), data = new Uint8Array(n * p), cur = new Array(p), used = new Uint8Array(16);
    let w = 0;
    (function rec(pos) {
      if (pos === p) { for (let i = 0; i < p; i++) data[w++] = cur[i]; return; }
      for (let s = 0; s < syms.length; s++) {
        const sym = syms[s];
        if (!cfg.allowDuplicates && used[sym]) continue;
        cur[pos] = sym; used[sym] = 1; rec(pos + 1); used[sym] = 0;
      }
    })(0);
    const e = { n: n, p: p, data: data };
    if (ENUM_CACHE.size > 12) ENUM_CACHE.clear();
    ENUM_CACHE.set(k, e);
    return e;
  }
  function codeAt(e, i) { const out = new Array(e.p), off = i * e.p; for (let k = 0; k < e.p; k++) out[k] = e.data[off + k]; return out; }

  /* ------------------------------------------------------------ solver
     Knuth (1977): keep the set S of codes consistent with every answer so far;
     pick the guess whose worst-case answer leaves the smallest S (minimax),
     preferring guesses that could themselves be the code. For spaces far
     larger than the classic 1296 the candidate and scoring sets are sampled
     with a deterministic generator so the solver stays fast. Decisions are
     memoised per feedback history, so repeated games share one decision tree. */
  const MEMO = new Map();
  function memoFor(cfg) { const k = configKey(cfg); if (!MEMO.has(k)) MEMO.set(k, new Map()); return MEMO.get(k); }
  function historyKey(history) { return history.map(h => h.guess.join(',') + '=' + h.black + '.' + h.white).join(';'); }
  function sampleIndices(list, k, rand) {
    if (!list || list.length <= k) return list;
    const out = new Array(k), n = list.length, taken = new Set();
    for (let i = 0; i < k; i++) { let j = Math.floor(rand() * n); while (taken.has(j)) j = (j + 1) % n; taken.add(j); out[i] = list[j]; }
    return out;
  }

  function Solver(cfg) {
    this.cfg = cfg; this.p = cfg.pegs;
    this.space = enumerate(cfg);
    if (!this.space) throw new EngineError('too_large', 'This code space (' + spaceSize(cfg).toLocaleString('en-US') + ' codes) is too large for the solver; the limit is ' + MAX_ENUM.toLocaleString('en-US'));
    this.memo = memoFor(cfg);
    this.cs = new Int32Array(16); this.cg = new Int32Array(16);
    this._all = null;
  }
  Solver.prototype.all = function () {
    if (!this._all) { const n = this.space.n, a = new Array(n); for (let i = 0; i < n; i++) a[i] = i; this._all = a; }
    return this._all;
  };
  Solver.prototype.consistent = function (history) {
    const e = this.space, p = this.p, n = e.n, cs = this.cs, cg = this.cg, out = [];
    const hs = history.map(h => ({ g: h.guess, f: h.black * (p + 1) + h.white })).reverse();
    for (let i = 0; i < n; i++) {
      const off = i * p; let ok = true;
      for (let k = 0; k < hs.length; k++) { if (packedFeedback(e.data, off, p, hs[k].g, cs, cg) !== hs[k].f) { ok = false; break; } }
      if (ok) out.push(i);
    }
    return out;
  };
  Solver.prototype.remaining = function (history, sampleSize) {
    const S = this.consistent(history), e = this.space, rand = mulberry32(hashString(historyKey(history)) ^ 0x9e3779b9);
    const pick = sampleIndices(S, sampleSize == null ? 5 : sampleSize, rand) || [];
    return { count: S.length, sample: pick.map(i => codeAt(e, i)) };
  };
  Solver.prototype.next = function (history) {
    const key = historyKey(history);
    if (this.memo.has(key)) return this.memo.get(key).slice();
    const e = this.space, p = this.p, S = this.consistent(history);
    if (!S.length) throw new EngineError('inconsistent', 'No code is consistent with the feedback given so far');
    let choice;
    if (S.length <= 2) choice = codeAt(e, S[0]);
    else {
      const rand = mulberry32(hashString(key));
      let cands, T;
      if (e.n <= 2600) { cands = this.all(); T = S; }
      else {
        cands = sampleIndices(S, 800, rand).slice();
        if (e.n <= 60000) { const extra = sampleIndices(this.all(), 400, rand); for (let i = 0; i < extra.length; i++) cands.push(extra[i]); }
        T = sampleIndices(S, 2500, rand);
      }
      const inS = new Uint8Array(e.n); for (let i = 0; i < S.length; i++) inS[S[i]] = 1;
      const buckets = new Int32Array((p + 1) * (p + 1)), cs = this.cs, cg = this.cg, g = new Array(p);
      let best = -1, bestWorst = Infinity, bestInS = 0, bestParts = -1;
      for (let ci = 0; ci < cands.length; ci++) {
        const c = cands[ci], off = c * p;
        for (let k = 0; k < p; k++) g[k] = e.data[off + k];
        buckets.fill(0);
        let worst = 0, cut = false;
        for (let ti = 0; ti < T.length; ti++) {
          const f = packedFeedback(e.data, T[ti] * p, p, g, cs, cg), v = ++buckets[f];
          if (v > worst) { worst = v; if (worst > bestWorst) { cut = true; break; } }
        }
        if (cut) continue;
        let parts = 0; for (let b = 0; b < buckets.length; b++) if (buckets[b]) parts++;
        const better = worst < bestWorst || (worst === bestWorst && (inS[c] > bestInS || (inS[c] === bestInS && parts > bestParts)));
        if (better) { best = c; bestWorst = worst; bestInS = inS[c]; bestParts = parts; }
      }
      choice = codeAt(e, best);
    }
    if (this.memo.size > 50000) this.memo.clear();
    this.memo.set(key, choice.slice());
    return choice;
  };

  const SOLVERS = new Map();
  function solverFor(cfg) { const k = configKey(cfg); if (!SOLVERS.has(k)) { if (SOLVERS.size > 8) SOLVERS.clear(); SOLVERS.set(k, new Solver(cfg)); } return SOLVERS.get(k); }
  function solve(cfg, secret, maxGuesses) {
    const solver = solverFor(cfg), history = [], limit = maxGuesses || cfg.maxGuesses;
    let solved = false;
    while (history.length < limit) {
      const guess = solver.next(history), fb = feedback(secret, guess);
      history.push({ guess: guess, black: fb.black, white: fb.white });
      if (fb.black === cfg.pegs) { solved = true; break; }
    }
    return { guesses: history, solved: solved };
  }
  function hint(cfg, history) {
    const solver = solverFor(cfg), rem = solver.remaining(history, 5);
    if (!rem.count) throw new EngineError('inconsistent', 'No code is consistent with the feedback so far');
    return { remaining: rem.count, suggestion: solver.next(history), sample: rem.sample };
  }

  /* ----------------------------------------------------------- scoring
     Codebreaker: 1000 points for a first-guess solve on the classic board,
     falling linearly with every guess used; each hint costs one guess; harder
     boards are scaled by log(space)/log(1296). Losing or resigning scores 0.
     Codemaker: one point per guess the solver needed (+1 if it never got it). */
  function score(cfg, r) {
    if (!r.won) return 0;
    const used = r.guessesUsed + (r.hints || 0);
    const frac = Math.max(0, cfg.maxGuesses + 1 - used) / cfg.maxGuesses;
    return Math.round(1000 * frac * difficulty(cfg));
  }

  return {
    VERSION: '1.0.0', PALETTE: PALETTE, BLANK: BLANK, LIMITS: LIMITS, PRESETS: PRESETS, MAX_ENUM: MAX_ENUM,
    EngineError: EngineError, normalizeConfig: normalizeConfig, presetFor: presetFor, symbolCount: symbolCount, symbolList: symbolList,
    spaceSize: spaceSize, difficulty: difficulty, paletteFor: paletteFor, symbol: symbol, codeNames: codeNames, codeLetters: codeLetters,
    describeConfig: describeConfig, parseCode: parseCode, feedback: feedback, randomCode: randomCode, defaultRng: defaultRng, mulberry32: mulberry32,
    enumerate: enumerate, Solver: Solver, solverFor: solverFor, solve: solve, hint: hint, score: score, configKey: configKey
  };
});
