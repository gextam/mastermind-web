/* ============================================================================
   MASTERMIND server — the tool catalog. One definition per operation drives
   the MCP tools/list, argument validation, the REST router, the OpenAPI
   document and the generated documentation page, so they cannot drift apart.
   ========================================================================== */
'use strict';
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));
const { ApiError } = require('./service.js');

const PRESET_NAMES = Object.keys(Engine.PRESETS);
const GAME_ID = { type: 'string', description: 'The game_id returned by new_game', minLength: 4, maxLength: 40 };
const CODE = { type: ['string', 'array'], items: { type: ['string', 'integer'] }, description: 'A code: an array of colour names, letters or numbers (["red","green","blue","yellow"], ["R","G","B","Y"], [1,4,5,3]) or a string of letters/digits ("RGBY", "1453"). Letters: R red, O orange, Y yellow, G green, B blue, P purple, W white, K black, C cyan, N pink; "." is empty when blanks are allowed.' };

const TOOLS = [
  {
    name: 'rules', title: 'Rules and notation', method: 'rules',
    description: 'The rules of Mastermind as played here: boards (presets), the colours and how to write a guess, how the black/white key pegs are counted, the scoring formula and a sound strategy. Read it once before your first game.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rest: { method: 'GET', path: '/api/rules' },
    example: { arguments: {} }, textField: 'text'
  },
  {
    name: 'new_game', title: 'Start a game', method: 'newGame',
    description: 'Start a new game. Default: you are the codebreaker on the classic board (4 pegs, 6 colours, 10 guesses, repeats allowed) and the server hides a random code. Pass preset or the individual settings for other boards. With mode "maker" you supply the secret instead and the server\'s Knuth solver tries to break it; the game is returned already finished with the solver\'s transcript and your codemaker points. Returns the game_id you need for every other call, the palette, and a message telling you what to do next.',
    inputSchema: {
      type: 'object',
      properties: {
        player: { type: 'string', maxLength: Engine.LIMITS.player, description: 'Your name on the scoreboard (default "Anonymous")' },
        mode: { type: 'string', enum: ['breaker', 'maker'], description: 'breaker: you guess the server\'s code (default). maker: you set the code, the server\'s solver breaks it.' },
        preset: { type: 'string', enum: PRESET_NAMES, description: 'Board preset: ' + PRESET_NAMES.map(k => k + ' (' + Engine.PRESETS[k].blurb + ')').join('; ') },
        pegs: { type: 'integer', minimum: Engine.LIMITS.pegs[0], maximum: Engine.LIMITS.pegs[1], description: 'Pegs in the code (overrides the preset)' },
        colors: { type: 'integer', minimum: Engine.LIMITS.colors[0], maximum: Engine.LIMITS.colors[1], description: 'Number of colours in play (the first N of the palette)' },
        max_guesses: { type: 'integer', minimum: Engine.LIMITS.maxGuesses[0], maximum: Engine.LIMITS.maxGuesses[1], description: 'Guesses allowed' },
        allow_duplicates: { type: 'boolean', description: 'May the code repeat a colour? (default true)' },
        allow_blanks: { type: 'boolean', description: 'May the code contain empty positions? (default false)' },
        secret: Object.assign({}, CODE, { description: 'maker mode only: the code the solver must break. ' + CODE.description })
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    rest: { method: 'POST', path: '/api/games', status: 201 },
    example: { arguments: { player: 'Claude', preset: 'classic' } }
  },
  {
    name: 'guess', title: 'Make a guess', method: 'guess',
    description: 'Submit a guess for a game you are breaking. Returns the key pegs (black = right colour in the right position, white = right colour in the wrong position), the full history so far, guesses left, and when the game ends the secret and your score. A guess must have exactly as many pegs as the code.',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID, guess: CODE }, required: ['game_id', 'guess'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    rest: { method: 'POST', path: '/api/games/{game_id}/guess' },
    example: { arguments: { game_id: 'k7d2w9qh3m5p', guess: ['red', 'red', 'green', 'green'] } }
  },
  {
    name: 'get_game', title: 'Game state', method: 'getGame',
    description: 'The current state of a game: configuration, palette, every guess with its feedback, guesses left, and the secret and score once it is finished. Finished games stay readable (archived) after the live object is pruned.',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID }, required: ['game_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rest: { method: 'GET', path: '/api/games/{game_id}' },
    example: { arguments: { game_id: 'k7d2w9qh3m5p' } }
  },
  {
    name: 'list_games', title: 'List games', method: 'listGames',
    description: 'List games on the server, newest first: by default the games still in progress; filter by player name or status (playing, won, lost, resigned, solved, unsolved, finished, all). Useful to resume a game whose id you lost.',
    inputSchema: { type: 'object', properties: { player: { type: 'string', maxLength: Engine.LIMITS.player, description: 'Only this player\'s games' }, status: { type: 'string', enum: ['playing', 'finished', 'all', 'won', 'lost', 'resigned', 'solved', 'unsolved'], description: 'Default playing' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rest: { method: 'GET', path: '/api/games' },
    example: { arguments: { player: 'Claude', status: 'playing' } }
  },
  {
    name: 'hint', title: 'Hint', method: 'hint',
    description: 'Ask the server\'s solver for help in a game you are breaking: how many codes are still consistent with the feedback so far, a sample of them, and the guess it would play next. Each hint costs one guess in the score (it does not use up a turn).',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID }, required: ['game_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    rest: { method: 'POST', path: '/api/games/{game_id}/hint' },
    example: { arguments: { game_id: 'k7d2w9qh3m5p' } }
  },
  {
    name: 'resign', title: 'Resign', method: 'resign',
    description: 'Give up a game in progress. The secret is revealed, the game is recorded as resigned with a score of 0.',
    inputSchema: { type: 'object', properties: { game_id: GAME_ID }, required: ['game_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    rest: { method: 'POST', path: '/api/games/{game_id}/resign' },
    example: { arguments: { game_id: 'k7d2w9qh3m5p' } }
  },
  {
    name: 'get_scores', title: 'Scoreboard', method: 'scores',
    description: 'The scoreboard: top codebreaker scores, the strongest codemakers, per-player statistics (games, wins, win rate, average guesses, best score) and the most recent games. Pass player to get that player\'s own statistics and recent games as well.',
    inputSchema: { type: 'object', properties: { player: { type: 'string', maxLength: Engine.LIMITS.player, description: 'Also return this player\'s statistics and recent games' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows per table (default 10)' }, mode: { type: 'string', enum: ['breaker', 'maker'], description: 'Only count games of this mode' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rest: { method: 'GET', path: '/api/scores' },
    example: { arguments: { player: 'Claude', limit: 10 } }
  }
];

const RESOURCES = [
  { uri: 'mastermind://rules', name: 'rules', title: 'Rules of Mastermind', description: 'Rules, notation, boards and scoring (markdown)', mimeType: 'text/markdown', read: svc => svc.rules().text },
  { uri: 'mastermind://scores', name: 'scores', title: 'Scoreboard', description: 'Current scoreboard (JSON)', mimeType: 'application/json', read: svc => JSON.stringify(svc.scores({ limit: 20 }), null, 2) }
];
const RESOURCE_TEMPLATES = [
  { uriTemplate: 'mastermind://games/{game_id}', name: 'game', title: 'Game state', description: 'State of one game (JSON)', mimeType: 'application/json', match: /^mastermind:\/\/games\/([^/]+)$/, read: (svc, m) => JSON.stringify(svc.getGame({ game_id: m[1] }), null, 2) }
];
const PROMPTS = [
  {
    name: 'play', title: 'Play a game', description: 'Play one complete game of Mastermind against the server and report the result',
    arguments: [{ name: 'player', description: 'Name for the scoreboard', required: false }, { name: 'preset', description: 'Board preset: ' + PRESET_NAMES.join(', '), required: false }],
    render: a => 'Play one complete game of Mastermind against the Mastermind MCP server.\n\n1. Call `rules` once if you have not read it in this conversation.\n2. Call `new_game` with player="' + (a.player || 'Claude') + '"' + (a.preset ? ' and preset="' + a.preset + '"' : '') + '.\n3. Guess with `guess` until the game ends. Play well: open with two pairs (for example RRGG), keep a list of every code that is consistent with all the feedback so far, and only guess codes that are still possible, preferring the one that splits the remaining possibilities most evenly.\n4. When the game is over, report the secret, the number of guesses, the score, and then call `get_scores` with your player name to report your rank.'
  },
  {
    name: 'strategy', title: 'Solving strategy', description: 'A short explanation of how to break a Mastermind code efficiently',
    arguments: [],
    render: () => 'Explain, briefly and concretely, how to break a Mastermind code efficiently: the consistent-set method (after each answer discard every code that would not have produced exactly that answer), why opening with two pairs such as RRGG is strong on the classic board, and how Knuth\'s minimax choice (pick the guess whose worst-case answer leaves the fewest codes) guarantees a solve in five guesses. Then offer to play a game with the Mastermind tools.'
  }
];

/* --------------------------------------------------------- validation */
function typeOk(v, t) {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v) || (typeof v === 'string' && /^-?\d+$/.test(v.trim()));
    case 'number': return (typeof v === 'number' && !isNaN(v)) || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));
    case 'boolean': return typeof v === 'boolean' || ['true', 'false', '1', '0', 'yes', 'no'].includes(String(v).toLowerCase());
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return true;
  }
}
function coerce(name, s, v) {
  const types = s.type ? [].concat(s.type) : null;
  if (types) {
    if (types.includes('integer') && typeOk(v, 'integer')) v = parseInt(v, 10);
    else if (types.includes('number') && typeOk(v, 'number')) v = Number(v);
    else if (types.includes('boolean') && typeOk(v, 'boolean')) v = v === true || ['true', '1', 'yes'].includes(String(v).toLowerCase());
    else if (!types.some(t => typeOk(v, t))) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be ' + types.join(' or '));
  }
  if (s.enum && !s.enum.includes(v)) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be one of: ' + s.enum.join(', '));
  if (s.minimum != null && v < s.minimum) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be at least ' + s.minimum);
  if (s.maximum != null && v > s.maximum) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be at most ' + s.maximum);
  if (typeof v === 'string' && s.maxLength != null && v.length > s.maxLength) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be at most ' + s.maxLength + ' characters');
  if (typeof v === 'string' && s.minLength != null && v.length < s.minLength) throw new ApiError(400, 'invalid_argument', '"' + name + '" must be at least ' + s.minLength + ' characters');
  if (Array.isArray(v) && s.items && s.items.type) {
    const it = [].concat(s.items.type);
    v.forEach((x, i) => { if (!it.some(t => typeOk(x, t))) throw new ApiError(400, 'invalid_argument', '"' + name + '[' + i + ']" must be ' + it.join(' or ')); });
  }
  return v;
}
function validateArgs(tool, args) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ApiError(400, 'invalid_arguments', 'arguments must be an object');
  const schema = tool.inputSchema, props = schema.properties || {}, out = {};
  Object.keys(args).forEach(k => {
    const v = args[k];
    if (v === undefined) return;
    if (!props[k]) {
      if (schema.additionalProperties === false) throw new ApiError(400, 'unknown_argument', 'Unknown argument "' + k + '" for ' + tool.name + '. Allowed: ' + (Object.keys(props).join(', ') || 'none'));
      out[k] = v; return;
    }
    if (v === null) return;
    out[k] = coerce(k, props[k], v);
  });
  (schema.required || []).forEach(r => { if (out[r] === undefined || out[r] === '') throw new ApiError(400, 'missing_argument', 'Missing required argument "' + r + '" for ' + tool.name); });
  return out;
}
function publicTool(t) {
  const o = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: Object.assign({ title: t.title }, t.annotations) };
  return o;
}
async function runTool(service, tool, args) {
  const clean = validateArgs(tool, args);
  return service[tool.method](clean);
}

/* -------------------------------------------------------------- OpenAPI */
function openapi(base, serverUrl) {
  const paths = {};
  const errorSchema = { type: 'object', properties: { error: { type: 'object', properties: { status: { type: 'integer' }, code: { type: 'string' }, message: { type: 'string' } } } } };
  TOOLS.forEach(t => {
    const p = t.rest.path, m = t.rest.method.toLowerCase();
    const pathParams = (p.match(/\{(\w+)\}/g) || []).map(s => s.slice(1, -1));
    const props = t.inputSchema.properties || {};
    const op = { operationId: t.name, summary: t.title, description: t.description, tags: ['mastermind'], parameters: [], responses: { [String(t.rest.status || 200)]: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } }, '400': { description: 'Bad request', content: { 'application/json': { schema: errorSchema } } }, '404': { description: 'Unknown game', content: { 'application/json': { schema: errorSchema } } }, '409': { description: 'Game already finished', content: { 'application/json': { schema: errorSchema } } } } };
    pathParams.forEach(n => op.parameters.push({ name: n, in: 'path', required: true, schema: { type: 'string' }, description: props[n] ? props[n].description : '' }));
    const bodyProps = {};
    Object.keys(props).forEach(k => { if (pathParams.includes(k)) return; if (m === 'get') op.parameters.push({ name: k, in: 'query', required: (t.inputSchema.required || []).includes(k), schema: props[k], description: props[k].description }); else bodyProps[k] = props[k]; });
    if (m !== 'get' && Object.keys(bodyProps).length) op.requestBody = { required: (t.inputSchema.required || []).some(r => !pathParams.includes(r)), content: { 'application/json': { schema: { type: 'object', properties: bodyProps, required: (t.inputSchema.required || []).filter(r => !pathParams.includes(r)) } } } };
    paths[p] = paths[p] || {}; paths[p][m] = op;
  });
  paths['/api/health'] = { get: { operationId: 'health', summary: 'Server health', tags: ['mastermind'], responses: { '200': { description: 'OK' } } } };
  paths['/api/tools'] = { get: { operationId: 'tools', summary: 'The MCP tool catalog as JSON', tags: ['mastermind'], responses: { '200': { description: 'OK' } } } };
  return {
    openapi: '3.1.0',
    info: { title: 'Mastermind API', version: require(path.join(__dirname, '..', 'package.json')).version, description: 'Play Mastermind against the server over plain HTTP. The same operations are exposed as MCP tools at ' + (base || '') + '/mcp.' },
    servers: [{ url: serverUrl || (base || '/') }],
    paths: paths
  };
}

module.exports = { TOOLS, RESOURCES, RESOURCE_TEMPLATES, PROMPTS, validateArgs, publicTool, runTool, openapi, PRESET_NAMES };
