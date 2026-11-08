#!/usr/bin/env node
/* ============================================================================
   tools/test-api.js — end-to-end tests of the HTTP server: REST routes, the
   MCP Streamable HTTP endpoint (initialize, tools, resources, prompts, batch,
   errors, origin and auth checks, SSE), a full game played by a simulated
   agent through MCP, the scoreboard, and the stdio bridge in both modes.
   Starts the server on a random port with an in-memory store.
   ========================================================================== */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { createApp } = require(path.join(__dirname, '..', 'server', 'server.js'));
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
const { McpClient } = require('./mcp-client.js');

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : '')); } }
async function http(base, method, p, body, headers) {
  const r = await fetch(base + p, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: r.status, headers: r.headers, json: json, text: text };
}
function stdioSession(args, lines, ms) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'mcp-stdio.js')].concat(args), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    const finish = () => { try { proc.kill(); } catch (e) { /* gone */ } const msgs = out.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return { parseError: l }; } }); resolve({ msgs: msgs, err: err }); };
    const timer = setTimeout(finish, ms);
    proc.on('exit', () => { clearTimeout(timer); finish(); });
    setTimeout(() => { lines.forEach(l => proc.stdin.write(JSON.stringify(l) + '\n')); }, 300);
    setTimeout(() => { let n = 0; const t = setInterval(() => { const got = out.split('\n').filter(Boolean).length; if (got >= lines.filter(l => l.id !== undefined).length || n++ > 80) { clearInterval(t); clearTimeout(timer); finish(); } }, 100); }, 800);
  });
}

async function main() {
  const app = createApp({ port: 0, host: '127.0.0.1', dataFile: null, quiet: true });
  const addr = await app.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  console.log('server on ' + base);
  try {
    /* ------------------------------------------------------------ REST */
    let r = await http(base, 'GET', '/api/health');
    check('health', r.status === 200 && r.json.ok === true && r.json.name === 'mastermind');
    r = await http(base, 'GET', '/api/rules');
    check('rules', r.status === 200 && /# Mastermind/.test(r.json.text) && r.json.presets.classic.code_space === 1296);
    r = await http(base, 'GET', '/api/tools');
    check('tool catalog', r.status === 200 && r.json.tools.length === 8 && r.json.server.mcp_endpoint.endsWith('/mcp') && r.json.tools.every(t => t.inputSchema && t.description));
    r = await http(base, 'GET', '/api/openapi.json');
    check('openapi', r.status === 200 && r.json.openapi === '3.1.0' && r.json.paths['/api/games/{game_id}/guess'].post && r.json.paths['/api/games'].get.parameters.some(p => p.name === 'player'));
    r = await http(base, 'GET', '/api');
    check('api index lists endpoints', r.status === 200 && r.json.endpoints.some(e => /POST .*\/api\/games\/\{game_id\}\/guess/.test(e)));
    r = await http(base, 'POST', '/api/games', { player: 'Tester' });
    check('new game 201', r.status === 201 && r.json.status === 'playing' && r.json.secret === undefined && r.json.guesses_left === 10 && r.json.palette.length === 6, r.json);
    const id = r.json.game_id;
    r = await http(base, 'POST', '/api/games/' + id + '/guess', { guess: 'RGB' });
    check('invalid guess 400', r.status === 400 && r.json.error.code === 'invalid_guess', r.json);
    r = await http(base, 'POST', '/api/games/' + id + '/guess', { guess: 'RGBZ' });
    check('invalid colour 400', r.status === 400 && r.json.error.code === 'invalid_colour' && /red \(R\)/.test(r.json.error.message), r.json);
    r = await http(base, 'POST', '/api/games/' + id + '/guess', { guess: 'RRGG' });
    check('guess accepted', r.status === 200 && typeof r.json.feedback.black === 'number' && r.json.history.length === 1 && r.json.history[0].letters === 'RRGG' && r.json.guesses_left === 9, r.json);
    r = await http(base, 'POST', '/api/games/' + id + '/guess', { guess: ['blue', 'blue', 'yellow', 'yellow'] });
    check('guess as names', r.status === 200 && r.json.history.length === 2 && r.json.history[1].letters === 'BBYY');
    r = await http(base, 'GET', '/api/games/' + id);
    check('get game', r.status === 200 && r.json.history.length === 2 && r.json.secret === undefined);
    r = await http(base, 'GET', '/api/games?player=tester');
    check('list games by player', r.status === 200 && r.json.count === 1 && r.json.games[0].game_id === id);
    r = await http(base, 'POST', '/api/games/' + id + '/hint');
    check('hint', r.status === 200 && r.json.remaining_codes > 0 && r.json.suggestion.letters.length === 4 && r.json.hints_used === 1, r.json);
    /* play it out with the solver, feeding the server's feedback */
    const live = app.service.store.getGame(id);
    const solver = Engine.solverFor(live.config);
    let state = (await http(base, 'GET', '/api/games/' + id)).json;
    const hist = live.history.map(h => ({ guess: h.guess, black: h.black, white: h.white }));
    let guard = 0;
    while (state.status === 'playing' && guard++ < 12) {
      const g = solver.next(hist);
      state = (await http(base, 'POST', '/api/games/' + id + '/guess', { guess: g })).json;
      const last = state.history[state.history.length - 1];
      hist.push({ guess: g, black: last.black, white: last.white });
    }
    check('solver wins through REST', state.status === 'won' && state.secret && state.secret.letters.length === 4 && state.score > 0 && state.finished === true, { status: state.status, used: state.guesses_used });
    const expected = Engine.score(live.config, { won: true, guessesUsed: state.guesses_used, hints: 1 });
    check('score matches the formula (hint counted)', state.score === expected, [state.score, expected]);
    r = await http(base, 'POST', '/api/games/' + id + '/guess', { guess: 'RRGG' });
    check('guess after win 409', r.status === 409 && r.json.error.code === 'game_over');
    r = await http(base, 'GET', '/api/scores?player=Tester');
    check('scores', r.status === 200 && r.json.player.wins === 1 && r.json.top_scores[0].player === 'Tester' && r.json.player_games[0].game_id === id && r.json.totals.games === 1, r.json.totals);
    r = await http(base, 'GET', '/api/games/doesnotexist');
    check('unknown game 404', r.status === 404 && r.json.error.code === 'not_found');
    r = await http(base, 'POST', '/api/games', { preset: 'bogus' });
    check('bad preset 400', r.status === 400 && r.json.error.code === 'invalid_argument', r.json);
    r = await http(base, 'POST', '/api/games', { pegs: 11 });
    check('pegs out of range 400', r.status === 400 && /pegs/.test(r.json.error.message));
    r = await http(base, 'POST', '/api/games', { colour: 'red' });
    check('unknown argument 400', r.status === 400 && r.json.error.code === 'unknown_argument');
    r = await http(base, 'POST', '/api/games', '{not json');
    check('invalid json 400', r.status === 400 && r.json.error.code === 'invalid_json');
    r = await http(base, 'POST', '/api/games', { player: 'Maker', mode: 'maker', secret: 'RGBY' });
    check('maker game solved', r.status === 201 && r.json.status === 'solved' && r.json.solver.guesses <= 5 && r.json.secret.letters === 'RGBY' && r.json.history.length === r.json.solver.guesses, r.json);
    r = await http(base, 'POST', '/api/games', { mode: 'maker' });
    check('maker without secret 400', r.status === 400 && r.json.error.code === 'missing_secret');
    r = await http(base, 'POST', '/api/games', { player: 'Quitter', preset: 'super' });
    const qid = r.json.game_id;
    check('super preset', r.status === 201 && r.json.config.pegs === 5 && r.json.config.colors === 8 && r.json.palette.length === 8);
    r = await http(base, 'POST', '/api/games/' + qid + '/resign');
    check('resign', r.status === 200 && r.json.status === 'resigned' && r.json.score === 0 && r.json.secret.letters.length === 5);
    r = await http(base, 'POST', '/api/games', { player: 'Quitter' });
    r = await http(base, 'DELETE', '/api/games/' + r.json.game_id);
    check('DELETE resigns', r.status === 200 && r.json.status === 'resigned');
    r = await http(base, 'GET', '/api/games?status=all&limit=2');
    check('list all with limit', r.status === 200 && r.json.games.length === 2 && r.json.count >= 4);
    r = await http(base, 'PUT', '/api/games');
    check('405 on wrong method', r.status === 405 && /POST/.test(r.headers.get('allow')));
    r = await http(base, 'GET', '/api/nothing');
    check('404 on unknown endpoint', r.status === 404);
    r = await http(base, 'OPTIONS', '/api/games');
    check('CORS preflight', r.status === 204 && r.headers.get('access-control-allow-origin') === '*');
    r = await http(base, 'GET', '/js/engine.js');
    check('static file served', r.status === 200 && /text\/javascript/.test(r.headers.get('content-type')) && /MASTERMIND/.test(r.text));
    r = await http(base, 'GET', '/server/service.js');
    check('server sources hidden', r.status === 404);
    r = await http(base, 'GET', '/..%2fpackage.json');
    check('traversal blocked', r.status === 404);
    r = await http(base, 'GET', '/package.json');
    check('package.json hidden', r.status === 404);

    /* ------------------------------------------------------------- MCP */
    const c = new McpClient(base + '/mcp');
    const init = await c.initialize();
    check('mcp initialize', init.protocolVersion === '2025-06-18' && init.serverInfo.name === 'mastermind' && init.capabilities.tools && typeof init.instructions === 'string', init);
    const old = new McpClient(base + '/mcp', { protocolVersion: '2024-11-05' });
    check('mcp old protocol echoed', (await old.initialize()).protocolVersion === '2024-11-05');
    const unknownV = new McpClient(base + '/mcp', { protocolVersion: '1999-01-01' });
    check('mcp unknown protocol → latest', (await unknownV.initialize()).protocolVersion === '2025-06-18');
    let raw = await c.notify('notifications/initialized');
    check('notification → 202', raw.status === 202);
    check('ping', JSON.stringify(await c.rpc('ping')) === '{}');
    const tools = await c.listTools();
    check('tools/list', tools.length === 8 && tools.map(t => t.name).join() === 'rules,new_game,guess,get_game,list_games,hint,resign,get_scores' && tools.every(t => t.inputSchema.type === 'object' && t.annotations), tools.map(t => t.name));
    const rulesCall = await c.rpc('tools/call', { name: 'rules', arguments: {} });
    check('tools/call rules returns markdown text + structured', /# Mastermind/.test(rulesCall.content[0].text) && rulesCall.structuredContent.presets.classic && rulesCall.isError === false);
    let g = await c.call('new_game', { player: 'Claude', preset: 'classic' });
    check('tools/call new_game', typeof g.game_id === 'string' && g.status === 'playing' && /Guess 1 of 10/.test(g.message), g);
    const cfg = Engine.normalizeConfig(g.config);
    const s2 = Engine.solverFor(cfg), h2 = [];
    let turns = 0;
    while (g.status === 'playing' && turns++ < 12) {
      const guess = s2.next(h2);
      g = await c.call('guess', { game_id: g.game_id, guess: Engine.codeNames(guess) });
      const last = g.history[g.history.length - 1];
      h2.push({ guess: guess, black: last.black, white: last.white });
    }
    check('agent wins through MCP in ≤5', g.status === 'won' && g.guesses_used <= 5 && g.secret.letters.length === 4 && g.score >= 600, { status: g.status, used: g.guesses_used, score: g.score });
    let toolErr = null;
    try { await c.call('guess', { game_id: g.game_id, guess: 'RRGG' }); } catch (e) { toolErr = e; }
    check('tool error is isError content (game_over)', toolErr && toolErr.toolError && /game_over/.test(toolErr.message), toolErr && toolErr.message);
    toolErr = null;
    try { await c.call('guess', { game_id: 'nope', guess: 'RRGG' }); } catch (e) { toolErr = e; }
    check('tool error for unknown game', toolErr && toolErr.toolError && /not_found/.test(toolErr.message));
    toolErr = null;
    try { await c.call('new_game', { player: 'x', pegs: 'four' }); } catch (e) { toolErr = e; }
    check('tool argument validation', toolErr && toolErr.toolError && /pegs/.test(toolErr.message), toolErr && toolErr.message);
    let rpcE = null;
    try { await c.rpc('tools/call', { name: 'teleport', arguments: {} }); } catch (e) { rpcE = e; }
    check('unknown tool → -32602', rpcE && rpcE.code === -32602);
    rpcE = null;
    try { await c.rpc('nonsense/method'); } catch (e) { rpcE = e; }
    check('unknown method → -32601', rpcE && rpcE.code === -32601);
    const got = await c.call('get_game', { game_id: g.game_id });
    check('get_game via MCP', got.game_id === g.game_id && got.status === 'won' && got.secret.letters === g.secret.letters);
    const hintG = await c.call('new_game', { player: 'Claude' });
    const hint = await c.call('hint', { game_id: hintG.game_id });
    check('hint via MCP', hint.remaining_codes === 1296 && hint.suggestion.letters === 'RROO', hint);
    const resigned = await c.call('resign', { game_id: hintG.game_id });
    check('resign via MCP', resigned.status === 'resigned' && resigned.secret.letters.length === 4);
    const listed = await c.call('list_games', { player: 'Claude', status: 'all' });
    check('list_games via MCP', listed.count === 2 && listed.games[0].player === 'Claude');
    const board = await c.call('get_scores', { player: 'Claude' });
    check('get_scores via MCP', board.player.wins === 1 && board.player.resigned === 1 && board.top_scores.length >= 2 && board.top_scores[0].rank === 1, board.player);
    const maker = await c.call('new_game', { player: 'Claude', mode: 'maker', secret: [1, 1, 2, 2] });
    check('maker via MCP', maker.status === 'solved' && maker.solver.points >= 1 && maker.history[0].letters === 'RROO');
    const res = await c.rpc('resources/list');
    check('resources/list', res.resources.length === 2 && res.resources[0].uri === 'mastermind://rules');
    const tpl = await c.rpc('resources/templates/list');
    check('resources/templates/list', tpl.resourceTemplates.length === 1 && /\{game_id\}/.test(tpl.resourceTemplates[0].uriTemplate));
    const rr = await c.rpc('resources/read', { uri: 'mastermind://rules' });
    check('resources/read rules', rr.contents[0].mimeType === 'text/markdown' && /Scoring/.test(rr.contents[0].text));
    const rg = await c.rpc('resources/read', { uri: 'mastermind://games/' + g.game_id });
    check('resources/read game', JSON.parse(rg.contents[0].text).game_id === g.game_id);
    const rs = await c.rpc('resources/read', { uri: 'mastermind://scores' });
    check('resources/read scores', JSON.parse(rs.contents[0].text).totals.games >= 3);
    rpcE = null;
    try { await c.rpc('resources/read', { uri: 'mastermind://games/zzz' }); } catch (e) { rpcE = e; }
    check('resources/read unknown game → -32002', rpcE && rpcE.code === -32002);
    const pl = await c.rpc('prompts/list');
    check('prompts/list', pl.prompts.length === 2 && pl.prompts[0].name === 'play');
    const pg = await c.rpc('prompts/get', { name: 'play', arguments: { player: 'Claude', preset: 'super' } });
    check('prompts/get', pg.messages[0].role === 'user' && /player="Claude"/.test(pg.messages[0].content.text) && /preset="super"/.test(pg.messages[0].content.text));
    raw = await c.raw([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    check('batch request', raw.status === 200 && Array.isArray(raw.body) && raw.body.length === 2 && raw.body[1].id === 'b', raw.body);
    raw = await c.raw('{bad json');
    check('parse error → -32700', raw.status === 400 && raw.body.error.code === -32700);
    raw = await c.raw({ id: 1, method: 'ping' });
    check('missing jsonrpc → -32600', raw.body.error && raw.body.error.code === -32600);
    raw = await c.raw({ jsonrpc: '2.0', id: 9, method: 'ping' }, { Accept: 'text/event-stream' });
    check('SSE response when only event-stream accepted', raw.status === 200 && raw.body && raw.body.id === 9, raw.body);
    r = await http(base, 'GET', '/mcp');
    check('GET /mcp → 405', r.status === 405 && /POST/.test(r.headers.get('allow')));
    r = await http(base, 'DELETE', '/mcp');
    check('DELETE /mcp → 200', r.status === 200);
    raw = await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://evil.example' });
    check('foreign Origin → 403', raw.status === 403);
    raw = await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://localhost:6274' });
    check('localhost Origin allowed', raw.status === 200 && raw.body.result);
    raw = await c.raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'http://127.0.0.1:' + addr.port });
    check('same-host Origin allowed', raw.status === 200);

    /* ---------------------------------------------------- stdio bridge */
    const bridge = await stdioSession(['--url=' + base + '/mcp'], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_scores', arguments: { limit: 3 } } }
    ], 15000);
    const byId = id => bridge.msgs.find(m => m.id === id);
    check('stdio bridge initialize', byId(1) && byId(1).result && byId(1).result.serverInfo.name === 'mastermind', bridge.err.slice(0, 300));
    check('stdio bridge tools/list', byId(2) && byId(2).result.tools.length === 8);
    check('stdio bridge shares the server scoreboard', byId(3) && byId(3).result.structuredContent.totals.games >= 3, byId(3));
    const tmpData = path.join(os.tmpdir(), 'mm-stdio-' + process.pid + '.json');
    const local = await stdioSession(['--local', '--data=' + tmpData], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'new_game', arguments: { player: 'Local' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_games', arguments: {} } }
    ], 15000);
    const lid = id => local.msgs.find(m => m.id === id);
    check('stdio local initialize', lid(1) && lid(1).result.protocolVersion === '2025-03-26', local.err.slice(0, 300));
    check('stdio local new_game', lid(2) && lid(2).result.structuredContent.game_id && lid(2).result.structuredContent.status === 'playing');
    check('stdio local list_games', lid(3) && lid(3).result.structuredContent.count === 1);
    fs.rmSync(tmpData, { force: true });

    /* ------------------------------------------------ API key + limits */
    const secure = createApp({ port: 0, host: '127.0.0.1', dataFile: null, quiet: true, apiKey: 'top-secret', rateLimit: { capacity: 6, perSecond: 0.0001 } });
    const saddr = await secure.listen(); const sbase = 'http://127.0.0.1:' + saddr.port;
    try {
      r = await http(sbase, 'POST', '/api/games', { player: 'x' });
      check('api key required', r.status === 401 && /bearer/i.test(r.headers.get('www-authenticate')));
      r = await http(sbase, 'GET', '/api/scores');
      check('scores stay public', r.status === 200);
      r = await http(sbase, 'POST', '/api/games', { player: 'x' }, { Authorization: 'Bearer top-secret' });
      check('api key accepted', r.status === 201);
      const sc = new McpClient(sbase + '/mcp');
      raw = await sc.raw({ jsonrpc: '2.0', id: 1, method: 'ping' });
      check('mcp requires key', raw.status === 401);
      const sc2 = new McpClient(sbase + '/mcp', { apiKey: 'top-secret' });
      raw = await sc2.raw({ jsonrpc: '2.0', id: 1, method: 'ping' });
      check('mcp with key', raw.status === 200);
      r = await http(sbase, 'GET', '/api/health');
      r = await http(sbase, 'GET', '/api/health');
      check('rate limit kicks in', r.status === 429 && r.headers.get('retry-after') === '5', r.status);
    } finally { await secure.close(); }
  } finally { await app.close(); }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
