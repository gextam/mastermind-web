/* ============================================================================
   MASTERMIND — DOM layer: stage scaling, splash, the new-game dialog, status
   and controls, the scoreboard panel (shared server scoreboard when online,
   local otherwise), toasts, the result banner, help, pointer handling on the
   canvas (click, drag and drop, right-click) and keyboard shortcuts.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, Engine = MM.Engine, S = MM.sfx, STAGE = MM.CONFIG.STAGE, ST = MM.CONFIG.STORAGE;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtMs = ms => ms == null ? '—' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  const ago = iso => { if (!iso) return ''; const d = (Date.now() - new Date(iso).getTime()) / 1000; return d < 60 ? 'just now' : d < 3600 ? Math.floor(d / 60) + ' min ago' : d < 86400 ? Math.floor(d / 3600) + ' h ago' : Math.floor(d / 86400) + ' d ago'; };

  function UI(game, renderer, client) {
    this.game = game; this.renderer = renderer; this.client = client;
    this.ready = false; this.tab = 'top'; this.scores = null; this.toastTimer = null;
    this.stage = $('stage'); this.canvas = $('game');
    this.setup = { mode: 'breaker', preset: 'classic' };
    this.scale();
    root.addEventListener('resize', () => this.scale());
    this.bind();
    game.on('change', () => this.refresh()).on('message', m => this.message(m)).on('error', e => this.toast((e && e.message) || 'Something went wrong', true)).on('finished', v => this.finished(v));
    this.refresh();
  }
  const P = UI.prototype;
  P.scale = function () {
    const s = Math.min(root.innerWidth / STAGE.w, root.innerHeight / STAGE.h);
    this.stage.style.transform = 'translate(-50%, -50%) scale(' + s + ')';
    this.stageScale = s;
  };
  P.stagePoint = function (ev) { const r = this.canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width * STAGE.w, y: (ev.clientY - r.top) / r.height * STAGE.h }; };

  /* ------------------------------------------------------------- bind */
  P.bind = function () {
    const g = this.game;
    $('splash').addEventListener('click', () => this.start());
    $('btn-check').addEventListener('click', () => { S.click(); if (g.state === 'over') this.openSetup(); else g.submit(); });
    $('btn-undo').addEventListener('click', () => { S.click(); g.undo(); });
    $('btn-clear').addEventListener('click', () => { S.click(); g.clearRow(); });
    $('btn-hint').addEventListener('click', () => { S.click(); g.hint(); });
    $('btn-new').addEventListener('click', () => { S.click(); this.openSetup(); });
    $('btn-resign').addEventListener('click', () => { S.click(); if (g.state === 'entry') { g.abandonEntry(); this.openSetup(); } else if (g.state === 'playing' && confirm('Resign this game? The code will be revealed and the game scores 0.')) g.resign(); });
    $('btn-help').addEventListener('click', () => { S.click(); this.toggleHelp(true); });
    $('help-close').addEventListener('click', () => { S.click(); this.toggleHelp(false); });
    $('btn-sound').addEventListener('click', () => { const m = MM.audio.toggleMute(); $('btn-sound').classList.toggle('muted', m); if (!m) S.click(); });
    $('vol').value = MM.audio.volume; $('vol').addEventListener('input', e => MM.audio.setVolume(parseFloat(e.target.value)));
    $('banner-again').addEventListener('click', () => { S.click(); this.hideBanner(); this.openSetup(); });
    $('banner-close').addEventListener('click', () => { S.click(); this.hideBanner(); });
    $('setup-start').addEventListener('click', () => this.startFromSetup());
    $('setup-cancel').addEventListener('click', () => { S.click(); this.closeSetup(); });
    Array.prototype.forEach.call(document.querySelectorAll('#setup .modes button'), b => b.addEventListener('click', () => { S.click(); this.setup.mode = b.dataset.mode; this.renderSetup(); }));
    Array.prototype.forEach.call(document.querySelectorAll('#right .tabs button'), b => b.addEventListener('click', () => { S.click(); this.tab = b.dataset.tab; this.renderScores(); }));
    $('player-name').addEventListener('input', e => { this.game.player = e.target.value.trim() || MM.CONFIG.DEFAULT_PLAYER; try { localStorage.setItem(ST.player, this.game.player); } catch (x) { /* ignore */ } });
    ['pegs', 'colors', 'guesses'].forEach(k => $('cfg-' + k).addEventListener('input', () => this.renderSetup()));
    ['dups', 'blanks'].forEach(k => $('cfg-' + k).addEventListener('change', () => this.renderSetup()));
    /* canvas pointer handling */
    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => this.pointerDown(e));
    c.addEventListener('pointermove', e => this.pointerMove(e));
    c.addEventListener('pointerup', e => this.pointerUp(e));
    c.addEventListener('pointerleave', () => { this.game.hover = null; });
    document.addEventListener('keydown', e => this.key(e));
    this.client.onStatus = () => this.refreshOnline();
  };
  P.start = function () {
    if (this.ready) return;
    MM.audio.init(); S.ambienceStart();
    $('splash').classList.add('hidden');
    this.ready = true;
    const resumable = this.client.resumableId();
    const done = resumable ? this.game.resume(resumable) : Promise.resolve(null);
    done.then(v => { if (!v) this.openSetup(); });
    this.loadScores();
  };

  /* ---------------------------------------------------------- pointer */
  P.pointerDown = function (e) {
    const g = this.game; if (!this.ready) return;
    const p = this.stagePoint(e), hit = this.renderer.hitTest(p.x, p.y);
    if (!hit) return;
    if (e.button === 2) { if (hit.type === 'hole') g.remove(hit.col); return; }
    if (hit.type === 'tray') { g.select(hit.color); this.pending = { color: hit.color, x: p.x, y: p.y, moved: false }; this.canvas.setPointerCapture(e.pointerId); return; }
    if (hit.type === 'hole' && g.canEdit()) {
      if (g.current[hit.col] != null) { const col = g.current[hit.col]; g.remove(hit.col); g.select(col); this.pending = { color: col, x: p.x, y: p.y, moved: true, fromHole: hit.col }; g.drag = { color: col, x: p.x, y: p.y }; this.canvas.setPointerCapture(e.pointerId); }
      else g.place(hit.col, g.selected);
    }
  };
  P.pointerMove = function (e) {
    const g = this.game, p = this.stagePoint(e);
    g.hover = this.renderer.hitTest(p.x, p.y);
    if (this.pending) {
      if (!this.pending.moved && Math.hypot(p.x - this.pending.x, p.y - this.pending.y) > 10) { this.pending.moved = true; g.drag = { color: this.pending.color, x: p.x, y: p.y }; }
      if (g.drag) { g.drag.x = p.x; g.drag.y = p.y; }
    }
  };
  P.pointerUp = function (e) {
    const g = this.game, p = this.stagePoint(e), pend = this.pending;
    this.pending = null;
    if (!pend) return;
    const hit = this.renderer.hitTest(p.x, p.y);
    if (g.drag) {
      g.drag = null;
      if (hit && hit.type === 'hole') g.place(hit.col, pend.color);
      else if (pend.fromHole != null && (!hit || hit.type !== 'tray')) g.place(pend.fromHole, pend.color);   /* dropped nowhere: put it back */
    } else if (!pend.moved && hit && hit.type === 'tray') g.fillNext(pend.color);
  };
  P.key = function (e) {
    if (!this.ready) return;
    const g = this.game, tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') { if (e.key === 'Enter' && e.target.id === 'player-name') this.startFromSetup(); return; }
    if (e.key === 'Escape') { if (!$('help').classList.contains('hidden')) this.toggleHelp(false); else if (!$('setup').classList.contains('hidden') && g.state !== 'idle') this.closeSetup(); else this.hideBanner(); return; }
    if (!$('setup').classList.contains('hidden')) { if (e.key === 'Enter') this.startFromSetup(); return; }
    if (/^[0-9]$/.test(e.key)) { const n = parseInt(e.key, 10); const id = n === 0 ? (g.cfg && g.cfg.colors >= 10 ? 10 : 0) : n; if (g.cfg && (id <= g.cfg.colors || (id === 0 && g.cfg.allowBlanks))) { g.select(id); g.fillNext(id); } e.preventDefault(); return; }
    switch (e.key) {
      case 'Enter': case ' ': if (g.state === 'over') this.openSetup(); else g.submit(); e.preventDefault(); break;
      case 'Backspace': g.undo(); e.preventDefault(); break;
      case 'Delete': g.clearRow(); break;
      case 'h': case 'H': g.hint(); break;
      case 'n': case 'N': this.openSetup(); break;
      case 'm': case 'M': $('btn-sound').click(); break;
      case '?': case 'F1': this.toggleHelp(true); e.preventDefault(); break;
      case 'ArrowLeft': case 'ArrowRight': { if (!g.cfg) break; const syms = Engine.symbolList(g.cfg); let i = syms.indexOf(g.selected); i = (i + (e.key === 'ArrowLeft' ? -1 : 1) + syms.length) % syms.length; g.select(syms[i]); break; }
      default: return;
    }
  };

  /* ------------------------------------------------------------ setup */
  P.openSetup = function () {
    const g = this.game;
    if (g.state === 'playing' && g.rows.length && !confirm('Abandon the game in progress? It will be recorded as resigned.')) return;
    if (g.state === 'playing') { g.resign().then(() => this.openSetup()); return; }
    if (g.state === 'entry') g.abandonEntry();
    this.hideBanner();
    $('player-name').value = g.player === MM.CONFIG.DEFAULT_PLAYER ? '' : g.player;
    this.renderSetup();
    $('setup').classList.remove('hidden');
    setTimeout(() => $('player-name').focus(), 50);
  };
  P.closeSetup = function () { $('setup').classList.add('hidden'); };
  P.setupConfig = function () {
    if (this.setup.preset !== 'custom') return { preset: this.setup.preset };
    return { pegs: parseInt($('cfg-pegs').value, 10), colors: parseInt($('cfg-colors').value, 10), max_guesses: parseInt($('cfg-guesses').value, 10), allow_duplicates: $('cfg-dups').checked, allow_blanks: $('cfg-blanks').checked };
  };
  P.renderSetup = function () {
    const presets = Engine.PRESETS, list = $('presets');
    Array.prototype.forEach.call(document.querySelectorAll('#setup .modes button'), b => b.classList.toggle('sel', b.dataset.mode === this.setup.mode));
    if (!list.children.length) {
      list.innerHTML = Object.keys(presets).map(k => '<button class="preset" data-preset="' + k + '"><b>' + esc(presets[k].label) + '</b><span>' + esc(presets[k].blurb) + '</span><small>' + Engine.spaceSize(presets[k]).toLocaleString('en-US') + ' codes</small></button>').join('') + '<button class="preset" data-preset="custom"><b>Custom</b><span>choose pegs, colours, guesses</span><small>your rules</small></button>';
      Array.prototype.forEach.call(list.querySelectorAll('button'), b => b.addEventListener('click', () => { S.click(); this.setup.preset = b.dataset.preset; this.renderSetup(); }));
    }
    Array.prototype.forEach.call(list.querySelectorAll('button'), b => b.classList.toggle('sel', b.dataset.preset === this.setup.preset));
    $('custom').classList.toggle('hidden', this.setup.preset !== 'custom');
    $('cfg-pegs-v').textContent = $('cfg-pegs').value; $('cfg-colors-v').textContent = $('cfg-colors').value; $('cfg-guesses-v').textContent = $('cfg-guesses').value;
    let note = '';
    try {
      const cfg = Engine.normalizeConfig(this.setupConfig());
      const space = Engine.spaceSize(cfg);
      note = Engine.describeConfig(cfg) + (this.setup.mode === 'maker' && space > Engine.MAX_ENUM ? ' — too many codes for the solver; pick a smaller board for codemaker mode' : '');
      $('setup-start').disabled = this.setup.mode === 'maker' && space > Engine.MAX_ENUM;
    } catch (e) { note = e.message; $('setup-start').disabled = true; }
    $('setup-note').textContent = note;
    $('setup-mode-text').textContent = this.setup.mode === 'maker' ? 'You hide a code; the server\'s solver (Knuth\'s minimax) tries to break it. Your points: the guesses it needs.' : 'The codemaker hides a code; you break it with as few guesses as possible. Score falls with every guess and hint.';
  };
  P.startFromSetup = function () {
    if ($('setup-start').disabled) return;
    S.click(); this.closeSetup();
    this.game.player = $('player-name').value.trim() || MM.CONFIG.DEFAULT_PLAYER;
    try { localStorage.setItem(ST.player, this.game.player); } catch (e) { /* ignore */ }
    this.game.start({ mode: this.setup.mode, config: this.setupConfig() });
  };

  /* ---------------------------------------------------------- refresh */
  P.refresh = function () {
    const g = this.game, cfg = g.cfg, st = g.state;
    const editing = st === 'playing' || st === 'entry';
    $('btn-check').disabled = !editing && st !== 'over';
    $('btn-check').textContent = st === 'entry' ? 'LOCK CODE' : st === 'over' ? 'PLAY AGAIN' : 'CHECK';
    $('btn-check').classList.toggle('pulse', editing && g.complete());
    $('btn-undo').disabled = !editing || !g.order.length;
    $('btn-clear').disabled = !editing || !g.order.length;
    $('btn-hint').disabled = st !== 'playing' || (cfg && Engine.spaceSize(cfg) > Engine.MAX_ENUM);
    $('btn-resign').disabled = !(st === 'playing' || st === 'entry');
    $('btn-resign').textContent = st === 'entry' ? 'CANCEL' : 'RESIGN';
    $('mode-label').textContent = st === 'idle' ? 'MASTERMIND' : g.mode === 'maker' ? 'CODEMAKER' : 'CODEBREAKER';
    if (cfg) {
      const label = (Engine.PRESETS[cfg.preset] ? Engine.PRESETS[cfg.preset].label : 'Custom') + ' · ' + cfg.pegs + ' × ' + cfg.colors + (cfg.allowBlanks ? '+∅' : '') + ' · ' + cfg.maxGuesses + ' guesses' + (cfg.allowDuplicates ? '' : ' · no repeats');
      $('preset-label').textContent = label;
      const n = g.rows.length;
      $('turn').textContent = st === 'entry' ? 'SET YOUR CODE' : st === 'solving' ? 'SOLVER GUESS ' + n + ' / ' + cfg.maxGuesses : st === 'over' ? (g.view && g.view.status === 'won' ? 'BROKEN IN ' + n : g.view && g.view.status === 'solved' ? 'SOLVED IN ' + n : g.view && g.view.status === 'lost' ? 'OUT OF GUESSES' : g.view && g.view.status === 'resigned' ? 'RESIGNED' : 'UNBROKEN') : 'GUESS ' + Math.min(cfg.maxGuesses, n + 1) + ' / ' + cfg.maxGuesses;
    } else { $('preset-label').textContent = ''; $('turn').textContent = ''; }
  };
  P.message = function (text) { $('message').textContent = text; };
  P.toast = function (text, error) {
    const t = $('toast'); t.textContent = text; t.classList.toggle('error', !!error); t.classList.add('show');
    clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => t.classList.remove('show'), MM.CONFIG.TIMING.toast * 1000);
  };
  P.finished = function (v) {
    const won = v.status === 'won', maker = v.mode === 'maker';
    let title, text;
    if (maker) { title = v.solver.solved ? 'SOLVED IN ' + v.solver.guesses : 'YOUR CODE HELD'; text = v.message + ' Your code: ' + v.secret.colors.join(', ') + '.'; }
    else if (won) { title = v.guesses_used === 1 ? 'FIRST GUESS!' : 'CODE BROKEN'; text = 'In ' + v.guesses_used + ' guess' + (v.guesses_used === 1 ? '' : 'es') + (v.hints_used ? ' with ' + v.hints_used + ' hint' + (v.hints_used === 1 ? '' : 's') : '') + ' · ' + fmtMs(v.duration_ms) + ' · score ' + v.score + '.'; }
    else { title = v.status === 'resigned' ? 'RESIGNED' : 'OUT OF GUESSES'; text = 'The code was ' + v.secret.colors.join(', ') + ' (' + v.secret.letters + ').'; }
    $('banner-title').textContent = title; $('banner-text').textContent = text;
    $('banner').classList.toggle('win', won || (maker && !v.solver.solved)); $('banner').classList.toggle('lose', !won && !maker);
    $('banner').classList.remove('hidden');
    this.loadScores();
  };
  P.hideBanner = function () { $('banner').classList.add('hidden'); };
  P.toggleHelp = function (show) { $('help').classList.toggle('hidden', !show); };
  P.refreshOnline = function () {
    const on = this.client.online, b = $('online');
    b.textContent = on ? 'ONLINE · SHARED SCOREBOARD' : 'OFFLINE · LOCAL SCORES'; b.classList.toggle('on', on);
    b.title = on ? 'Playing against the game server; Claude and other agents play on this same scoreboard through the MCP server' : 'No game server reachable: the game runs in this browser and scores stay on this device';
  };

  /* ------------------------------------------------------- scoreboard */
  P.loadScores = function () {
    return this.client.scores({ limit: 12, player: this.game.player }).then(s => { this.scores = s; this.renderScores(); }).catch(() => { this.scores = null; this.renderScores(); });
  };
  P.renderScores = function () {
    Array.prototype.forEach.call(document.querySelectorAll('#right .tabs button'), b => b.classList.toggle('sel', b.dataset.tab === this.tab));
    const s = this.scores, body = $('board-body');
    if (!s) { body.innerHTML = '<div class="empty">No scores yet.</div>'; $('totals').textContent = ''; return; }
    $('totals').textContent = s.totals.games + ' game' + (s.totals.games === 1 ? '' : 's') + ' · ' + s.totals.players + ' player' + (s.totals.players === 1 ? '' : 's');
    let html = '';
    const me = this.game.player.toLowerCase();
    if (this.tab === 'top') {
      html = s.top_scores.length ? '<table><tr><th>#</th><th>Player</th><th>Score</th><th>Guesses</th><th>Board</th><th>Time</th></tr>' + s.top_scores.map(r => '<tr class="' + (r.player.toLowerCase() === me ? 'me' : '') + '"><td>' + r.rank + '</td><td>' + esc(r.player) + '</td><td class="score">' + r.score + '</td><td>' + r.guesses_used + (r.hints_used ? '+' + r.hints_used + 'h' : '') + '</td><td>' + esc(r.preset) + '</td><td>' + fmtMs(r.duration_ms) + '</td></tr>').join('') + '</table>' : '<div class="empty">No codes broken yet. Be the first.</div>';
    } else if (this.tab === 'players') {
      html = s.players.length ? '<table><tr><th>Player</th><th>Games</th><th>Wins</th><th>Avg</th><th>Best</th></tr>' + s.players.map(p => '<tr class="' + (p.player.toLowerCase() === me ? 'me' : '') + '"><td>' + esc(p.player) + '</td><td>' + p.games + '</td><td>' + p.wins + (p.win_rate != null ? ' <small>' + p.win_rate + '%</small>' : '') + '</td><td>' + (p.avg_guesses_when_won != null ? p.avg_guesses_when_won : '—') + '</td><td class="score">' + p.best_score + '</td></tr>').join('') + '</table>' : '<div class="empty">Nobody has played yet.</div>';
    } else if (this.tab === 'recent') {
      html = s.recent.length ? '<table><tr><th>Player</th><th>Result</th><th>Score</th><th>Board</th><th>When</th></tr>' + s.recent.map(r => '<tr class="' + (r.player.toLowerCase() === me ? 'me' : '') + '"><td>' + esc(r.player) + '</td><td class="' + r.status + '">' + (r.mode === 'maker' ? 'code ' + r.status : r.status) + ' <small>' + r.guesses_used + '</small></td><td class="score">' + r.score + '</td><td>' + esc(r.preset) + '</td><td>' + ago(r.finished_at) + '</td></tr>').join('') + '</table>' : '<div class="empty">No games yet.</div>';
    } else {
      html = s.codemakers.length ? '<table><tr><th>#</th><th>Codemaker</th><th>Points</th><th>Code</th><th>Board</th></tr>' + s.codemakers.map(r => '<tr class="' + (r.player.toLowerCase() === me ? 'me' : '') + '"><td>' + r.rank + '</td><td>' + esc(r.player) + '</td><td class="score">' + r.points + '</td><td class="mono">' + esc(r.secret) + '</td><td>' + esc(r.preset) + '</td></tr>').join('') + '</table>' : '<div class="empty">No codes set yet. Try codemaker mode.</div>';
    }
    if (s.player && s.player.games) html += '<div class="mine">You: ' + s.player.games + ' game' + (s.player.games === 1 ? '' : 's') + ', ' + s.player.wins + ' won' + (s.player.avg_guesses_when_won ? ', ' + s.player.avg_guesses_when_won + ' guesses on average' : '') + ', best ' + s.player.best_score + '</div>';
    body.innerHTML = html;
  };

  P.buildHelp = function () {
    const presets = Engine.PRESETS;
    $('help-body').innerHTML =
      '<p class="rules">The codemaker hides a code of coloured pegs. You have a limited number of guesses to find it. After each guess the key pegs answer: ' +
      '<b>● black</b> = a peg of the right colour in the right place, <b>○ white</b> = a peg of the right colour in the wrong place. The key pegs tell you how many, not which. Each peg is matched at most once.</p>' +
      '<table class="pays">' + Object.keys(presets).map(k => '<tr><td>' + esc(presets[k].label) + '</td><td>' + esc(presets[k].blurb) + '</td><td>' + Engine.spaceSize(presets[k]).toLocaleString('en-US') + ' codes</td></tr>').join('') + '</table>' +
      '<p class="rules"><b>Scoring.</b> 1000 × (guesses allowed + 1 − guesses used − hints) ÷ guesses allowed, scaled by the board\'s difficulty (classic = 1). A classic code broken on the fifth guess scores 600; a loss or resignation scores 0. ' +
      'In <b>codemaker</b> mode your points are the guesses the solver needed.</p>' +
      '<p class="rules"><b>Controls.</b> Click a colour in the tray then a hole (or just click the colour to fill the next hole); drag pegs between holes; right-click removes. Keys <b>1–9</b>/<b>0</b> place colours, <b>Backspace</b> undoes, <b>Enter</b> checks, <b>H</b> hint, <b>N</b> new game, <b>M</b> mute, <b>?</b> help.</p>' +
      '<p class="rules"><b>Agents.</b> The same server exposes an MCP server and a REST API so Claude can sit down at this table and play on the shared scoreboard: see <a href="docs/mcp.html" target="_blank" rel="noopener">docs/mcp.html</a>.</p>';
  };
  MM.UI = UI;
})(window);
