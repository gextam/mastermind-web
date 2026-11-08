/* ============================================================================
   MASTERMIND server — Model Context Protocol dispatcher. Transport-agnostic:
   takes one JSON-RPC message (or a batch) and returns the response, or null
   for notifications. Used by the Streamable HTTP endpoint (server.js) and by
   the stdio bridge (mcp-stdio.js). Implements initialize/ping, tools,
   resources (+ templates), prompts and logging/setLevel for protocol
   versions 2024-11-05, 2025-03-26 and 2025-06-18.
   ========================================================================== */
'use strict';
const path = require('path');
const { TOOLS, RESOURCES, RESOURCE_TEMPLATES, PROMPTS, publicTool, runTool } = require('./tools.js');
const VERSION = require(path.join(__dirname, '..', 'package.json')).version;

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = [
  'Mastermind game server. You are the codebreaker: call new_game (optionally with your name and a board preset), then guess repeatedly until the game ends;',
  'each answer gives black pegs (right colour, right position) and white pegs (right colour, wrong position). Keep only codes consistent with every answer so far.',
  'Read rules once for notation and scoring. get_game recovers state, hint asks the solver (costs score), resign gives up, get_scores shows the scoreboard.',
  'In mode "maker" you set the secret and the server\'s Knuth solver breaks it.'
].join(' ');

function rpcError(code, message, data) { const e = new Error(message); e.rpcCode = code; if (data !== undefined) e.data = data; return e; }

function createMcp(service, opts) {
  opts = opts || {};
  const serverInfo = { name: 'mastermind', title: 'Mastermind', version: opts.version || VERSION };
  const log = opts.log || (() => {});

  function ok(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
  function err(id, code, message, data) { const e = { code: code, message: message }; if (data !== undefined) e.data = data; return { jsonrpc: '2.0', id: id === undefined ? null : id, error: e }; }

  async function callTool(params) {
    const name = params && params.name;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw rpcError(-32602, 'Unknown tool: ' + name + '. Available: ' + TOOLS.map(t => t.name).join(', '));
    try {
      const result = await runTool(service, tool, params.arguments || {});
      const text = tool.textField && result && typeof result[tool.textField] === 'string' ? result[tool.textField] : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text: text }], structuredContent: result, isError: false };
    } catch (e) {
      if (e && (e.status || e.code)) return { content: [{ type: 'text', text: 'Error (' + (e.code || 'error') + '): ' + e.message }], isError: true };
      throw e;
    }
  }
  function readResource(params) {
    const uri = params && params.uri;
    if (typeof uri !== 'string') throw rpcError(-32602, 'uri is required');
    const r = RESOURCES.find(x => x.uri === uri);
    if (r) return { contents: [{ uri: uri, mimeType: r.mimeType, text: r.read(service) }] };
    for (const t of RESOURCE_TEMPLATES) {
      const m = uri.match(t.match);
      if (m) {
        try { return { contents: [{ uri: uri, mimeType: t.mimeType, text: t.read(service, m) }] }; }
        catch (e) { throw rpcError(-32002, e.message || 'Resource not found', { uri: uri }); }
      }
    }
    throw rpcError(-32002, 'Resource not found: ' + uri, { uri: uri });
  }
  function getPrompt(params) {
    const p = PROMPTS.find(x => x.name === (params && params.name));
    if (!p) throw rpcError(-32602, 'Unknown prompt: ' + (params && params.name));
    const args = (params && params.arguments) || {};
    p.arguments.forEach(a => { if (a.required && (args[a.name] == null || args[a.name] === '')) throw rpcError(-32602, 'Missing prompt argument: ' + a.name); });
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render(args) } }] };
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(null, -32600, 'Invalid Request');
    if (msg.method === undefined) return null;                      /* a response or an unknown frame from the client: nothing to answer */
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg.id, -32600, 'Invalid Request');
    const isNotification = msg.id === undefined, params = msg.params || {};
    log(msg.method);
    let out;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = params.protocolVersion;
          out = { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false }, logging: {} }, serverInfo: serverInfo, instructions: INSTRUCTIONS };
          break;
        }
        case 'ping': out = {}; break;
        case 'tools/list': out = { tools: TOOLS.map(publicTool) }; break;
        case 'tools/call': out = await callTool(params); break;
        case 'resources/list': out = { resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType })) }; break;
        case 'resources/templates/list': out = { resourceTemplates: RESOURCE_TEMPLATES.map(t => ({ uriTemplate: t.uriTemplate, name: t.name, title: t.title, description: t.description, mimeType: t.mimeType })) }; break;
        case 'resources/read': out = readResource(params); break;
        case 'resources/subscribe': case 'resources/unsubscribe': throw rpcError(-32601, 'Subscriptions are not supported');
        case 'prompts/list': out = { prompts: PROMPTS.map(p => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })) }; break;
        case 'prompts/get': out = getPrompt(params); break;
        case 'logging/setLevel': out = {}; break;
        case 'completion/complete': out = { completion: { values: [], total: 0, hasMore: false } }; break;
        default:
          if (msg.method.indexOf('notifications/') === 0) return null;
          throw rpcError(-32601, 'Method not found: ' + msg.method);
      }
    } catch (e) {
      if (isNotification) return null;
      return err(msg.id, e.rpcCode || -32603, e.rpcCode ? e.message : 'Internal error: ' + (e.message || e), e.data);
    }
    return isNotification ? null : ok(msg.id, out);
  }
  async function handleAny(payload) {
    if (Array.isArray(payload)) {
      if (!payload.length) return err(null, -32600, 'Invalid Request');
      const rs = [];
      for (const m of payload) { const r = await handle(m); if (r) rs.push(r); }
      return rs.length ? rs : null;
    }
    return handle(payload);
  }
  return { handle: handle, handleAny: handleAny, serverInfo: serverInfo, instructions: INSTRUCTIONS, supportedVersions: SUPPORTED.slice() };
}
module.exports = { createMcp, SUPPORTED, INSTRUCTIONS };
