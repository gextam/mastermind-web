#!/usr/bin/env node
/* ============================================================================
   tools/test-engine.js — rules engine, solver and game-core tests.
   Checks the feedback rules on the classic corner cases, guess parsing in
   every notation, the code spaces, the scoring formula, the game lifecycle
   and the leaderboard, then sweeps Knuth's solver over every classic secret
   (all 1296 must fall in at most five guesses).
   usage: node tools/test-engine.js [--quick]
   ========================================================================== */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
const Core = require(path.join(__dirname, '..', 'js', 'core.js'));
const QUICK = process.argv.includes('--quick');
let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); } }
function throws(name, fn, code) { try { fn(); check(name, false, 'no error thrown'); } catch (e) { check(name, !code || e.code === code, e.code + ': ' + e.message); } }
const fb = (s, g) => { const r = Engine.feedback(s, g); return r.black + 'b' + r.white + 'w'; };

/* ------------------------------------------------------------ feedback */
check('exact match', fb([1, 2, 3, 4], [1, 2, 3, 4]) === '4b0w');
check('all misplaced', fb([1, 2, 3, 4], [4, 3, 2, 1]) === '0b4w');
check('pairs swapped', fb([1, 1, 2, 2], [1, 2, 1, 2]) === '2b2w');
check('triple vs pairs', fb([1, 1, 1, 2], [1, 1, 2, 2]) === '3b0w');
check('each peg counted once', fb([1, 2, 3, 4], [1, 1, 1, 1]) === '1b0w');
check('duplicate accounting', fb([1, 2, 2, 3], [2, 2, 1, 1]) === '1b2w');
check('no match', fb([1, 1, 1, 1], [2, 2, 2, 2]) === '0b0w');
check('blanks are a symbol', fb([0, 1, 0, 2], [0, 0, 1, 2]) === '2b2w');
check('five pegs', fb([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) === '1b4w');

/* -------------------------------------------------------------- config */
const classic = Engine.normalizeConfig({});
check('default config is classic', classic.preset === 'classic' && classic.pegs === 4 && classic.colors === 6 && classic.maxGuesses === 10 && classic.allowDuplicates && !classic.allowBlanks);
check('space classic 1296', Engine.spaceSize(classic) === 1296);
check('space unique 360', Engine.spaceSize(Engine.normalizeConfig({ preset: 'unique' })) === 360);
check('space blanks 2401', Engine.spaceSize(Engine.normalizeConfig({ preset: 'blanks' })) === 2401);
check('space super 32768', Engine.spaceSize(Engine.normalizeConfig({ preset: 'super' })) === 32768);
check('custom config detected as custom', Engine.normalizeConfig({ pegs: 4, colors: 7 }).preset === 'custom');
check('preset overridable', Engine.normalizeConfig({ preset: 'classic', max_guesses: 12 }).maxGuesses === 12);
check('snake and camel accepted', Engine.normalizeConfig({ maxGuesses: 7, allow_blanks: 'true' }).maxGuesses === 7 && Engine.normalizeConfig({ allow_blanks: 'true' }).allowBlanks === true);
check('difficulty classic 1', Math.abs(Engine.difficulty(classic) - 1) < 1e-9);
throws('unknown preset rejected', () => Engine.normalizeConfig({ preset: 'mega' }), 'unknown_preset');
throws('pegs out of range', () => Engine.normalizeConfig({ pegs: 9 }), 'invalid_config');
throws('no repeats needs enough colours', () => Engine.normalizeConfig({ pegs: 5, colors: 4, allow_duplicates: false }), 'invalid_config');

/* ------------------------------------------------------------- parsing */
check('parse letters', Engine.parseCode('RGBY', classic).join() === '1,4,5,3');
check('parse lowercase letters', Engine.parseCode('rgby', classic).join() === '1,4,5,3');
check('parse names array', Engine.parseCode(['red', 'green', 'blue', 'yellow'], classic).join() === '1,4,5,3');
check('parse digits string', Engine.parseCode('1453', classic).join() === '1,4,5,3');
check('parse numbers array', Engine.parseCode([1, 4, 5, 3], classic).join() === '1,4,5,3');
check('parse comma names', Engine.parseCode('red, green, blue, yellow', classic).join() === '1,4,5,3');
check('parse spaced letters', Engine.parseCode('R G B Y', classic).join() === '1,4,5,3');
check('parse aliases', Engine.parseCode(['violet', 'navy', 'crimson', 'gold'], classic).join() === '6,5,1,3');
const blanks = Engine.normalizeConfig({ preset: 'blanks' });
check('parse blanks', Engine.parseCode('R..B', blanks).join() === '1,0,0,5' && Engine.parseCode(['red', 'empty', 'blank', 0], blanks).join() === '1,0,0,0');
throws('wrong length rejected', () => Engine.parseCode('RGB', classic), 'invalid_guess');
throws('unknown colour rejected', () => Engine.parseCode('RGBZ', classic), 'invalid_colour');
throws('colour beyond palette rejected', () => Engine.parseCode('RGBW', Engine.normalizeConfig({ colors: 6 })), 'invalid_colour');
throws('repeat rejected without duplicates', () => Engine.parseCode('RRGB', Engine.normalizeConfig({ preset: 'unique' })), 'invalid_guess');
throws('blank rejected when disabled', () => Engine.parseCode('R..B', classic), 'invalid_colour');
check('letters round trip', Engine.codeLetters([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) === 'ROYGBPWKCN');

/* -------------------------------------------------------------- random */
let okRandom = true;
for (let i = 0; i < 2000 && okRandom; i++) { const c = Engine.randomCode(classic); okRandom = c.length === 4 && c.every(x => x >= 1 && x <= 6); }
check('random codes valid', okRandom);
const uniqueCfg = Engine.normalizeConfig({ preset: 'unique' });
let okUnique = true;
for (let i = 0; i < 2000 && okUnique; i++) { const c = Engine.randomCode(uniqueCfg); okUnique = new Set(c).size === 4; }
check('random codes without repeats', okUnique);
const seeded = Engine.mulberry32(42);
check('seeded rng deterministic', Engine.randomCode(classic, Engine.mulberry32(7)).join() === Engine.randomCode(classic, Engine.mulberry32(7)).join() && typeof seeded() === 'number');

/* ------------------------------------------------------------- scoring */
check('score first guess 1000', Engine.score(classic, { won: true, guessesUsed: 1 }) === 1000);
check('score fifth guess 600', Engine.score(classic, { won: true, guessesUsed: 5 }) === 600);
check('score tenth guess 100', Engine.score(classic, { won: true, guessesUsed: 10 }) === 100);
check('score lost 0', Engine.score(classic, { won: false, guessesUsed: 10 }) === 0);
check('hints cost a guess', Engine.score(classic, { won: true, guessesUsed: 4, hints: 1 }) === 600);
check('super scaled by difficulty', Engine.score(Engine.normalizeConfig({ preset: 'super' }), { won: true, guessesUsed: 1 }) === Math.round(1000 * Math.log(32768) / Math.log(1296)));

/* -------------------------------------------------------------- solver */
const solver = Engine.solverFor(classic);
check('first guess is two pairs (1122)', solver.next([]).join('') === '1122', solver.next([]));
const h1 = [{ guess: [1, 1, 2, 2], black: 0, white: 0 }];
check('consistent count after 0b0w on 1122 is 256', solver.consistent(h1).length === 256);
check('remaining sample is consistent', solver.remaining(h1).sample.every(c => c.every(x => x >= 3)));
let t0 = Date.now();
const dist = {}, failures = [];
const e = Engine.enumerate(classic);
const step = QUICK ? 7 : 1;
for (let i = 0; i < e.n; i += step) {
  const secret = []; for (let k = 0; k < 4; k++) secret.push(e.data[i * 4 + k]);
  const r = Engine.solve(classic, secret, 10);
  const n = r.guesses.length;
  dist[n] = (dist[n] || 0) + 1;
  if (!r.solved || n > 5) failures.push(secret.join(''));
}
const sweepMs = Date.now() - t0, total = Object.values(dist).reduce((a, b) => a + b, 0);
const avg = Object.keys(dist).reduce((a, k) => a + k * dist[k], 0) / total;
console.log('     classic sweep: ' + total + ' secrets in ' + sweepMs + ' ms, distribution ' + JSON.stringify(dist) + ', average ' + avg.toFixed(3));
check('every classic code falls in at most five guesses', failures.length === 0, failures.slice(0, 10));
check('average under 4.5 guesses', avg < 4.5, avg);

const mini = Engine.normalizeConfig({ preset: 'mini' });
let miniWorst = 0; const em = Engine.enumerate(mini);
for (let i = 0; i < em.n; i++) { const s = []; for (let k = 0; k < 3; k++) s.push(em.data[i * 3 + k]); const r = Engine.solve(mini, s, 8); if (!r.solved) miniWorst = 99; else miniWorst = Math.max(miniWorst, r.guesses.length); }
check('mini board solved within 5', miniWorst <= 5, miniWorst);
let uniqWorst = 0; const eu = Engine.enumerate(uniqueCfg);
for (let i = 0; i < eu.n; i++) { const s = []; for (let k = 0; k < 4; k++) s.push(eu.data[i * 4 + k]); const r = Engine.solve(uniqueCfg, s, 10); if (!r.solved) uniqWorst = 99; else uniqWorst = Math.max(uniqWorst, r.guesses.length); }
check('no-repeat board solved within 6', uniqWorst <= 6, uniqWorst);
const superCfg = Engine.normalizeConfig({ preset: 'super' });
t0 = Date.now(); let superWorst = 0; const rngS = Engine.mulberry32(99);
for (let i = 0; i < (QUICK ? 4 : 12); i++) { const r = Engine.solve(superCfg, Engine.randomCode(superCfg, rngS), 12); if (!r.solved) superWorst = 99; else superWorst = Math.max(superWorst, r.guesses.length); }
console.log('     super sample: worst ' + superWorst + ' guesses, ' + (Date.now() - t0) + ' ms');
check('super board solved within 9 guesses', superWorst <= 9, superWorst);
const grand = Engine.normalizeConfig({ preset: 'grand' });
t0 = Date.now(); const rg = Engine.solve(grand, Engine.randomCode(grand, Engine.mulberry32(5)), 15);
console.log('     grand board: ' + rg.guesses.length + ' guesses, ' + (Date.now() - t0) + ' ms');
check('grand board solved', rg.solved && rg.guesses.length <= 12, rg.guesses.length);
throws('solver refuses huge spaces', () => Engine.solverFor(Engine.normalizeConfig({ pegs: 8, colors: 10 })), 'too_large');
const hint = Engine.hint(classic, [{ guess: [1, 1, 2, 2], black: 1, white: 0 }]);
check('hint reports remaining and suggestion', hint.remaining === 256 && hint.suggestion.length === 4 && hint.sample.length === 5, hint.remaining);
throws('hint on contradictory history', () => Engine.hint(classic, [{ guess: [1, 1, 1, 1], black: 4, white: 0 }, { guess: [2, 2, 2, 2], black: 4, white: 0 }]), 'inconsistent');

/* ---------------------------------------------------------------- core */
let clock = 1000;
const env = { rng: Engine.mulberry32(3), now: () => (clock += 1000) };
const g = Core.createGame({ player: '  Claude  ', preset: 'classic' }, env);
check('game created playing', g.status === 'playing' && g.player === 'Claude' && g.id.length === 12 && g.secret.length === 4);
const v0 = Core.view(g);
check('view hides the secret', v0.secret === undefined && v0.guesses_left === 10 && v0.palette.length === 6 && /Guess 1 of 10/.test(v0.message));
const wrong = g.secret.map(x => (x % 6) + 1);
const fb1 = Core.applyGuess(g, wrong, env);
check('wrong guess recorded', g.history.length === 1 && fb1.black === 0 && Core.view(g).history[0].turn === 1);
const hintR = Core.applyHint(g, env);
check('hint recorded', g.hints.length === 1 && hintR.remaining > 0);
const fbWin = Core.applyGuess(g, Engine.codeLetters(g.secret), env);
check('winning guess ends the game', fbWin.black === 4 && g.status === 'won' && g.score === Engine.score(classic, { won: true, guessesUsed: 2, hints: 1 }));
const vWin = Core.view(g);
check('finished view shows secret and score', vWin.secret.letters === Engine.codeLetters(g.secret) && vWin.score === 800 && vWin.finished === true && vWin.duration_ms > 0);
throws('guess after finish is game_over', () => Core.applyGuess(g, 'RRRR', env), 'game_over');
const rec = Core.record(g);
check('record compact', rec.won === true && rec.history.length === 2 && rec.secret.length === 4 && rec.hints_used === 1);
const g2 = Core.createGame({ player: 'Loser', preset: 'mini' }, env);
for (let i = 0; i < 8 && g2.status === 'playing'; i++) Core.applyGuess(g2, g2.secret.map(x => (x % 6) + 1), env);
check('out of guesses loses', g2.status === 'lost' && g2.score === 0 && /The code was/.test(Core.view(g2).message));
const g3 = Core.createGame({ player: 'Quitter' }, env); Core.resign(g3, env);
check('resign', g3.status === 'resigned' && g3.score === 0 && Core.record(g3).won === false);
throws('resign twice rejected', () => Core.resign(g3, env), 'game_over');
const mk = Core.createGame({ player: 'Maker', mode: 'maker', secret: 'RGBY' }, env);
check('maker game solved by the solver', (mk.status === 'solved') && mk.solver.steps <= 5 && mk.score === mk.solver.steps && Core.view(mk).solver.points === mk.score, mk.solver);
throws('maker needs a secret', () => Core.createGame({ mode: 'maker' }, env), 'missing_secret');
throws('bad mode rejected', () => Core.createGame({ mode: 'spectator' }, env), 'invalid_mode');
throws('guess on maker game rejected', () => Core.applyGuess(mk, 'RGBY', env), 'wrong_mode');
const board = Core.leaderboard([Core.record(g), Core.record(g2), Core.record(g3), Core.record(mk)], { limit: 10 });
check('leaderboard top has the winner', board.top_scores.length === 1 && board.top_scores[0].player === 'Claude' && board.top_scores[0].rank === 1);
check('leaderboard totals', board.totals.games === 4 && board.totals.wins === 1 && board.totals.losses === 1 && board.totals.resigned === 1 && board.totals.maker_games === 1);
check('leaderboard players sorted', board.players[0].player === 'Claude' && board.players.length === 4 && board.players[0].win_rate === 100);
check('codemakers listed', board.codemakers.length === 1 && board.codemakers[0].points === mk.score);
const mine = Core.leaderboard([Core.record(g), Core.record(g2)], { player: 'claude' });
check('player filter', mine.player.player === 'Claude' && mine.player_games.length === 1);
check('archived view', Core.viewFromRecord(rec).archived === true && Core.viewFromRecord(rec).status === 'won');
check('rules text mentions scoring', /Scoring/.test(Core.rulesText()) && /1122|RRGG/.test(Core.rulesText()));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
