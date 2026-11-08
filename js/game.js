/* ============================================================================
   MASTERMIND — client game state machine. Talks to the API client (server or
   in-browser fallback), owns the row being composed, the animation timeline
   (peg drops, key-peg pops, marker slides, the shield opening) and both
   roles: codebreaker (you guess) and codemaker (you set the code, the
   server's solver breaks it row by row).
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, Engine = MM.Engine, T = MM.CONFIG.TIMING, S = MM.sfx;

  function Game(client) {
    this.client = client;
    this.state = 'idle';            /* idle · entry · playing · busy · anim · solving · over */
    this.mode = 'breaker';
    this.view = null; this.cfg = null; this.rows = []; this.secret = null;
    this.current = []; this.order = []; this.selected = 1;
    this.now = 0;
    this.anim = { drops: new Map(), keys: [], marker: null, shield: null, shake: 0, entry: null, solver: null, win: 0 };
    this.fx = []; this.events = [];
    this.hover = null; this.drag = null;
    this.listeners = {};
    this.player = MM.CONFIG.DEFAULT_PLAYER;
    this.lastHint = null;
  }
  const P = Game.prototype;
  /* the API's message is written for agents; the table talks to people */
  P.human = function (v) {
    if (!v) return '';
    if (v.status !== 'playing') return v.message;
    const n = v.guesses_used, last = n ? v.history[n - 1] : null;
    const tip = n === 0 ? 'Pick colours from the tray, fill the row and press CHECK.' : n === 1 ? 'Black = right colour in the right place, white = right colour in the wrong place.' : v.guesses_left <= 2 ? 'Only ' + v.guesses_left + ' left. Make them count.' : '';
    return 'Guess ' + (n + 1) + ' of ' + v.config.max_guesses + (last ? ' — last answer: ' + last.black + ' black, ' + last.white + ' white.' : '.') + (tip ? ' ' + tip : '');
  };
  P.on = function (ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; };
  P.emit = function (ev, a, b) { (this.listeners[ev] || []).forEach(fn => fn(a, b)); };
  P.schedule = function (at, fn) { this.events.push({ at: at, fn: fn }); };

  /* ---------------------------------------------------------- loading */
  P.load = function (view) {
    this.view = view;
    this.cfg = Engine.normalizeConfig(view.config);
    this.rows = view.history.map(h => ({ ids: Engine.parseCode(h.letters, this.cfg), black: h.black, white: h.white, turn: h.turn }));
    this.secret = view.secret ? Engine.parseCode(view.secret.letters, this.cfg) : null;
    this.mode = view.mode;
    if (this.selected > this.cfg.colors || (this.selected === 0 && !this.cfg.allowBlanks)) this.selected = 1;
  };
  P.resetAnim = function () {
    this.anim = { drops: new Map(), keys: [], marker: null, shield: null, shake: 0, entry: null, solver: null, win: 0 };
    this.fx = []; this.events = []; this.lastHint = null;
  };
  P.start = function (opts) {
    opts = opts || {};
    const args = Object.assign({}, opts.config || {}, { player: this.player });
    if (opts.preset) args.preset = opts.preset;
    this.resetAnim();
    this.mode = opts.mode === 'maker' ? 'maker' : 'breaker';
    if (this.mode === 'maker') {
      /* the player composes the secret first; the server is only asked once the code is locked */
      this.pendingArgs = args; this.view = null; this.rows = []; this.secret = null;
      this.cfg = Engine.normalizeConfig(args);
      this.current = new Array(this.cfg.pegs).fill(null); this.order = [];
      this.state = 'entry'; this.anim.shield = { t0: this.now, open: true, instant: true };
      S.newGame(); this.emit('change'); this.emit('message', 'Set your secret code in the shielded row, then press LOCK CODE.');
      return Promise.resolve(null);
    }
    this.state = 'busy'; this.emit('change');
    return this.client.newGame(args).then(v => {
      this.load(v); this.current = new Array(this.cfg.pegs).fill(null); this.order = [];
      this.state = 'playing'; this.client.rememberGame(v.game_id);
      this.anim.marker = { from: 0, to: 0, t0: this.now };
      S.newGame(); this.emit('change'); this.emit('message', this.human(v));
      return v;
    }).catch(e => { this.state = 'idle'; this.emit('change'); this.emit('error', e); throw e; });
  };
  P.resume = function (id) {
    return this.client.getGame(id).then(v => {
      if (v.status !== 'playing' || v.mode !== 'breaker') { this.client.rememberGame(null); return null; }
      this.resetAnim(); this.load(v); this.player = v.player || this.player;
      this.current = new Array(this.cfg.pegs).fill(null); this.order = [];
      this.state = 'playing'; this.anim.marker = { from: this.rows.length, to: this.rows.length, t0: this.now };
      this.emit('change'); this.emit('message', 'Resumed your game. ' + this.human(v));
      return v;
    }).catch(() => { this.client.rememberGame(null); return null; });
  };

  /* ------------------------------------------------------ composing */
  P.canEdit = function () { return this.state === 'playing' || this.state === 'entry'; };
  P.rowIndex = function () { return this.rows.length; };
  P.place = function (col, colorId) {
    if (!this.canEdit() || col < 0 || col >= this.cfg.pegs) return false;
    if (colorId === 0 && !this.cfg.allowBlanks) return false;
    if (colorId > this.cfg.colors) return false;
    if (!this.cfg.allowDuplicates) { const other = this.current.indexOf(colorId); if (other >= 0 && other !== col) { S.deny(); this.emit('message', 'No repeated colours on this board.'); return false; } }
    if (this.current[col] === colorId) return true;
    this.current[col] = colorId;
    this.order = this.order.filter(c => c !== col); this.order.push(col);
    this.anim.drops.set(col, this.now);
    S.place(col); this.emit('change');
    return true;
  };
  P.fillNext = function (colorId) {
    if (!this.canEdit()) return false;
    let col = this.current.indexOf(null);
    if (col < 0) col = this.hover && this.hover.type === 'hole' ? this.hover.col : this.cfg.pegs - 1;
    return this.place(col, colorId);
  };
  P.remove = function (col) {
    if (!this.canEdit() || this.current[col] == null) return false;
    this.current[col] = null; this.order = this.order.filter(c => c !== col); this.anim.drops.delete(col);
    S.remove(); this.emit('change'); return true;
  };
  P.undo = function () { if (!this.order.length) { S.deny(); return false; } return this.remove(this.order[this.order.length - 1]); };
  P.clearRow = function () { if (!this.canEdit()) return; this.current.fill(null); this.order = []; this.anim.drops.clear(); S.remove(); this.emit('change'); };
  P.select = function (colorId) { if (colorId === 0 && !(this.cfg && this.cfg.allowBlanks)) return; if (this.cfg && colorId > this.cfg.colors) return; this.selected = colorId; S.pick(); this.emit('change'); };
  P.complete = function () { return this.current.length > 0 && this.current.every(c => c != null); };

  /* ---------------------------------------------------- codebreaker */
  P.submit = function () {
    if (this.state === 'entry') return this.lockCode();
    if (this.state !== 'playing') return Promise.resolve(null);
    if (!this.complete()) { S.deny(); this.emit('message', 'Fill all ' + this.cfg.pegs + ' holes first.'); return Promise.resolve(null); }
    const ids = this.current.slice();
    this.state = 'busy'; S.submit(); this.emit('change');
    return this.client.guess(this.view.game_id, ids).then(v => {
      const before = this.rows.length;
      this.load(v);
      const row = this.rows[before];
      this.current = new Array(this.cfg.pegs).fill(null); this.order = []; this.anim.drops.clear();
      this.animateFeedback(before, row, this.now);
      const done = this.now + T.keyStart + Math.max(1, row.black + row.white) * T.keyGap + 0.25;
      this.state = 'anim';
      if (v.status === 'playing') {
        this.schedule(done, () => { this.anim.marker = { from: before, to: before + 1, t0: this.now }; S.slide(); this.state = 'playing'; this.emit('change'); this.emit('message', this.human(v)); });
      } else {
        this.schedule(done + T.revealDelay, () => this.reveal(v));
      }
      this.emit('change');
      return v;
    }).catch(e => { this.state = 'playing'; this.emit('change'); this.emit('error', e); return null; });
  };
  P.animateFeedback = function (rowIdx, row, t0) {
    const keys = [];
    for (let i = 0; i < row.black; i++) keys.push('black');
    for (let i = 0; i < row.white; i++) keys.push('white');
    keys.forEach((kind, i) => {
      const at = t0 + T.keyStart + i * T.keyGap;
      this.anim.keys.push({ row: rowIdx, idx: i, kind: kind, t0: at });
      this.schedule(at, () => S.keyPeg(kind, i));
    });
    this.anim.keys = this.anim.keys.filter(k => k.row === rowIdx || this.now - k.t0 < 2);
  };
  P.reveal = function (v) {
    this.state = 'over';
    this.client.rememberGame(null);
    this.anim.shield = { t0: this.now, open: true };
    S.shield();
    const won = v.status === 'won' || v.status === 'unsolved';
    this.schedule(this.now + T.shield * 0.75, () => {
      if (won) { S.win(v.score >= 700 || v.mode === 'maker'); this.anim.win = this.now; this.burst(); } else { S.lose(); this.anim.shake = 1; }
      this.emit('finished', v);
    });
    this.emit('change'); this.emit('message', v.message);
  };
  P.hint = function () {
    if (this.state !== 'playing') return Promise.resolve(null);
    this.state = 'busy'; this.emit('change');
    return this.client.hint(this.view.game_id).then(h => {
      this.state = 'playing'; this.lastHint = h; if (this.view) this.view.hints_used = h.hints_used;
      const ids = Engine.parseCode(h.suggestion.letters, this.cfg);
      this.current = ids.slice(); this.order = ids.map((_, i) => i); ids.forEach((_, i) => this.anim.drops.set(i, this.now + i * 0.06));
      S.hint();
      this.emit('change');
      this.emit('message', h.remaining_codes + ' code' + (h.remaining_codes === 1 ? ' is' : 's are') + ' still possible. The solver suggests ' + h.suggestion.letters + ' (placed for you; each hint costs one guess in the score).');
      return h;
    }).catch(e => { this.state = 'playing'; this.emit('change'); this.emit('error', e); return null; });
  };
  P.resign = function () {
    if (this.state !== 'playing' && this.state !== 'anim') return Promise.resolve(null);
    this.state = 'busy'; this.emit('change');
    return this.client.resign(this.view.game_id).then(v => { this.load(v); this.current.fill(null); this.events = []; this.reveal(v); return v; })
      .catch(e => { this.state = 'playing'; this.emit('change'); this.emit('error', e); return null; });
  };
  P.abandonEntry = function () { if (this.state === 'entry') { this.state = 'idle'; this.rows = []; this.view = null; this.emit('change'); } };

  /* ------------------------------------------------------ codemaker */
  P.lockCode = function () {
    if (this.state !== 'entry') return Promise.resolve(null);
    if (!this.complete()) { S.deny(); this.emit('message', 'Set all ' + this.cfg.pegs + ' pegs of your secret first.'); return Promise.resolve(null); }
    const secret = this.current.slice();
    const args = Object.assign({}, this.pendingArgs, { mode: 'maker', secret: secret });
    this.state = 'busy'; S.submit();
    this.anim.shield = { t0: this.now, open: false };
    this.emit('change'); this.emit('message', 'Code locked. The solver is thinking…');
    return this.client.newGame(args).then(v => {
      this.load(v);
      const transcript = this.rows; this.rows = []; this.current = new Array(this.cfg.pegs).fill(null);
      this.state = 'solving';
      const t0 = this.now + T.shield + 0.3;
      this.anim.marker = { from: 0, to: 0, t0: this.now };
      transcript.forEach((row, i) => {
        const at = t0 + i * T.solverStep;
        for (let k = 0; k < 4; k++) this.schedule(at - 0.5 + k * 0.11, () => S.think(k));
        this.schedule(at, () => {
          this.rows.push(row);
          row.ids.forEach((_, c) => this.anim.drops.set('r' + i + 'c' + c, at + c * 0.07));
          row.ids.forEach((_, c) => this.schedule(at + c * 0.07, () => S.place(c)));
          this.animateFeedback(i, row, at + 0.25);
          this.emit('change'); this.emit('message', 'Solver guess ' + (i + 1) + ': ' + Engine.codeLetters(row.ids) + ' → ' + row.black + ' black, ' + row.white + ' white');
          if (i + 1 < transcript.length) this.anim.marker = { from: i, to: i + 1, t0: at + 0.9 };
        });
      });
      const end = t0 + (transcript.length - 1) * T.solverStep + T.keyStart + 0.25 + Math.max(1, this.cfg.pegs) * T.keyGap + T.revealDelay;
      this.schedule(end, () => this.reveal(v));
      this.emit('change');
      return v;
    }).catch(e => { this.state = 'entry'; this.anim.shield = { t0: this.now, open: true, instant: true }; this.emit('change'); this.emit('error', e); return null; });
  };

  /* ------------------------------------------------------ animation */
  P.burst = function () {
    const n = 90;
    for (let i = 0; i < n; i++) {
      const colour = Engine.PALETTE[Math.floor(Math.random() * Math.min(8, this.cfg.colors))].hex;
      this.fx.push({ type: 'confetti', x: 960 + (Math.random() - 0.5) * 300, y: 120, vx: (Math.random() - 0.5) * 900, vy: -300 - Math.random() * 500, rot: Math.random() * 6.3, rv: (Math.random() - 0.5) * 14, w: 7 + Math.random() * 6, h: 10 + Math.random() * 8, color: colour, life: 2.6 + Math.random() * 1.2, t: 0 });
    }
    for (let i = 0; i < 40; i++) this.fx.push({ type: 'spark', x: 960 + (Math.random() - 0.5) * 360, y: 130 + (Math.random() - 0.5) * 60, vx: (Math.random() - 0.5) * 500, vy: -100 - Math.random() * 300, size: 4 + Math.random() * 6, life: 0.8 + Math.random() * 0.8, t: 0, rot: Math.random() * 6.3 });
  };
  P.update = function (now, dt) {
    this.now = now;
    if (this.events.length) {
      const due = this.events.filter(e => e.at <= now).sort((a, b) => a.at - b.at);
      this.events = this.events.filter(e => e.at > now);
      due.forEach(e => e.fn());
    }
    if (this.anim.shake > 0) this.anim.shake = Math.max(0, this.anim.shake - dt * 1.4);
    if (this.fx.length) {
      const out = [];
      for (let i = 0; i < this.fx.length; i++) {
        const p = this.fx[i]; p.t += dt; if (p.t >= p.life || p.y > 1200) continue;
        p.vy += (p.type === 'confetti' ? 700 : 400) * dt; p.vx *= (1 - 0.6 * dt); p.x += p.vx * dt; p.y += p.vy * dt; if (p.rv) p.rot += p.rv * dt;
        out.push(p);
      }
      this.fx = out;
    }
  };
  MM.Game = Game;
})(window);
