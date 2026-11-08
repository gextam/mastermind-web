#!/usr/bin/env node
/* ============================================================================
   tools/screenshots.mjs — headless smoke test + documentation screenshots.
   Starts the real game server in-process (temporary data file), opens the
   game muted in headless Chrome, and drives whole games through the UI
   layer: a codebreaker win with a hint, a codemaker game solved by the
   server, a loss on the mini board, the offline fallback. Asserts states and
   the server-side bookkeeping, fails on any page error, writes
   docs/screenshots/*.jpg.
   usage: node tools/screenshots.mjs [--chrome=<path>] [--width=1600] [--height=900]
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launch, wait } from './headless.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const { createApp } = require(path.join(ROOT, 'server', 'server.js'));
const Engine = require(path.join(ROOT, 'js', 'engine.js'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const W = parseInt(args.width || '1600', 10), H = parseInt(args.height || '900', 10), QUALITY = 86;

let app, page, failed = 0;
const errors = [];
function liveGame(player) { return app.service.store.listGames().find(x => x.player === player && x.status === 'playing') || null; }
async function shot(name) {
  await page.eval('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
  await fs.writeFile(path.join(OUT, name + '.jpg'), Buffer.from(data, 'base64'));
}
async function scene(name, code, check) {
  let out, ok = true, parsed = null;
  try { out = await page.eval('(async () => { ' + code + ' })()'); } catch (e) { out = 'ERROR ' + e.message; ok = false; }
  if (name) await shot(name);
  if (check && ok) { try { parsed = typeof out === 'string' ? JSON.parse(out) : out; ok = !!check(parsed); } catch (e) { ok = false; } }
  if (!ok) failed++;
  console.log((check || !ok ? (ok ? 'PASS ' : 'FAIL ') : '     ') + (name || '(step)').padEnd(10) + ' ' + (typeof out === 'string' ? out : JSON.stringify(out)));
  return parsed;
}
async function waitFor(expr, ms = 10000) { return page.eval(`new Promise(r => { const t0 = Date.now(); const t = setInterval(() => { let v = false; try { v = ${expr}; } catch (e) {} if (v || Date.now() - t0 > ${ms}) { clearInterval(t); r(!!v); } }, 60); })`); }

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const dataFile = path.join(os.tmpdir(), 'mm-smoke-' + process.pid + '.json');
  app = createApp({ port: 0, host: '127.0.0.1', dataFile, quiet: true });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const browser = await launch({ width: W, height: H, prefix: 'mm-shots-', chrome: args.chrome });
  page = browser.page;
  page.on(msg => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console: ' + msg.params.args.map(a => a.value || a.description).join(' '));
  });
  console.log('server  :', base); console.log('browser :', browser.chrome);
  let heroSource = 'feedback';
  try {
    await browser.goto(base + '/index.html?mute=1&player=Smoke');
    if (!await waitFor('window.MM && MM.loaded', 30000)) throw new Error('game did not finish loading');
    await wait(300);
    await scene('splash', `return JSON.stringify({ online: MM.client.online, loaded: MM.loaded })`, r => r.online === true && r.loaded);
    await scene('setup', `MM.ui.start(); MM.step(0.05); await new Promise(r => setTimeout(r, 200)); return JSON.stringify({ dialog: !document.getElementById('setup').classList.contains('hidden'), ready: MM.ui.ready })`, r => r.dialog && r.ready);

    /* ---- codebreaker: classic game, opening guess, hint, a consistent third guess, the win */
    await scene('board', `MM.ui.closeSetup(); const v = await MM.game.start({ mode: 'breaker', config: { preset: 'classic' } }); MM.step(0.4);
      return JSON.stringify({ state: MM.game.state, left: v.guesses_left, player: v.player, pegs: MM.game.cfg.pegs, rows: MM.game.rows.length, msg: document.getElementById('message').textContent })`,
    r => r.state === 'playing' && r.left === 10 && r.player === 'Smoke' && r.pegs === 4 && r.rows === 0 && /Guess 1 of 10/.test(r.msg));
    const live = liveGame('Smoke');
    if (!live) throw new Error('server has no live game for Smoke');
    const secret = live.secret.slice(), cfg = live.config, solver = Engine.solverFor(cfg);
    const expected = Engine.feedback(secret, [1, 1, 2, 2]);
    await scene('placing', `const g = MM.game; g.select(1); g.fillNext(1); g.fillNext(1); g.select(2); g.fillNext(2); MM.step(0.15);
      return JSON.stringify({ current: g.current, order: g.order, selected: g.selected })`, r => JSON.stringify(r.current) === '[1,1,2,null]' && r.selected === 2);
    await scene('feedback', `const g = MM.game; g.place(3, 2); MM.step(0.5); const v = await g.submit(); MM.step(1.6);
      return JSON.stringify({ state: g.state, rows: g.rows.length, black: g.rows[0].black, white: g.rows[0].white, status: v.status, left: v.guesses_left, msg: document.getElementById('message').textContent })`,
    r => r.rows === 1 && r.black === expected.black && r.white === expected.white && r.left === 9 && (r.state === 'playing' || r.state === 'anim'));
    await scene('hint', `const g = MM.game; MM.step(1.0); const h = await g.hint(); MM.step(0.6);
      return JSON.stringify({ state: g.state, remaining: h.remaining_codes, suggestion: h.suggestion.letters, filled: g.current.every(c => c != null), hints: g.view.hints_used })`,
    r => r.state === 'playing' && r.remaining > 0 && r.remaining <= 1296 && r.filled && r.hints === 1);
    await scene(null, `const g = MM.game; const v = await g.submit(); MM.step(2.2); return JSON.stringify({ state: g.state, rows: g.rows.length, status: v.status })`, r => r.rows === 2 && (r.status === 'playing' || r.status === 'won'));
    let used = 2;
    if (live.status === 'playing') {
      const hist = live.history.map(h => ({ guess: h.guess, black: h.black, white: h.white }));
      const e = Engine.enumerate(cfg);
      const third = solver.consistent(hist).map(i => { const c = []; for (let k = 0; k < cfg.pegs; k++) c.push(e.data[i * cfg.pegs + k]); return c; }).find(c => c.join() !== secret.join());
      if (third) {
        await scene('midgame', `const g = MM.game; ${JSON.stringify(third)}.forEach((c, i) => g.place(i, c)); MM.step(0.5); const v = await g.submit(); MM.step(1.8);
          return JSON.stringify({ state: g.state, rows: g.rows.length, status: v.status, left: v.guesses_left })`, r => r.rows === 3 && r.status === 'playing' && r.left === 7);
        heroSource = 'midgame'; used = 3;
      }
    }
    if (live.status === 'playing') {
      used += 1;
      await scene('win', `const g = MM.game; MM.step(1.0); g.clearRow(); ${JSON.stringify(secret)}.forEach((c, i) => g.place(i, c)); MM.step(0.5); const v = await g.submit(); MM.step(3.4);
        return JSON.stringify({ state: g.state, status: v.status, used: v.guesses_used, hints: v.hints_used, score: v.score, secret: v.secret.letters, banner: !document.getElementById('banner').classList.contains('hidden'), fx: g.fx.length, shield: g.anim.shield && g.anim.shield.open })`,
      r => r.state === 'over' && r.status === 'won' && r.used === used && r.hints === 1 && r.score === Engine.score(cfg, { won: true, guessesUsed: used, hints: 1 }) && r.secret === Engine.codeLetters(secret) && r.banner && r.shield);
    } else { console.log('     (the hint happened to be the code: win reached early)'); await scene('win', `MM.step(3.4); return JSON.stringify({ state: MM.game.state })`, r => r.state === 'over'); }
    await scene(null, `await new Promise(r => setTimeout(r, 400)); const s = MM.ui.scores; return JSON.stringify({ top: s && s.top_scores.length, first: s && s.top_scores[0] && s.top_scores[0].player, mine: s && s.player && s.player.wins })`, r => r.top >= 1 && r.first === 'Smoke' && r.mine === 1);
    await scene('scoreboard', `MM.ui.hideBanner(); MM.ui.tab = 'players'; MM.ui.renderScores(); MM.step(2.5); return JSON.stringify({ rows: document.querySelectorAll('#board-body tr').length })`, r => r.rows >= 2);

    /* ---- codemaker: the player sets a code, the server's solver breaks it */
    await scene('entry', `MM.ui.tab = 'top'; MM.ui.renderScores(); const g = MM.game; await g.start({ mode: 'maker', config: { preset: 'classic' } }); MM.step(0.2); [3, 5, 5, 1].forEach((c, i) => g.place(i, c)); MM.step(0.6);
      return JSON.stringify({ state: g.state, current: g.current, label: document.getElementById('btn-check').textContent })`, r => r.state === 'entry' && JSON.stringify(r.current) === '[3,5,5,1]' && r.label === 'LOCK CODE');
    await scene('solving', `const g = MM.game; const v = await g.lockCode(); MM.step(1.2 + 1.35 * 2 + 0.4);
      return JSON.stringify({ state: g.state, status: v.status, solverGuesses: v.solver.guesses, shown: g.rows.length, secret: v.secret.letters })`, r => r.state === 'solving' && r.status === 'solved' && r.solverGuesses <= 5 && r.shown >= 2 && r.secret === 'YBBR');
    await scene('solved', `const g = MM.game; MM.step(12); return JSON.stringify({ state: g.state, rows: g.rows.length, points: g.view.solver.points, banner: !document.getElementById('banner').classList.contains('hidden'), title: document.getElementById('banner-title').textContent })`,
      r => r.state === 'over' && r.rows === r.points && r.banner && /SOLVED/.test(r.title));

    /* ---- a loss on the mini board */
    await scene(null, `MM.ui.hideBanner(); const g = MM.game; const v = await g.start({ mode: 'breaker', config: { preset: 'mini' } }); MM.step(0.3); return JSON.stringify({ state: g.state, pegs: g.cfg.pegs, max: g.cfg.maxGuesses })`, r => r.state === 'playing' && r.pegs === 3 && r.max === 8);
    const mini = liveGame('Smoke');
    const wrong = mini.secret.map(c => (c % 6) + 1);
    await scene('lost', `const g = MM.game; for (let i = 0; i < 8; i++) { ${JSON.stringify(wrong)}.forEach((c, k) => g.place(k, c)); MM.step(0.2); await g.submit(); MM.step(2.6); } MM.step(2.5);
      return JSON.stringify({ state: g.state, status: g.view.status, rows: g.rows.length, score: g.view.score, banner: document.getElementById('banner-title').textContent })`,
    r => r.state === 'over' && r.status === 'lost' && r.rows === 8 && r.score === 0 && /OUT OF GUESSES/.test(r.banner));
    await scene('help', `MM.ui.hideBanner(); MM.ui.toggleHelp(true); return 'ok'`);
    await scene(null, `MM.ui.toggleHelp(false); return 'ok'`);

    /* server-side bookkeeping */
    const board = app.service.scores({ player: 'Smoke' });
    const okBoard = board.totals.games === 3 && board.player.wins === 1 && board.player.losses === 1 && board.totals.maker_games === 1 && board.codemakers[0].secret === 'YBBR' && board.player.best_score === board.top_scores[0].score;
    if (!okBoard) failed++;
    console.log((okBoard ? 'PASS ' : 'FAIL ') + 'server     ' + JSON.stringify(board.totals) + ' best ' + board.player.best_score);

    /* ---- offline fallback: no server, in-browser game + local scores */
    await browser.goto(base + '/index.html?mute=1&local=1&player=Offline');
    if (!await waitFor('window.MM && MM.loaded', 30000)) throw new Error('offline page did not load');
    await scene('offline', `MM.ui.start(); MM.ui.closeSetup(); const g = MM.game; await g.start({ mode: 'breaker', config: { preset: 'classic' } }); MM.step(0.3);
      const secret = MM.client.local.games.get(g.view.game_id).secret; secret.forEach((c, i) => g.place(i, c)); MM.step(0.3); const v = await g.submit(); MM.step(3.2); await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({ online: MM.client.online, badge: document.getElementById('online').textContent, status: v.status, score: v.score, stored: JSON.parse(localStorage.getItem('mastermind.records') || '[]').length, top: MM.ui.scores && MM.ui.scores.top_scores[0] && MM.ui.scores.top_scores[0].player })`,
    r => r.online === false && /OFFLINE/.test(r.badge) && r.status === 'won' && r.score === 1000 && r.stored === 1 && r.top === 'Offline');
    await fs.copyFile(path.join(OUT, heroSource + '.jpg'), path.join(OUT, 'hero.jpg'));
  } finally {
    await browser.close();
    await app.close();
    await fs.rm(dataFile, { force: true }); await fs.rm(dataFile + '.tmp', { force: true });
  }
  if (errors.length) { console.log('\nPAGE ERRORS:'); errors.forEach(e => console.log(' -', e)); }
  if (failed || errors.length) { console.log('\n' + failed + ' check(s) failed, ' + errors.length + ' page error(s)'); process.exitCode = 2; } else console.log('\nall checks passed, no page errors');
}
main().catch(err => { console.error(err.stack || err.message || err); process.exit(1); });
