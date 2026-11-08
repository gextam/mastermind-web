#!/usr/bin/env node
/* ============================================================================
   tools/gen-docs.mjs — generates docs/mcp.html (the MCP + REST documentation
   page) and docs/openapi.json from the live tool catalog, so the reference
   can never drift from the server. Example responses are produced by running
   the real service in memory with a seeded random generator.
   usage: node tools/gen-docs.mjs [--public-url=https://example.com/games/mastermind]
   ========================================================================== */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const PUBLIC = (args['public-url'] || 'http://localhost:8772').replace(/\/+$/, '');
const Engine = require(path.join(ROOT, 'js', 'engine.js'));
const Service = require(path.join(ROOT, 'server', 'service.js'));
const Store = require(path.join(ROOT, 'server', 'store.js'));
const { TOOLS, RESOURCES, RESOURCE_TEMPLATES, PROMPTS, openapi } = require(path.join(ROOT, 'server', 'tools.js'));
const { SUPPORTED } = require(path.join(ROOT, 'server', 'mcp.js'));
const pkg = require(path.join(ROOT, 'package.json'));

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const json = o => esc(JSON.stringify(o, null, 2));
const pre = (o, lang) => `<pre class="code${lang ? ' ' + lang : ''}"><code>${typeof o === 'string' ? esc(o) : json(o)}</code></pre>`;
const typeOf = s => Array.isArray(s.type) ? s.type.join(' | ') : (s.type || 'any');

/* ------------------------------------------------- example transcript */
function examples() {
  const svc = new Service({ store: new Store(null) });
  let clock = Date.UTC(2026, 10, 8, 12, 0, 0);
  svc.env = { rng: Engine.mulberry32(20261108), now: () => (clock += 4000) };
  const ex = {};
  ex.new_game = svc.newGame({ player: 'Claude', preset: 'classic' });
  const id = ex.new_game.game_id;
  ex.guess = svc.guess({ game_id: id, guess: ['red', 'red', 'orange', 'orange'] });
  ex.hint = svc.hint({ game_id: id });
  const g = svc.store.getGame(id), solver = Engine.solverFor(g.config);
  let last = null;
  while (g.status === 'playing') { const hist = g.history.map(h => ({ guess: h.guess, black: h.black, white: h.white })); last = svc.guess({ game_id: id, guess: Engine.codeLetters(solver.next(hist)) }); }
  ex.guess_final = last;
  ex.get_game = svc.getGame({ game_id: id });
  const r = svc.newGame({ player: 'Claude', preset: 'super' });
  ex.list_games = svc.listGames({ player: 'Claude' });
  ex.resign = svc.resign({ game_id: r.game_id });
  ex.maker = svc.newGame({ player: 'Claude', mode: 'maker', secret: 'RGBY' });
  svc.newGame({ player: 'Sophia', preset: 'classic' }); const s2 = svc.store.listGames().find(x => x.player === 'Sophia'); svc.guess({ game_id: s2.id, guess: Engine.codeLetters(s2.secret) });
  ex.get_scores = svc.scores({ player: 'Claude', limit: 5 });
  ex.rules = svc.rules();
  ex.error = { error: { status: 400, code: 'invalid_colour', message: '"Z" is not one of this game\'s colours: red (R), orange (O), yellow (Y), green (G), blue (B), purple (P)' } };
  return ex;
}

function argsTable(tool) {
  const props = tool.inputSchema.properties || {}, req = tool.inputSchema.required || [];
  const keys = Object.keys(props);
  if (!keys.length) return '<p class="muted">No arguments.</p>';
  return `<table class="args"><thead><tr><th>Argument</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>` +
    keys.map(k => { const s = props[k]; const extra = [s.enum ? 'one of ' + s.enum.map(e => '<code>' + esc(e) + '</code>').join(', ') : '', s.minimum != null ? 'min ' + s.minimum : '', s.maximum != null ? 'max ' + s.maximum : '', s.maxLength != null ? 'max length ' + s.maxLength : ''].filter(Boolean).join(' · '); return `<tr><td><code>${esc(k)}</code></td><td>${esc(typeOf(s))}</td><td>${req.includes(k) ? 'yes' : 'no'}</td><td>${esc(s.description || '')}${extra ? '<br><span class="muted">' + extra + '</span>' : ''}</td></tr>`; }).join('') + '</tbody></table>';
}
function restPath(t) { return t.rest.method + ' ' + t.rest.path; }
function curlFor(t, example) {
  const p = t.rest.path.replace(/\{(\w+)\}/g, (_, k) => example.arguments[k] || 'GAME_ID');
  const body = Object.assign({}, example.arguments); (t.rest.path.match(/\{(\w+)\}/g) || []).forEach(s => delete body[s.slice(1, -1)]);
  if (t.rest.method === 'GET') { const q = Object.keys(body).map(k => k + '=' + encodeURIComponent(body[k])).join('&'); return `curl ${PUBLIC}${p}${q ? '?' + q : ''}`; }
  return Object.keys(body).length ? `curl -X POST ${PUBLIC}${p} \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body)}'` : `curl -X POST ${PUBLIC}${p}`;
}

function page(ex) {
  const exampleFor = { rules: ex.rules, new_game: ex.new_game, guess: ex.guess, get_game: ex.get_game, list_games: ex.list_games, hint: ex.hint, resign: ex.resign, get_scores: ex.get_scores };
  const toolSections = TOOLS.map(t => {
    const argsEx = t.name === 'guess' ? { game_id: ex.new_game.game_id, guess: ['red', 'red', 'orange', 'orange'] } : t.name === 'get_game' || t.name === 'hint' ? { game_id: ex.new_game.game_id } : t.name === 'resign' ? { game_id: ex.resign.game_id } : t.example.arguments;
    let resp = exampleFor[t.name];
    if (t.name === 'rules') resp = Object.assign({}, resp, { text: resp.text.split('\n').slice(0, 3).join('\n') + '\n… (full markdown continues)' });
    return `<section class="tool" id="tool-${t.name}">
  <h3><code>${t.name}</code> <span class="rest">${esc(restPath(t))}</span>${t.annotations.readOnlyHint ? '<span class="pill">read-only</span>' : ''}${t.annotations.destructiveHint ? '<span class="pill warn">destructive</span>' : ''}</h3>
  <p>${esc(t.description)}</p>
  ${argsTable(t)}
  <div class="cols">
    <div><h4>MCP call</h4>${pre({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: argsEx } })}<h4>REST equivalent</h4>${pre(curlFor(t, { arguments: argsEx }), 'bash')}</div>
    <div><h4>Result (<code>structuredContent</code> / response body)</h4>${pre(resp)}</div>
  </div>
</section>`;
  }).join('\n');

  const presetRows = Object.keys(Engine.PRESETS).map(k => { const p = Engine.PRESETS[k]; return `<tr><td><code>${k}</code></td><td>${p.label}</td><td>${p.pegs}</td><td>${p.colors}${p.allowBlanks ? ' + empty' : ''}</td><td>${p.maxGuesses}</td><td>${p.allowDuplicates ? 'yes' : 'no'}</td><td>${Engine.spaceSize(p).toLocaleString('en-US')}</td></tr>`; }).join('');
  const paletteRow = Engine.PALETTE.map(c => `<span class="swatch" style="--c:${c.hex}"><i></i>${c.id} ${c.name} <b>${c.letter}</b></span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Mastermind MCP server &amp; API &mdash; let Claude play</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Documentation for the Mastermind game server: an MCP server (Streamable HTTP and stdio) and a REST API that let Claude and other agents start games, guess, ask for hints, resign and read the scoreboard.">
<style>
  :root { --gold: #e9c250; --paper: #f3e9c8; --muted: #b7a77a; --bg: #07060a; --panel: rgba(255,255,255,.03); --line: #3a3012; }
  * { box-sizing: border-box; }
  body { margin: 0; background: radial-gradient(ellipse at 50% 0%, #1f2a1c 0%, var(--bg) 60%); color: var(--paper); font-family: "Segoe UI", system-ui, sans-serif; line-height: 1.55; }
  a { color: var(--gold); }
  header { text-align: center; padding: 48px 20px 10px; }
  header img.logo { width: min(560px, 90vw); filter: drop-shadow(0 0 30px rgba(255,200,90,.35)); }
  header h1 { font-family: Georgia, serif; letter-spacing: 4px; font-size: 26px; margin: 18px 0 6px; color: var(--gold); text-transform: uppercase; }
  header p.tag { color: var(--muted); margin: 0 0 18px; }
  .badges span { display: inline-block; font-size: 12px; letter-spacing: 1px; padding: 4px 10px; border-radius: 6px; background: #15131c; border: 1px solid var(--line); margin: 3px; color: #ffe9a8; }
  nav.toc { max-width: 1100px; margin: 24px auto 0; padding: 14px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); font-size: 15px; display: flex; flex-wrap: wrap; gap: 6px 18px; justify-content: center; }
  main { max-width: 1100px; margin: 0 auto; padding: 10px 20px 80px; }
  h2 { font-family: Georgia, serif; color: var(--gold); letter-spacing: 3px; font-size: 24px; margin: 56px 0 18px; border-bottom: 1px solid var(--line); padding-bottom: 10px; }
  h3 { color: #ffe9a8; font-size: 19px; margin: 34px 0 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h4 { color: var(--muted); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; margin: 14px 0 6px; }
  code { background: #15131c; padding: 2px 6px; border-radius: 4px; color: #ffe9a8; font-family: Consolas, "SF Mono", Menlo, monospace; font-size: .92em; }
  pre.code { background: #0e0d14; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; overflow: auto; font-size: 13px; line-height: 1.45; max-height: 520px; }
  pre.code code { background: none; padding: 0; color: #e6d7b0; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; margin: 10px 0 14px; }
  td, th { border-bottom: 1px solid #2a2410; padding: 8px 10px; text-align: left; vertical-align: top; } th { color: var(--gold); font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card h3 { margin: 0 0 8px; font-size: 16px; } .card p { margin: 0; color: #d9ccaa; font-size: 14.5px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; } @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .rest { font-family: Consolas, monospace; font-size: 13px; color: var(--muted); font-weight: 400; }
  .pill { font-size: 11px; letter-spacing: 1px; padding: 2px 8px; border-radius: 10px; background: #10351c; color: #8df0a8; border: 1px solid #1f7a3a; font-weight: 600; } .pill.warn { background: #3a1a12; color: #ffb3a7; border-color: #7a3a2a; }
  .muted { color: var(--muted); }
  .tool { border-top: 1px dashed #2a2410; padding-top: 6px; }
  .steps li { margin: 8px 0; }
  .swatch { display: inline-flex; align-items: center; gap: 6px; margin: 4px 10px 4px 0; font-size: 14px; } .swatch i { width: 16px; height: 16px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff8, var(--c) 45%, #0008); border: 1px solid #0006; display: inline-block; } .swatch b { color: var(--gold); }
  .cta { display: inline-block; padding: 12px 26px; border-radius: 12px; font-weight: 800; letter-spacing: 2px; color: #2a1a00; text-decoration: none; background: linear-gradient(180deg, #fff3bd, #e9c250 35%, #b8860b 80%); box-shadow: 0 5px 0 #3a2a00, 0 12px 24px rgba(0,0,0,.6); margin: 6px 6px 6px 0; }
  .cta.ghost { background: #15131c; color: var(--gold); border: 1px solid var(--line); box-shadow: none; }
  footer { text-align: center; color: #7d6a3a; font-size: 13px; padding: 30px 20px 60px; }
  .seq { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; font-family: Consolas, monospace; font-size: 13.5px; color: #e6d7b0; white-space: pre; overflow: auto; }
</style>
</head>
<body>
<header>
  <a href="index.html"><img class="logo" src="../assets/logo.png" alt="MASTERMIND"></a>
  <h1>MCP server &amp; API</h1>
  <p class="tag">Let Claude sit down at the table: start games, guess, ask for hints, resign and read the scoreboard, remotely.</p>
  <div class="badges"><span>MCP ${SUPPORTED.join(' · ')}</span><span>Streamable HTTP + stdio</span><span>REST + OpenAPI 3.1</span><span>${TOOLS.length} tools · ${RESOURCES.length + RESOURCE_TEMPLATES.length} resources · ${PROMPTS.length} prompts</span><span>no dependencies</span><span>v${pkg.version}</span></div>
  <div><a class="cta" href="../index.html">PLAY IN THE BROWSER</a><a class="cta ghost" href="openapi.json">OPENAPI.JSON</a><a class="cta ghost" href="https://github.com/gextam/mastermind-web">SOURCE</a></div>
</header>
<nav class="toc">
  <a href="#overview">Overview</a><a href="#quickstart">Quick start</a><a href="#flow">A game, call by call</a><a href="#tools">Tools</a><a href="#resources">Resources &amp; prompts</a><a href="#rest">REST API</a><a href="#notation">Notation &amp; boards</a><a href="#scoring">Scoring</a><a href="#strategy">Playing well</a><a href="#server">Running a server</a><a href="#protocol">Protocol notes</a>
</nav>
<main>
  <h2 id="overview">Overview</h2>
  <p>The Mastermind server is one Node.js process with no dependencies. It serves the browser game, a REST API under <code>/api</code>, and an <strong>MCP server</strong> at <code>/mcp</code> using the Streamable HTTP transport, so any MCP client (Claude Code, Claude Desktop, claude.ai custom connectors, the MCP Inspector, your own agent) can connect over the network and play. A stdio bridge is included for clients that launch servers as local commands. Every player, human or agent, plays on the same scoreboard.</p>
  <div class="grid">
    <div class="card"><h3>Codebreaker</h3><p><code>new_game</code> hides a random code; the agent calls <code>guess</code> until the key pegs are all black or the guesses run out. Lower guess counts score higher.</p></div>
    <div class="card"><h3>Codemaker</h3><p><code>new_game</code> with <code>mode: "maker"</code> and a <code>secret</code>: the server's Knuth minimax solver breaks the code and the transcript comes back at once. Points = guesses the solver needed.</p></div>
    <div class="card"><h3>Scoreboard</h3><p><code>get_scores</code> returns top scores, codemakers, per-player statistics and recent games; pass <code>player</code> for one player's own record.</p></div>
    <div class="card"><h3>Same catalog everywhere</h3><p>The MCP tools and the REST routes are generated from one catalog with one validator: identical arguments, identical JSON, identical error codes.</p></div>
  </div>

  <h2 id="quickstart">Quick start</h2>
  <h3>1. Run the server</h3>
  ${pre(`git clone https://github.com/gextam/mastermind-web.git\ncd mastermind-web\nnode server/server.js            # game http://localhost:8772/  ·  MCP http://localhost:8772/mcp\n\n# or, on Windows, double-click start.cmd`, 'bash')}
  <p>Node.js 20 or newer, nothing to install. The data file <code>server/data/state.json</code> is created on first use.</p>
  <h3>2. Connect a client</h3>
  <h4>Claude Code (remote, Streamable HTTP)</h4>
  ${pre(`claude mcp add --transport http mastermind ${PUBLIC}/mcp\n# with an API key configured on the server:\nclaude mcp add --transport http mastermind ${PUBLIC}/mcp --header "Authorization: Bearer YOUR_KEY"`, 'bash')}
  <h4>Claude Desktop (stdio bridge in claude_desktop_config.json)</h4>
  ${pre({ mcpServers: { mastermind: { command: 'node', args: ['/path/to/mastermind-web/server/mcp-stdio.js', '--url', PUBLIC + '/mcp'] } } })}
  <p>The bridge forwards every message to the HTTP server so Desktop plays on the shared scoreboard. Pass <code>--local</code> instead of <code>--url</code> to play entirely in-process with a private data file (no server needed), or add <code>--api-key=…</code> when the server requires one.</p>
  <h4>claude.ai custom connector</h4>
  <p>Settings → Connectors → Add custom connector → URL <code>${PUBLIC}/mcp</code>. The server is stateless and needs no OAuth; if you set an API key the connector cannot send it, so leave the key unset for claude.ai or put the server behind your own gateway.</p>
  <h4>MCP Inspector</h4>
  ${pre(`npx @modelcontextprotocol/inspector\n# transport: Streamable HTTP · URL: ${PUBLIC}/mcp`, 'bash')}
  <h3>3. Say the word</h3>
  <blockquote class="card"><p>“Play a game of Mastermind as <em>Claude</em> on the classic board. Read the rules first, think about which codes are still possible after every answer, and tell me the secret, your guess count, your score and your rank when you are done.”</p></blockquote>
  <p>There is also a ready-made prompt, <code>play</code>, that says exactly that (see <a href="#resources">prompts</a>), and <code>node tools/play-demo.js</code> plays a game through the MCP endpoint from the command line so you can watch the transcript.</p>

  <h2 id="flow">A game, call by call</h2>
  <div class="seq">agent → server   tools/call rules                      (once; notation, boards, scoring)
agent → server   tools/call new_game {player, preset}  → game_id, palette, guesses_left, message
agent → server   tools/call guess {game_id, "RROO"}    → feedback {black, white}, history, guesses_left
agent → server   tools/call guess …                    → …  (keep only codes consistent with every answer)
server → agent   status "won" | "lost", secret, score  (the secret is revealed only when the game is over)
agent → server   tools/call get_scores {player}        → rank, statistics, recent games</div>
  <p>Games have no session: the <code>game_id</code> is the only handle, so an agent can stop and resume from any client. Unfinished games expire after 24 hours of inactivity; finished games remain readable through <code>get_game</code> and in the scoreboard.</p>

  <h2 id="tools">Tools</h2>
  <p>Every tool returns the result both as a JSON text block and as <code>structuredContent</code>. Validation and game errors come back as a tool result with <code>isError: true</code> and a message such as <code>Error (game_over): …</code>; protocol-level problems (unknown tool, malformed request) are JSON-RPC errors.</p>
  <table><thead><tr><th>Tool</th><th>Purpose</th><th>REST</th></tr></thead><tbody>${TOOLS.map(t => `<tr><td><a href="#tool-${t.name}"><code>${t.name}</code></a></td><td>${esc(t.title)}</td><td class="rest">${esc(restPath(t))}</td></tr>`).join('')}</tbody></table>
  ${toolSections}

  <h2 id="resources">Resources &amp; prompts</h2>
  <table><thead><tr><th>Resource</th><th>Type</th><th>Content</th></tr></thead><tbody>
    ${RESOURCES.map(r => `<tr><td><code>${esc(r.uri)}</code></td><td>${esc(r.mimeType)}</td><td>${esc(r.description)}</td></tr>`).join('')}
    ${RESOURCE_TEMPLATES.map(t => `<tr><td><code>${esc(t.uriTemplate)}</code></td><td>${esc(t.mimeType)}</td><td>${esc(t.description)} (template)</td></tr>`).join('')}
  </tbody></table>
  <table><thead><tr><th>Prompt</th><th>Arguments</th><th>Purpose</th></tr></thead><tbody>
    ${PROMPTS.map(p => `<tr><td><code>${esc(p.name)}</code></td><td>${p.arguments.length ? p.arguments.map(a => '<code>' + esc(a.name) + '</code>' + (a.required ? ' (required)' : '')).join(', ') : '—'}</td><td>${esc(p.description)}</td></tr>`).join('')}
  </tbody></table>

  <h2 id="rest">REST API</h2>
  <p>Base path <code>${PUBLIC}/api</code>. JSON in, JSON out; <code>POST</code> bodies are JSON objects; <code>GET</code> arguments go in the query string. Errors use one shape:</p>
  ${pre(ex.error)}
  <table><thead><tr><th>Endpoint</th><th>Tool</th><th>Notes</th></tr></thead><tbody>
    <tr><td class="rest">GET /api</td><td>—</td><td>Index of endpoints and links</td></tr>
    <tr><td class="rest">GET /api/health</td><td>—</td><td>Liveness, version, active game count</td></tr>
    <tr><td class="rest">GET /api/tools</td><td>—</td><td>The MCP tool catalog, resources and prompts as JSON</td></tr>
    <tr><td class="rest">GET /api/openapi.json</td><td>—</td><td>OpenAPI 3.1 document (<a href="openapi.json">static copy</a>)</td></tr>
    ${TOOLS.map(t => `<tr><td class="rest">${esc(restPath(t))}</td><td><a href="#tool-${t.name}"><code>${t.name}</code></a></td><td>${t.rest.status === 201 ? 'returns 201' : t.annotations.readOnlyHint ? 'read-only' : ''}</td></tr>`).join('')}
    <tr><td class="rest">DELETE /api/games/{game_id}</td><td><code>resign</code></td><td>alias</td></tr>
  </tbody></table>
  <table><thead><tr><th>Status</th><th>Code</th><th>Meaning</th></tr></thead><tbody>
    <tr><td>400</td><td><code>invalid_guess</code>, <code>invalid_colour</code>, <code>invalid_config</code>, <code>invalid_argument</code>, <code>unknown_argument</code>, <code>missing_argument</code>, <code>missing_secret</code>, <code>invalid_json</code></td><td>The request is malformed; the message says exactly what to fix</td></tr>
    <tr><td>401</td><td><code>unauthorized</code></td><td>The server requires <code>Authorization: Bearer &lt;key&gt;</code></td></tr>
    <tr><td>403</td><td><code>forbidden_origin</code></td><td>Browser <code>Origin</code> not allowed on <code>/mcp</code></td></tr>
    <tr><td>404</td><td><code>not_found</code></td><td>Unknown game id or endpoint</td></tr>
    <tr><td>409</td><td><code>game_over</code>, <code>wrong_mode</code></td><td>The game is finished, or it is a codemaker game</td></tr>
    <tr><td>413 / 429 / 503</td><td><code>bad_body</code>, <code>rate_limited</code>, <code>busy</code></td><td>Body too large, too many requests (<code>Retry-After</code>), too many games in progress</td></tr>
  </tbody></table>

  <h2 id="notation">Notation &amp; boards</h2>
  <p>A code is a list of colours. A guess (or a codemaker secret) may be sent as an array of names, letters or numbers, or as one string of letters or digits; the server echoes codes back as <code>colors</code> (names), <code>letters</code> and <code>ids</code>. A game uses the first <code>colors</code> entries of the palette:</p>
  <p>${paletteRow}</p>
  <p>With <code>allow_blanks</code> the extra symbol <code>empty</code> (<code>0</code>, <code>.</code>) may appear in codes.</p>
  <table><thead><tr><th>Preset</th><th>Name</th><th>Pegs</th><th>Colours</th><th>Guesses</th><th>Repeats</th><th>Codes</th></tr></thead><tbody>${presetRows}<tr><td><em>custom</em></td><td>—</td><td>${Engine.LIMITS.pegs.join('–')}</td><td>${Engine.LIMITS.colors.join('–')}</td><td>${Engine.LIMITS.maxGuesses.join('–')}</td><td>on/off</td><td>hints and codemaker mode up to ${Engine.MAX_ENUM.toLocaleString('en-US')}</td></tr></tbody></table>
  <p><strong>Feedback.</strong> <code>black</code> = pegs of the right colour in the right position, <code>white</code> = pegs of the right colour in the wrong position. They are counts, not positions, and each secret peg and each guess peg is matched at most once: against the code <code>RGBY</code>, the guess <code>RRRR</code> earns 1 black and 0 white.</p>

  <h2 id="scoring">Scoring</h2>
  <p><strong>Codebreaker:</strong> <code>score = round(1000 × (max_guesses + 1 − guesses_used − hints_used) ÷ max_guesses × difficulty)</code>, where <code>difficulty = ln(code_space) ÷ ln(1296)</code> (classic = 1.00, super ≈ 1.45, grand ≈ 1.74). A classic code broken on the first guess scores 1000, on the fifth 600, on the tenth 100; a hint costs the same as one guess; lost or resigned games score 0.</p>
  <p><strong>Codemaker:</strong> points = the guesses the solver needed, +1 if it never broke the code. The solver is Knuth's minimax: on the classic board it needs at most five guesses, so a 5 is the best you can do there; bigger boards give it more to think about.</p>
  <p>The scoreboard ranks codebreaker wins by score, then by time; <code>players</code> aggregates games, wins, win rate, average guesses on wins, best and total score; <code>codemakers</code> ranks by points.</p>

  <h2 id="strategy">Playing well</h2>
  <ol class="steps">
    <li><strong>Open with two pairs</strong> (<code>RROO</code> on the classic board). It is the opening that leaves the fewest possibilities in the worst case.</li>
    <li><strong>Keep the consistent set.</strong> After each answer, discard every candidate code that would not have produced exactly that black/white answer against your guess. Only codes that survive every answer can be the secret.</li>
    <li><strong>Guess a survivor</strong>, or better, the guess (survivor or not) whose worst-case answer leaves the smallest consistent set. That is Knuth's rule and it solves the classic board in five.</li>
    <li><strong>Ask for a hint only when stuck:</strong> <code>hint</code> returns the size of the consistent set, a sample and the solver's next guess, but costs a guess in the score.</li>
    <li><strong>Read <code>message</code>.</strong> Every response says what to do next and, at the end, the secret and your score.</li>
  </ol>

  <h2 id="server">Running a server</h2>
  ${pre(`node server/server.js [--port=8772] [--host=0.0.0.0] [--data=server/data/state.json]\n                      [--base-path=/games/mastermind] [--api-key=SECRET]\n                      [--allowed-origins=https://a.example,https://b.example]\n                      [--public-url=https://example.com/games/mastermind] [--no-static] [--quiet]\n\nenvironment: PORT, HOST, MASTERMIND_DATA, MASTERMIND_BASE_PATH, MASTERMIND_API_KEY,\n             MASTERMIND_ALLOWED_ORIGINS, MASTERMIND_PUBLIC_URL`, 'bash')}
  <table><thead><tr><th>Concern</th><th>Behaviour</th></tr></thead><tbody>
    <tr><td>Authentication</td><td>None by default. With <code>--api-key</code>, <code>/mcp</code> and the game routes require <code>Authorization: Bearer &lt;key&gt;</code> (or <code>X-Api-Key</code>); <code>/api/health</code>, <code>/api/rules</code>, <code>/api/scores</code>, <code>/api/tools</code> and the OpenAPI document stay public.</td></tr>
    <tr><td>Origin policy</td><td>Browser requests to <code>/mcp</code> must come from the same host, from <code>localhost</code>, from the configured public URL or from <code>--allowed-origins</code> (DNS-rebinding protection). Non-browser clients send no <code>Origin</code> and are unaffected. CORS is open for the REST API.</td></tr>
    <tr><td>Rate limit</td><td>A token bucket per client address: bursts of 240 requests, refilling at 4 per second; excess requests get 429 with <code>Retry-After</code>. <code>X-Forwarded-For</code> is honoured when the connection comes from a private address (a reverse proxy).</td></tr>
    <tr><td>Persistence</td><td>Live games and finished records are kept in one JSON file, written atomically and debounced. Finished games are pruned from memory after 6 hours (records stay); idle unfinished games expire after 24 hours. Records are capped at 20,000.</td></tr>
    <tr><td>Reverse proxy</td><td>Mount under a prefix with <code>--base-path</code> (or <code>MASTERMIND_BASE_PATH</code>): the server strips it from every request, so <code>ProxyPass /games/mastermind http://127.0.0.1:8772/games/mastermind</code> in Apache (or <code>location /games/mastermind/ { proxy_pass http://127.0.0.1:8772; }</code> in nginx) just works. Set <code>--public-url</code> so the documents advertise the external address.</td></tr>
    <tr><td>stdio bridge</td><td><code>node server/mcp-stdio.js --url ${PUBLIC}/mcp</code> relays to a running server; <code>--local</code> runs the game in-process with <code>--data</code> (default <code>server/data/state-stdio.json</code>). Without <code>--url</code> it probes <code>localhost:8772</code> and falls back to local play.</td></tr>
  </tbody></table>

  <h2 id="protocol">Protocol notes</h2>
  <ul>
    <li>Protocol versions <code>${SUPPORTED.join('</code>, <code>')}</code>; the server echoes a supported requested version, otherwise answers with the newest.</li>
    <li>Streamable HTTP, <strong>stateless</strong>: no <code>Mcp-Session-Id</code> is issued or required. <code>POST /mcp</code> answers with <code>application/json</code> (or <code>text/event-stream</code> when that is the only accepted type). Notifications and client responses get <code>202</code>. <code>GET /mcp</code> returns <code>405</code> (no server-initiated stream); <code>DELETE /mcp</code> is accepted and a no-op. JSON-RPC batches are processed in order.</li>
    <li>Capabilities: <code>tools</code>, <code>resources</code> (with templates, no subscriptions), <code>prompts</code>, <code>logging</code>. Tool results carry <code>structuredContent</code> plus a text block; tool annotations mark read-only and destructive tools.</li>
    <li>Errors: <code>-32700</code> parse, <code>-32600</code> invalid request, <code>-32601</code> unknown method, <code>-32602</code> unknown tool / bad params, <code>-32002</code> unknown resource.</li>
  </ul>
  <h4>Raw exchange</h4>
  ${pre(`POST ${PUBLIC}/mcp\nContent-Type: application/json\nAccept: application/json, text/event-stream\n\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}\n\n→ 200 {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"prompts":{"listChanged":false},"logging":{}},"serverInfo":{"name":"mastermind","title":"Mastermind","version":"${pkg.version}"},"instructions":"…"}}\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}            → 202\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}                    → 200 {…"tools":[…${TOOLS.length} tools…]}\n{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"new_game","arguments":{"player":"Claude"}}}`, 'http')}
</main>
<footer>Generated by <code>tools/gen-docs.mjs</code> from the server's tool catalog · Mastermind is a trademark of its owner; this is an unofficial recreation for entertainment · play money, no wagering</footer>
</body>
</html>
`;
}

async function main() {
  const ex = examples();
  await fs.mkdir(path.join(ROOT, 'docs'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'docs', 'mcp.html'), page(ex));
  await fs.writeFile(path.join(ROOT, 'docs', 'openapi.json'), JSON.stringify(openapi('', PUBLIC), null, 2));
  console.log('wrote docs/mcp.html and docs/openapi.json (public url ' + PUBLIC + ')');
}
main().catch(e => { console.error(e.stack || e); process.exit(1); });
