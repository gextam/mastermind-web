#!/usr/bin/env node
/* ============================================================================
   MASTERMIND — MCP over stdio, for Claude Desktop / Claude Code "command"
   servers. Newline-delimited JSON-RPC on stdin/stdout.

   By default it bridges to a running Mastermind HTTP server so every client
   shares one scoreboard:   node server/mcp-stdio.js --url http://host:8772/mcp
   With --local (or when no server answers) the game runs in-process with its
   own data file:           node server/mcp-stdio.js --local [--data=path.json]

   options: --url=…  --api-key=…  --local  --data=…   env: MASTERMIND_URL,
            MASTERMIND_API_KEY, MASTERMIND_DATA
   Only JSON-RPC goes to stdout; diagnostics go to stderr.
   ========================================================================== */
'use strict';
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('./server.js');

const a = parseArgs(process.argv.slice(2));
const URL_ = a.url || process.env.MASTERMIND_URL || 'http://localhost:8772/mcp';
const KEY = a['api-key'] || process.env.MASTERMIND_API_KEY || '';
const DATA = a.data || process.env.MASTERMIND_DATA || path.join(__dirname, 'data', 'state-stdio.json');
const note = s => process.stderr.write('[mastermind-mcp] ' + s + '\n');
const write = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } });

function localHandler() {
  const Service = require('./service.js');
  const { createMcp } = require('./mcp.js');
  const svc = new Service({ dataFile: DATA }).start();
  const mcp = createMcp(svc);
  process.on('exit', () => svc.stop());
  note('running the game in-process, data file ' + DATA);
  return payload => mcp.handleAny(payload);
}
function remoteHandler(url) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (KEY) headers.Authorization = 'Bearer ' + KEY;
  note('bridging to ' + url);
  return async payload => {
    const r = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) });
    if (r.status === 202) return null;
    const text = await r.text();
    if (!r.ok) {
      let msg = 'HTTP ' + r.status; try { const j = JSON.parse(text); msg += ': ' + ((j.error && j.error.message) || text); } catch (e) { msg += ': ' + text.slice(0, 200); }
      const ids = (Array.isArray(payload) ? payload : [payload]).filter(m => m && m.id !== undefined).map(m => m.id);
      if (!ids.length) return null;
      return ids.length === 1 ? rpcErr(ids[0], -32000, msg) : ids.map(id => rpcErr(id, -32000, msg));
    }
    if (/^text\/event-stream/.test(r.headers.get('content-type') || '')) {
      const msgs = text.split(/\n\n/).map(b => b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')).filter(Boolean).map(s => JSON.parse(s));
      return msgs.length === 1 ? msgs[0] : msgs;
    }
    return text.trim() ? JSON.parse(text) : null;
  };
}
async function probe(url) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
    const health = url.replace(/\/mcp\/?$/, '') + '/api/health';
    const r = await fetch(health, { signal: ctl.signal, headers: KEY ? { Authorization: 'Bearer ' + KEY } : {} });
    clearTimeout(t);
    return r.ok;
  } catch (e) { return false; }
}

async function main() {
  let handle;
  if (a.local) handle = localHandler();
  else if (await probe(URL_)) handle = remoteHandler(URL_);
  else { note('no server answered at ' + URL_ + '; falling back to in-process play (pass --url to use a shared server)'); handle = localHandler(); }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  rl.on('line', line => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { write(rpcErr(null, -32700, 'Parse error')); return; }
    Promise.resolve().then(() => handle(msg)).then(r => { if (r) write(r); }).catch(e => {
      note('error: ' + (e && e.message || e));
      const ids = (Array.isArray(msg) ? msg : [msg]).filter(m => m && m.id !== undefined).map(m => m.id);
      ids.forEach(id => write(rpcErr(id, -32603, 'Internal error: ' + (e && e.message || e))));
    });
  });
  rl.on('close', () => process.exit(0));
  process.stdin.on('end', () => process.exit(0));
}
main().catch(e => { note('fatal: ' + (e && e.stack || e)); process.exit(1); });
