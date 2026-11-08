#!/usr/bin/env node
/* ============================================================================
   tools/play-demo.js — an agent that plays Mastermind through the MCP
   endpoint exactly the way Claude does: initialize, rules, new_game, then
   guess until the game ends, choosing guesses with the consistent-set /
   minimax strategy. Prints the transcript and the scoreboard rank.

   usage: node tools/play-demo.js [--url=http://localhost:8772/mcp] [--player=Demo]
                                  [--preset=classic] [--games=1] [--api-key=…] [--mode=maker --secret=RGBY]
   ========================================================================== */
'use strict';
const path = require('path');
const { McpClient } = require('./mcp-client.js');
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
const { parseArgs } = require(path.join(__dirname, '..', 'server', 'server.js'));

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = a.url || process.env.MASTERMIND_URL || 'http://localhost:8772/mcp';
  const client = new McpClient(url, { apiKey: a['api-key'] || process.env.MASTERMIND_API_KEY || '' });
  const init = await client.initialize({ name: 'mastermind-play-demo', version: '1.0.0' });
  console.log('connected to ' + init.serverInfo.name + ' ' + init.serverInfo.version + ' (protocol ' + init.protocolVersion + ')');
  const tools = await client.listTools();
  console.log('tools: ' + tools.map(t => t.name).join(', '));
  const games = parseInt(a.games || '1', 10), player = a.player || 'Demo agent';
  for (let n = 0; n < games; n++) {
    const args = { player: player };
    if (a.preset) args.preset = a.preset;
    if (a.mode) args.mode = a.mode;
    if (a.secret) args.secret = a.secret;
    let g = await client.call('new_game', args);
    console.log('\n[' + g.game_id + '] ' + g.mode + ' · ' + g.config.preset + ' · ' + g.config.pegs + ' pegs × ' + g.config.colors + ' colours · ' + g.config.max_guesses + ' guesses');
    if (g.mode === 'maker') { g.history.forEach(h => console.log('  solver ' + h.turn + ': ' + h.letters + '  →  ' + h.black + ' black, ' + h.white + ' white')); console.log('  ' + g.message); continue; }
    const cfg = Engine.normalizeConfig(g.config);
    const solver = Engine.spaceSize(cfg) <= Engine.MAX_ENUM ? Engine.solverFor(cfg) : null;
    const history = [];
    while (g.status === 'playing') {
      const guess = solver ? solver.next(history) : Engine.randomCode(cfg);
      g = await client.call('guess', { game_id: g.game_id, guess: Engine.codeLetters(guess) });
      const last = g.history[g.history.length - 1];
      history.push({ guess: guess, black: last.black, white: last.white });
      console.log('  guess ' + last.turn + ': ' + last.letters.padEnd(cfg.pegs + 1) + ' → ' + last.black + ' black, ' + last.white + ' white' + (solver && g.status === 'playing' ? '   (' + solver.consistent(history).length + ' codes left)' : ''));
    }
    console.log('  ' + g.message + '  secret ' + g.secret.letters + '  score ' + g.score);
  }
  const board = await client.call('get_scores', { player: player, limit: 5 });
  console.log('\nscoreboard: ' + board.totals.games + ' games recorded; ' + player + ': ' + board.player.wins + ' wins, best score ' + board.player.best_score);
  board.top_scores.forEach(r => console.log('  #' + r.rank + ' ' + r.player.padEnd(16) + ' ' + String(r.score).padStart(5) + '  ' + r.guesses_used + ' guesses  ' + r.preset));
}
main().catch(e => { console.error('demo failed: ' + (e.message || e)); process.exit(1); });
