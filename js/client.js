/* ============================================================================
   MASTERMIND — API client. When the page is served by the Mastermind server
   (or any origin exposing /api), games are played against it and the
   scoreboard is shared with every remote player (Claude included). Otherwise
   (static hosting, file://) the same game core runs in the browser with a
   localStorage scoreboard. Both paths return the identical JSON views.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, Core = MM.Core, Engine = MM.Engine, ST = MM.CONFIG.STORAGE;
  function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function apiError(e) {
    if (e && e.code && e.message) return { code: e.code, message: e.message, status: e.status || 400 };
    return { code: 'error', message: (e && e.message) || String(e), status: 500 };
  }

  /* ------------------------------------------------- in-browser server */
  function LocalServer() {
    this.games = new Map();
    this.records = lsGet(ST.records, []);
    this.env = { rng: Engine.defaultRng(), now: () => Date.now() };
    const saved = lsGet(ST.game, null);
    if (saved && saved.id && saved.status === 'playing') this.games.set(saved.id, saved);
  }
  LocalServer.prototype._save = function (g) {
    if (g && g.status === 'playing') lsSet(ST.game, g); else try { localStorage.removeItem(ST.game); } catch (e) { /* ignore */ }
  };
  LocalServer.prototype._finish = function (g) {
    if (Core.isFinished(g)) { this.records.push(Core.record(g)); if (this.records.length > 500) this.records.splice(0, this.records.length - 500); lsSet(ST.records, this.records); }
    this._save(g);
  };
  LocalServer.prototype._live = function (id) {
    const g = this.games.get(id);
    if (!g) throw { code: 'not_found', message: 'No game with id ' + id, status: 404 };
    return g;
  };
  LocalServer.prototype.newGame = function (args) {
    const g = Core.createGame(args, this.env);
    this.games.set(g.id, g); this._finish(g);
    return Core.view(g);
  };
  LocalServer.prototype.guess = function (id, guess) {
    const g = this._live(id), fb = Core.applyGuess(g, guess, this.env);
    this._finish(g);
    return Object.assign({ feedback: fb, correct: fb.black === g.config.pegs }, Core.view(g));
  };
  LocalServer.prototype.hint = function (id) {
    const g = this._live(id), h = Core.applyHint(g, this.env);
    this._save(g);
    return { game_id: g.id, remaining_codes: h.remaining, suggestion: Core.codeView(h.suggestion), sample: h.sample.map(Core.codeView), hints_used: g.hints.length };
  };
  LocalServer.prototype.resign = function (id) { const g = this._live(id); Core.resign(g, this.env); this._finish(g); return Core.view(g); };
  LocalServer.prototype.getGame = function (id) {
    const g = this.games.get(id);
    if (g) return Core.view(g);
    const r = this.records.slice().reverse().find(x => x.game_id === id);
    if (r) return Core.viewFromRecord(r);
    throw { code: 'not_found', message: 'No game with id ' + id, status: 404 };
  };
  LocalServer.prototype.scores = function (opts) { return Core.leaderboard(this.records, opts || {}); };
  LocalServer.prototype.resumable = function () { const g = Array.from(this.games.values()).find(x => x.status === 'playing'); return g ? g.id : null; };

  /* ------------------------------------------------------------ client */
  function Client() {
    this.online = false;
    this.server = null;
    this.base = new URL('api/', document.baseURI).href;
    this.local = new LocalServer();
    this.onStatus = null;
  }
  Client.prototype.init = function (forceLocal) {
    if (forceLocal) { this.online = false; return Promise.resolve(false); }
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 2500);
    return fetch(this.base + 'health', { signal: ctl ? ctl.signal : undefined, cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { this.online = !!(j && j.ok); this.server = j; return this.online; })
      .catch(() => { this.online = false; return false; })
      .finally(() => clearTimeout(timer));
  };
  Client.prototype._fetch = function (method, path, body) {
    return fetch(this.base + path, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(r => r.text().then(t => { let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ } if (!r.ok) { const err = (j && j.error) || { code: 'http_' + r.status, message: 'Server error ' + r.status }; err.status = r.status; throw err; } return j; }))
      .catch(e => { if (e && e.code) throw e; this.online = false; if (this.onStatus) this.onStatus(false); throw { code: 'network', message: 'The game server did not answer', status: 0 }; });
  };
  Client.prototype._local = function (fn) { return new Promise((resolve, reject) => { try { resolve(fn()); } catch (e) { reject(apiError(e)); } }); };
  Client.prototype.newGame = function (args) { return this.online ? this._fetch('POST', 'games', args) : this._local(() => this.local.newGame(args)); };
  Client.prototype.guess = function (id, guess) { return this.online ? this._fetch('POST', 'games/' + encodeURIComponent(id) + '/guess', { guess: guess }) : this._local(() => this.local.guess(id, guess)); };
  Client.prototype.hint = function (id) { return this.online ? this._fetch('POST', 'games/' + encodeURIComponent(id) + '/hint') : this._local(() => this.local.hint(id)); };
  Client.prototype.resign = function (id) { return this.online ? this._fetch('POST', 'games/' + encodeURIComponent(id) + '/resign') : this._local(() => this.local.resign(id)); };
  Client.prototype.getGame = function (id) { return this.online ? this._fetch('GET', 'games/' + encodeURIComponent(id)) : this._local(() => this.local.getGame(id)); };
  Client.prototype.scores = function (opts) {
    opts = opts || {};
    const q = Object.keys(opts).filter(k => opts[k] != null && opts[k] !== '').map(k => encodeURIComponent(k) + '=' + encodeURIComponent(opts[k])).join('&');
    return this.online ? this._fetch('GET', 'scores' + (q ? '?' + q : '')) : this._local(() => this.local.scores(opts));
  };
  /* remember / recover the game in progress across reloads */
  Client.prototype.rememberGame = function (id) { try { if (id) localStorage.setItem(ST.game + '.id', id); else localStorage.removeItem(ST.game + '.id'); } catch (e) { /* ignore */ } };
  Client.prototype.resumableId = function () {
    if (!this.online) return this.local.resumable();
    try { return localStorage.getItem(ST.game + '.id'); } catch (e) { return null; }
  };
  MM.Client = Client;
  MM.LocalServer = LocalServer;
})(window);
