/* ============================================================================
   MASTERMIND server — the game service behind both the REST API and the MCP
   tools. One method per operation; every method takes a plain argument object
   (snake_case, as sent over the wire) and returns a JSON-ready object or
   throws an ApiError with an HTTP status and a machine-readable code.
   ========================================================================== */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
const Core = require(path.join(__dirname, '..', 'js', 'core.js'));
const Store = require('./store.js');
const VERSION = require(path.join(__dirname, '..', 'package.json')).version;

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function wrap(e) {
  if (e instanceof ApiError) return e;
  if (e && (e.name === 'EngineError' || e.name === 'CoreError')) return new ApiError(e.status || 400, e.code || 'bad_request', e.message);
  return e;
}
function lower(s) { return s == null ? null : String(s).toLowerCase(); }

class Service {
  constructor(opts) {
    opts = opts || {};
    this.store = opts.store || new Store(opts.dataFile);
    this.env = { rng: Engine.defaultRng(), now: () => Date.now() };
    this.started = Date.now();
    this.keepFinishedMs = opts.keepFinishedMs || 6 * 3600e3;
    this.idleMs = opts.idleMs || 24 * 3600e3;
    this.maxActive = opts.maxActive || 5000;
    this.pruneTimer = null;
  }
  start() {
    this.store.load();
    this.prune();
    this.pruneTimer = setInterval(() => this.prune(), 60e3);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
    return this;
  }
  stop() { if (this.pruneTimer) clearInterval(this.pruneTimer); this.store.flush(); }
  prune() { return this.store.prune(Date.now(), { keepFinishedMs: this.keepFinishedMs, idleMs: this.idleMs }); }

  /* ------------------------------------------------------------ reads */
  health() {
    const games = this.store.listGames();
    return { ok: true, name: 'mastermind', version: VERSION, time: new Date().toISOString(), uptime_s: Math.round((Date.now() - this.started) / 1000), games_active: games.filter(g => g.status === 'playing').length, games_recorded: this.store.records.length };
  }
  rules() {
    const presets = {};
    Object.keys(Engine.PRESETS).forEach(k => { const p = Engine.PRESETS[k]; presets[k] = { label: p.label, pegs: p.pegs, colors: p.colors, max_guesses: p.maxGuesses, allow_duplicates: p.allowDuplicates, allow_blanks: p.allowBlanks, code_space: Engine.spaceSize(p) }; });
    return {
      text: Core.rulesText(),
      feedback: { black: 'right colour in the right position', white: 'right colour in the wrong position', note: 'key pegs are counts, not positions; each peg is matched at most once' },
      presets: presets,
      limits: { pegs: Engine.LIMITS.pegs, colors: Engine.LIMITS.colors, max_guesses: Engine.LIMITS.maxGuesses, player_name_length: Engine.LIMITS.player },
      palette: Engine.PALETTE.map(c => ({ id: c.id, name: c.name, letter: c.letter, hex: c.hex })),
      blank: { id: 0, name: 'empty', letter: '.', only_when: 'allow_blanks is true' },
      guess_formats: ['["red","green","blue","yellow"]', '"RGBY"', '"1453"', '"red, green, blue, yellow"', '[1,4,5,3]'],
      scoring: { codebreaker: 'round(1000 * (max_guesses + 1 - guesses_used - hints_used) / max_guesses * difficulty); difficulty = ln(code_space)/ln(1296); lost or resigned = 0', codemaker: 'points = guesses the solver needed (+1 if it failed)' }
    };
  }
  getGame(args) {
    const id = this._id(args);
    const g = this.store.getGame(id);
    if (g) return Core.view(g);
    const r = this.store.findRecord(id);
    if (r) return Core.viewFromRecord(r);
    throw new ApiError(404, 'not_found', 'No game with id "' + id + '"');
  }
  listGames(args) {
    args = args || {};
    const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
    const player = args.player ? lower(Core.cleanPlayer(args.player)) : null;
    const status = lower(args.status) || 'playing';
    let games = this.store.listGames();
    if (player) games = games.filter(g => g.player.toLowerCase() === player);
    if (status !== 'all') games = games.filter(g => status === 'finished' ? g.status !== 'playing' : g.status === status);
    games.sort((a, b) => b.updatedAt - a.updatedAt);
    return { count: games.length, games: games.slice(0, limit).map(Core.summary) };
  }
  scores(args) { return Core.leaderboard(this.store.records, args || {}); }

  /* ----------------------------------------------------------- writes */
  newGame(args) {
    args = args || {};
    try {
      const active = this.store.listGames().filter(g => g.status === 'playing').length;
      if (active >= this.maxActive) throw new ApiError(503, 'busy', 'Too many games in progress; try again in a few minutes');
      const g = Core.createGame(args, this.env);
      this.store.putGame(g);
      if (Core.isFinished(g)) this.store.addRecord(Core.record(g));
      return Core.view(g);
    } catch (e) { throw wrap(e); }
  }
  guess(args) {
    args = args || {};
    try {
      const g = this._live(args);
      if (args.guess == null) throw new ApiError(400, 'missing_argument', 'guess is required (for example ["red","green","blue","yellow"] or "RGBY")');
      const fb = Core.applyGuess(g, args.guess, this.env);
      this.store.putGame(g);
      if (Core.isFinished(g)) this.store.addRecord(Core.record(g));
      return Object.assign({ feedback: { black: fb.black, white: fb.white }, correct: fb.black === g.config.pegs }, Core.view(g));
    } catch (e) { throw wrap(e); }
  }
  hint(args) {
    try {
      const g = this._live(args);
      const h = Core.applyHint(g, this.env);
      this.store.putGame(g);
      return { game_id: g.id, remaining_codes: h.remaining, suggestion: Core.codeView(h.suggestion), sample: h.sample.map(Core.codeView), hints_used: g.hints.length, note: 'Each hint counts as one extra guess in the score.' };
    } catch (e) { throw wrap(e); }
  }
  resign(args) {
    try {
      const g = this._live(args);
      Core.resign(g, this.env);
      this.store.putGame(g);
      this.store.addRecord(Core.record(g));
      return Core.view(g);
    } catch (e) { throw wrap(e); }
  }

  /* ---------------------------------------------------------- helpers */
  _id(args) {
    const id = args && (args.game_id != null ? args.game_id : args.gameId);
    if (id == null || id === '') throw new ApiError(400, 'missing_game_id', 'game_id is required');
    return String(id);
  }
  _live(args) {
    const id = this._id(args), g = this.store.getGame(id);
    if (g) return g;
    const r = this.store.findRecord(id);
    if (r) throw new ApiError(409, 'game_over', 'Game "' + id + '" is finished (' + r.status + '); start another with new_game');
    throw new ApiError(404, 'not_found', 'No game with id "' + id + '"');
  }
}
Service.ApiError = ApiError;
Service.VERSION = VERSION;
module.exports = Service;
