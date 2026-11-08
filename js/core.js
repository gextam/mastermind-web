/* ============================================================================
   MASTERMIND — game core, shared by the Node server and the browser's offline
   fallback: game lifecycle (create, guess, hint, resign), the public JSON view
   an API client sees, finished-game records and the leaderboard. Pure
   functions over plain objects; persistence lives in the caller.
   UMD: window.MM.Core in the browser, module.exports in Node.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else { root.MM = root.MM || {}; root.MM.Core = factory(root.MM.Engine); }
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';
  const VERSION = '1.0.0';

  function CoreError(code, message, status) { this.name = 'CoreError'; this.code = code; this.message = message; this.status = status || 400; }
  CoreError.prototype = Object.create(Error.prototype);
  CoreError.prototype.constructor = CoreError;

  const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  function newId(rng) { let s = ''; for (let i = 0; i < 12; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)]; return s; }
  function cleanPlayer(name) {
    if (name == null) return 'Anonymous';
    const s = String(name).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, Engine.LIMITS.player);
    return s || 'Anonymous';
  }
  function env(e) { e = e || {}; return { rng: e.rng || Engine.defaultRng(), now: e.now || (() => Date.now()) }; }

  /* ---------------------------------------------------------- lifecycle */
  function createGame(args, e) {
    args = args || {}; e = env(e);
    const cfg = Engine.normalizeConfig(args);
    const mode = String(args.mode || 'breaker').toLowerCase();
    if (mode !== 'breaker' && mode !== 'maker') throw new CoreError('invalid_mode', 'mode must be "breaker" (you guess the server\'s code) or "maker" (you set a code and the server\'s solver breaks it)');
    const now = e.now();
    const game = { id: newId(e.rng), player: cleanPlayer(args.player), mode: mode, config: cfg, status: 'playing', history: [], hints: [], createdAt: now, updatedAt: now, finishedAt: null, durationMs: null, score: null, secret: null, solver: null };
    if (mode === 'maker') {
      if (args.secret == null) throw new CoreError('missing_secret', 'maker mode needs a "secret" code for the solver to break');
      if (Engine.spaceSize(cfg) > Engine.MAX_ENUM) throw new CoreError('too_large', 'This code space is too large for the solver (limit ' + Engine.MAX_ENUM + ' codes)');
      game.secret = Engine.parseCode(args.secret, cfg);
      const r = Engine.solve(cfg, game.secret, cfg.maxGuesses);
      game.history = r.guesses.map(g => ({ guess: g.guess, black: g.black, white: g.white, at: now }));
      game.solver = { solved: r.solved, steps: r.guesses.length, points: r.guesses.length + (r.solved ? 0 : 1) };
      game.status = r.solved ? 'solved' : 'unsolved';
      finish(game, now);
    } else {
      game.secret = Engine.randomCode(cfg, e.rng);
    }
    return game;
  }
  function assertPlaying(game) {
    if (game.mode !== 'breaker') throw new CoreError('wrong_mode', 'This is a codemaker game: the solver has already played it', 409);
    if (game.status !== 'playing') throw new CoreError('game_over', 'This game is finished (' + game.status + '). Start another with new_game.', 409);
  }
  function applyGuess(game, input, e) {
    e = env(e); assertPlaying(game);
    const guess = Engine.parseCode(input, game.config), fb = Engine.feedback(game.secret, guess), now = e.now();
    game.history.push({ guess: guess, black: fb.black, white: fb.white, at: now });
    game.updatedAt = now;
    if (fb.black === game.config.pegs) { game.status = 'won'; finish(game, now); }
    else if (game.history.length >= game.config.maxGuesses) { game.status = 'lost'; finish(game, now); }
    return fb;
  }
  function applyHint(game, e) {
    e = env(e); assertPlaying(game);
    if (Engine.spaceSize(game.config) > Engine.MAX_ENUM) throw new CoreError('too_large', 'Hints are not available for a code space this large');
    const h = Engine.hint(game.config, game.history), now = e.now();
    game.hints.push({ at: now, remaining: h.remaining, suggestion: h.suggestion });
    game.updatedAt = now;
    return h;
  }
  function resign(game, e) {
    e = env(e); assertPlaying(game);
    game.status = 'resigned'; finish(game, e.now());
    return game;
  }
  function finish(game, now) {
    game.updatedAt = now; game.finishedAt = now; game.durationMs = Math.max(0, now - game.createdAt);
    if (game.mode === 'breaker') game.score = Engine.score(game.config, { won: game.status === 'won', guessesUsed: game.history.length, hints: game.hints.length });
    else game.score = game.solver.points;
  }
  function isFinished(game) { return game.status !== 'playing'; }

  /* -------------------------------------------------------------- views */
  function iso(t) { return t == null ? null : new Date(t).toISOString(); }
  function configView(cfg) { return { preset: cfg.preset, pegs: cfg.pegs, colors: cfg.colors, max_guesses: cfg.maxGuesses, allow_duplicates: cfg.allowDuplicates, allow_blanks: cfg.allowBlanks, code_space: Engine.spaceSize(cfg), difficulty: Math.round(Engine.difficulty(cfg) * 100) / 100 }; }
  function codeView(ids) { return { colors: Engine.codeNames(ids), letters: Engine.codeLetters(ids), ids: ids.slice() }; }
  function historyView(history) { return history.map((h, i) => ({ turn: i + 1, guess: Engine.codeNames(h.guess), letters: Engine.codeLetters(h.guess), black: h.black, white: h.white })); }
  function message(game) {
    const cfg = game.config, n = game.history.length;
    if (game.mode === 'maker') {
      return game.solver.solved ? 'The solver broke your code in ' + n + ' guess' + (n === 1 ? '' : 'es') + '. Codemaker points: ' + game.solver.points + '.'
        : 'The solver failed to break your code in ' + n + ' guesses. Codemaker points: ' + game.solver.points + '.';
    }
    if (game.status === 'won') return 'Code broken in ' + n + ' guess' + (n === 1 ? '' : 'es') + (game.hints.length ? ' with ' + game.hints.length + ' hint' + (game.hints.length === 1 ? '' : 's') : '') + '. Score ' + game.score + '.';
    if (game.status === 'lost') return 'Out of guesses. The code was ' + Engine.codeNames(game.secret).join(', ') + ' (' + Engine.codeLetters(game.secret) + '). Score 0.';
    if (game.status === 'resigned') return 'You resigned. The code was ' + Engine.codeNames(game.secret).join(', ') + ' (' + Engine.codeLetters(game.secret) + ').';
    const left = cfg.maxGuesses - n;
    const last = n ? ' Last answer: ' + game.history[n - 1].black + ' black, ' + game.history[n - 1].white + ' white.' : '';
    return 'Guess ' + (n + 1) + ' of ' + cfg.maxGuesses + ' (' + left + ' left).' + last + ' Send a code of ' + cfg.pegs + ' colours with guess(game_id, guess); black = right colour in the right position, white = right colour in the wrong position.';
  }
  function view(game) {
    const v = {
      game_id: game.id, player: game.player, mode: game.mode, status: game.status, finished: isFinished(game),
      config: configView(game.config), palette: Engine.paletteFor(game.config).map(p => ({ id: p.id, name: p.name, letter: p.letter })),
      guesses_used: game.history.length, guesses_left: Math.max(0, game.config.maxGuesses - game.history.length),
      hints_used: game.hints.length, history: historyView(game.history),
      created_at: iso(game.createdAt), updated_at: iso(game.updatedAt), message: message(game)
    };
    if (isFinished(game)) {
      v.secret = codeView(game.secret); v.score = game.score; v.duration_ms = game.durationMs; v.finished_at = iso(game.finishedAt);
      if (game.mode === 'maker') v.solver = { solved: game.solver.solved, guesses: game.solver.steps, points: game.solver.points };
    }
    return v;
  }
  function summary(game) {
    return { game_id: game.id, player: game.player, mode: game.mode, status: game.status, preset: game.config.preset, pegs: game.config.pegs, colors: game.config.colors, guesses_used: game.history.length, guesses_left: Math.max(0, game.config.maxGuesses - game.history.length), score: game.score, created_at: iso(game.createdAt), updated_at: iso(game.updatedAt) };
  }
  function record(game) {
    if (!isFinished(game)) throw new CoreError('not_finished', 'Only finished games become records');
    return {
      game_id: game.id, player: game.player, mode: game.mode, status: game.status, won: game.mode === 'breaker' ? game.status === 'won' : game.status === 'unsolved',
      config: configView(game.config), guesses_used: game.history.length, hints_used: game.hints.length, score: game.score,
      duration_ms: game.durationMs, created_at: iso(game.createdAt), finished_at: iso(game.finishedAt),
      secret: Engine.codeLetters(game.secret), history: game.history.map(h => Engine.codeLetters(h.guess) + ' ' + h.black + 'b' + h.white + 'w')
    };
  }
  /* a finished record presented like a game view (for get_game after the live object has been pruned) */
  function viewFromRecord(r) {
    return { game_id: r.game_id, player: r.player, mode: r.mode, status: r.status, finished: true, archived: true, config: r.config, guesses_used: r.guesses_used, guesses_left: Math.max(0, r.config.max_guesses - r.guesses_used), hints_used: r.hints_used, history: r.history, secret: r.secret, score: r.score, duration_ms: r.duration_ms, created_at: r.created_at, finished_at: r.finished_at, message: 'Archived game (' + r.status + '). Score ' + r.score + '.' };
  }

  /* -------------------------------------------------------- leaderboard */
  function leaderboard(records, opts) {
    opts = opts || {};
    const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 10));
    const who = opts.player ? cleanPlayer(opts.player).toLowerCase() : null;
    const modeFilter = opts.mode ? String(opts.mode).toLowerCase() : null;
    const all = records.filter(r => !modeFilter || r.mode === modeFilter);
    const breaker = all.filter(r => r.mode === 'breaker'), maker = all.filter(r => r.mode === 'maker');
    const byScore = (a, b) => (b.score - a.score) || (a.duration_ms - b.duration_ms) || (a.finished_at < b.finished_at ? -1 : 1);
    const rowOf = (r, i) => ({ rank: i + 1, player: r.player, score: r.score, preset: r.config.preset, pegs: r.config.pegs, colors: r.config.colors, guesses_used: r.guesses_used, hints_used: r.hints_used, duration_ms: r.duration_ms, finished_at: r.finished_at, game_id: r.game_id });
    const top = breaker.filter(r => r.won).sort(byScore).slice(0, limit).map(rowOf);
    const codemakers = maker.slice().sort((a, b) => (b.score - a.score) || (a.finished_at < b.finished_at ? -1 : 1)).slice(0, limit).map((r, i) => ({ rank: i + 1, player: r.player, points: r.score, solver_guesses: r.guesses_used, solved: r.status === 'solved', preset: r.config.preset, secret: r.secret, finished_at: r.finished_at, game_id: r.game_id }));
    const recent = all.slice(-limit).reverse().map(r => ({ player: r.player, mode: r.mode, status: r.status, score: r.score, preset: r.config.preset, guesses_used: r.guesses_used, finished_at: r.finished_at, game_id: r.game_id }));
    const stats = new Map();
    all.forEach(r => {
      const k = r.player.toLowerCase();
      let s = stats.get(k);
      if (!s) { s = { player: r.player, games: 0, breaker_games: 0, wins: 0, losses: 0, resigned: 0, best_score: 0, total_score: 0, _guessSum: 0, maker_games: 0, maker_points: 0, last_played: r.finished_at }; stats.set(k, s); }
      s.games++;
      if (r.mode === 'breaker') {
        s.breaker_games++; s.total_score += r.score; if (r.score > s.best_score) s.best_score = r.score;
        if (r.status === 'won') { s.wins++; s._guessSum += r.guesses_used; } else if (r.status === 'lost') s.losses++; else s.resigned++;
      } else { s.maker_games++; s.maker_points += r.score; }
      if (r.finished_at > s.last_played) s.last_played = r.finished_at;
    });
    const players = Array.from(stats.values()).map(s => ({
      player: s.player, games: s.games, wins: s.wins, losses: s.losses, resigned: s.resigned,
      win_rate: s.breaker_games ? Math.round(1000 * s.wins / s.breaker_games) / 10 : null,
      avg_guesses_when_won: s.wins ? Math.round(10 * s._guessSum / s.wins) / 10 : null,
      best_score: s.best_score, total_score: s.total_score, maker_games: s.maker_games, maker_points: s.maker_points, last_played: s.last_played
    })).sort((a, b) => (b.best_score - a.best_score) || (b.total_score - a.total_score) || (b.wins - a.wins));
    const out = {
      generated_at: new Date().toISOString(),
      totals: { games: all.length, breaker_games: breaker.length, wins: breaker.filter(r => r.won).length, losses: breaker.filter(r => r.status === 'lost').length, resigned: breaker.filter(r => r.status === 'resigned').length, maker_games: maker.length, players: players.length },
      top_scores: top, codemakers: codemakers, players: players.slice(0, limit), recent: recent
    };
    if (who) {
      out.player = players.find(p => p.player.toLowerCase() === who) || { player: cleanPlayer(opts.player), games: 0, wins: 0, losses: 0, resigned: 0, best_score: 0, total_score: 0 };
      out.player_games = all.filter(r => r.player.toLowerCase() === who).slice(-limit).reverse().map(r => ({ game_id: r.game_id, mode: r.mode, status: r.status, score: r.score, preset: r.config.preset, guesses_used: r.guesses_used, hints_used: r.hints_used, duration_ms: r.duration_ms, finished_at: r.finished_at, secret: r.secret, history: r.history }));
    }
    return out;
  }

  /* --------------------------------------------------------------- rules */
  function rulesText() {
    const presets = Object.keys(Engine.PRESETS).map(k => '- `' + k + '`: ' + Engine.PRESETS[k].blurb).join('\n');
    const palette = Engine.PALETTE.map(c => c.id + ' ' + c.name + ' (' + c.letter + ')').join(', ');
    return [
      '# Mastermind',
      '',
      'The codemaker hides a code of N coloured pegs; the codebreaker has a limited number of guesses to find it.',
      'After each guess the codemaker answers with key pegs: a **black** peg for every peg of the right colour in the right position,',
      'a **white** peg for every peg of the right colour in the wrong position. Key pegs are not ordered: they say how many, not which.',
      'Each secret peg and each guess peg is counted at most once (a guess with two reds against a code with one red earns one key peg for red, not two).',
      'The code is broken when the answer is all black.',
      '',
      '## Boards',
      presets,
      '- custom: pegs ' + Engine.LIMITS.pegs.join('-') + ', colours ' + Engine.LIMITS.colors.join('-') + ', guesses ' + Engine.LIMITS.maxGuesses.join('-') + ', repeats on/off, blanks on/off.',
      '',
      '## Colours',
      'Numbered colours (a game uses the first `colors` of them): ' + palette + '. With blanks enabled, `0` / `empty` / `.` is an extra symbol.',
      'A guess may be sent as an array of names, letters or numbers (["red","blue","green","yellow"]), or as a string of letters ("RBGY"), digits ("1542") or comma-separated names.',
      '',
      '## Scoring',
      'Codebreaker: score = round(1000 × (max_guesses + 1 − guesses_used − hints_used) / max_guesses × difficulty), where difficulty = log(code_space) / log(1296), so a classic game solved on the first guess scores 1000, on the fifth 600, on the tenth 100. Lost or resigned games score 0.',
      'Codemaker (mode "maker"): you provide a secret and the server\'s Knuth minimax solver breaks it; your points are the number of guesses it needed, +1 if it failed. On the classic board the solver never needs more than five.',
      '',
      '## A good way to play',
      'Open with a guess of two pairs (RRGG), keep only the codes consistent with every answer so far, and guess one that is still possible (or the one that splits the remaining set best). On the classic board that wins in at most five guesses.'
    ].join('\n');
  }

  return {
    VERSION: VERSION, CoreError: CoreError, newId: newId, cleanPlayer: cleanPlayer,
    createGame: createGame, applyGuess: applyGuess, applyHint: applyHint, resign: resign, isFinished: isFinished,
    view: view, summary: summary, record: record, viewFromRecord: viewFromRecord, leaderboard: leaderboard, rulesText: rulesText, configView: configView, codeView: codeView
  };
});
