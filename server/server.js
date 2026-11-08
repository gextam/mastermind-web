#!/usr/bin/env node
/* ============================================================================
   MASTERMIND server — one process serves the game (static files), the REST
   API under /api and the MCP endpoint at /mcp (Streamable HTTP transport).
   No dependencies, Node 20+.

   usage: node server/server.js [--port=8772] [--host=0.0.0.0]
            [--data=server/data/state.json] [--base-path=/games/mastermind]
            [--api-key=SECRET] [--allowed-origins=https://a.example,https://b.example]
            [--public-url=https://example.com/games/mastermind] [--no-static] [--quiet]
   env:   PORT, HOST, MASTERMIND_DATA, MASTERMIND_BASE_PATH, MASTERMIND_API_KEY,
          MASTERMIND_ALLOWED_ORIGINS, MASTERMIND_PUBLIC_URL
   ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Service = require('./service.js');
const { ApiError } = Service;
const { createMcp, SUPPORTED } = require('./mcp.js');
const { TOOLS, RESOURCES, PROMPTS, publicTool, runTool, openapi } = require('./tools.js');

const ROOT = path.resolve(__dirname, '..');
const VERSION = Service.VERSION;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json' };

/* ------------------------------------------------------------- helpers */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}
function normalizeBase(b) { b = String(b || '').trim(); if (!b || b === '/') return ''; if (!b.startsWith('/')) b = '/' + b; return b.replace(/\/+$/, ''); }
function errBody(status, code, message) { return { error: { status: status, code: code, message: message } }; }
function rpcErr(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code: code, message: message } }; }
function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { const e = new Error('Request body too large (limit ' + limit + ' bytes)'); e.status = 413; reject(e); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function pathToRegex(p) { return new RegExp('^' + p.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '/?$'); }
function isPrivate(ip) { return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::ffff:127\.|fc|fd)/.test(ip || ''); }
function clientIp(req) {
  const sock = (req.socket && req.socket.remoteAddress) || '';
  const fwd = req.headers['x-forwarded-for'];
  if (fwd && isPrivate(sock)) return String(fwd).split(',')[0].trim();
  return sock;
}
function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }

class RateLimiter {
  constructor(o) { o = o || {}; this.capacity = o.capacity || 240; this.perSecond = o.perSecond || 4; this.buckets = new Map(); this.last = Date.now(); }
  take(key) {
    const now = Date.now();
    if (now - this.last > 300e3) { for (const [k, b] of this.buckets) if (now - b.at > 600e3) this.buckets.delete(k); this.last = now; }
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) / 1000 * this.perSecond); b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1; return true;
  }
}

/* ----------------------------------------------------------------- app */
function createApp(options) {
  const o = Object.assign({ port: 8772, host: '0.0.0.0', dataFile: path.join(ROOT, 'server', 'data', 'state.json'), basePath: '', apiKey: '', allowedOrigins: [], serveStatic: true, quiet: false, publicUrl: '', rateLimit: null }, options || {});
  const base = normalizeBase(o.basePath);
  const service = new Service({ dataFile: o.dataFile, store: o.store }).start();
  const mcp = createMcp(service);
  const limiter = new RateLimiter(o.rateLimit || undefined);
  const log = o.quiet ? () => {} : function () { console.log.apply(console, [new Date().toISOString().slice(11, 19)].concat(Array.prototype.slice.call(arguments))); };
  const publicBase = () => (o.publicUrl ? o.publicUrl.replace(/\/+$/, '') : base);

  function setCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Api-Key, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  function authorized(req, url) {
    if (!o.apiKey) return true;
    const h = String(req.headers.authorization || '');
    if (/^bearer\s+/i.test(h) && safeEqual(h.replace(/^bearer\s+/i, '').trim(), o.apiKey)) return true;
    if (req.headers['x-api-key'] && safeEqual(req.headers['x-api-key'], o.apiKey)) return true;
    if (url && url.searchParams.get('api_key') && safeEqual(url.searchParams.get('api_key'), o.apiKey)) return true;
    return false;
  }
  function unauthorized(res) { sendJson(res, 401, errBody(401, 'unauthorized', 'This server requires an API key: send "Authorization: Bearer <key>"'), { 'WWW-Authenticate': 'Bearer realm="mastermind"' }); }
  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return true;
    let h; try { h = new URL(origin).hostname; } catch (e) { return false; }
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(h)) return true;
    const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (h === host) return true;
    if (o.publicUrl) { try { if (new URL(o.publicUrl).hostname === h) return true; } catch (e) { /* ignore */ } }
    return o.allowedOrigins.includes('*') || o.allowedOrigins.includes(origin) || o.allowedOrigins.includes(h);
  }

  /* REST routes derive from the tool catalog, so REST and MCP accept exactly the same arguments */
  const routes = TOOLS.map(t => ({
    name: t.name, method: t.rest.method, re: pathToRegex(t.rest.path), status: t.rest.status || 200, open: t.name === 'rules' || t.name === 'get_scores',
    handler: ctx => runTool(service, t, Object.assign({}, t.rest.method === 'GET' ? ctx.query : ctx.body, ctx.params))
  }));
  const resignTool = TOOLS.find(t => t.name === 'resign');
  routes.push({ name: 'resign', method: 'DELETE', re: pathToRegex('/api/games/{game_id}'), status: 200, handler: ctx => runTool(service, resignTool, ctx.params) });
  routes.push({ name: 'health', method: 'GET', re: /^\/api\/health\/?$/, status: 200, open: true, handler: () => service.health() });
  routes.push({ name: 'tools', method: 'GET', re: /^\/api\/tools\/?$/, status: 200, open: true, handler: () => ({ server: { name: 'mastermind', version: VERSION, mcp_endpoint: publicBase() + '/mcp', transport: 'streamable-http', protocol_versions: SUPPORTED, authentication: o.apiKey ? 'bearer' : 'none' }, tools: TOOLS.map(publicTool), resources: RESOURCES.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })), prompts: PROMPTS.map(p => ({ name: p.name, description: p.description, arguments: p.arguments })), rest: TOOLS.map(t => ({ tool: t.name, method: t.rest.method, path: publicBase() + t.rest.path })) }) });
  routes.push({ name: 'openapi', method: 'GET', re: /^\/api\/openapi\.json$/, status: 200, open: true, handler: () => openapi(base, o.publicUrl || undefined) });
  routes.push({ name: 'index', method: 'GET', re: /^\/api\/?$/, status: 200, open: true, handler: () => ({ name: 'Mastermind API', version: VERSION, docs: publicBase() + '/docs/mcp.html', openapi: publicBase() + '/api/openapi.json', tools: publicBase() + '/api/tools', mcp: publicBase() + '/mcp', endpoints: routes.filter(r => r.name !== 'index').map(r => r.method + ' ' + publicBase() + r.re.source.replace(/^\^|\\\/\?\$$|\$$/g, '').replace(/\\\//g, '/').replace(/\(\?<(\w+)>\[\^\/\]\+\)/g, '{$1}').replace(/\\\./g, '.')) }) });

  async function handleApi(req, res, pathname, url, ip) {
    if (!limiter.take(ip)) return sendJson(res, 429, errBody(429, 'rate_limited', 'Too many requests; slow down'), { 'Retry-After': '5' });
    const method = req.method.toUpperCase();
    const route = routes.find(r => r.method === method && r.re.test(pathname));
    if (!route) {
      const allowed = routes.filter(r => r.re.test(pathname)).map(r => r.method);
      if (allowed.length) { res.writeHead(405, { Allow: allowed.concat('OPTIONS').join(', '), 'Content-Type': 'application/json' }); res.end(JSON.stringify(errBody(405, 'method_not_allowed', 'Use ' + allowed.join(' or ')))); return; }
      return sendJson(res, 404, errBody(404, 'not_found', 'No such endpoint; see ' + publicBase() + '/api for the list'));
    }
    if (!route.open && !authorized(req, url)) return unauthorized(res);
    const m = pathname.match(route.re), params = {};
    if (m && m.groups) Object.keys(m.groups).forEach(k => { params[k] = m.groups[k]; });
    const query = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      let raw;
      try { raw = await readBody(req, 64 * 1024); } catch (e) { return sendJson(res, e.status || 400, errBody(e.status || 400, 'bad_body', e.message)); }
      if (raw.trim()) { try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 400, errBody(400, 'invalid_json', 'The request body must be JSON')); } }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, errBody(400, 'invalid_json', 'The request body must be a JSON object'));
    }
    try {
      const result = await route.handler({ params: params, query: query, body: body });
      sendJson(res, route.status, result);
    } catch (e) {
      if (e instanceof ApiError || (e && e.status && e.code)) return sendJson(res, e.status, errBody(e.status, e.code, e.message));
      throw e;
    }
  }

  async function handleMcp(req, res, url, ip) {
    if (!limiter.take(ip)) return sendJson(res, 429, errBody(429, 'rate_limited', 'Too many requests; slow down'), { 'Retry-After': '5' });
    if (!originAllowed(req)) return sendJson(res, 403, errBody(403, 'forbidden_origin', 'Origin not allowed'));
    if (!authorized(req, url)) return unauthorized(res);
    const method = req.method.toUpperCase();
    if (method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE, OPTIONS', 'Content-Type': 'application/json' }); res.end(JSON.stringify(rpcErr(null, -32000, 'This server does not open server-to-client streams. POST JSON-RPC 2.0 messages to this endpoint (MCP Streamable HTTP).'))); return; }
    if (method === 'DELETE') { sendJson(res, 200, { ok: true, note: 'sessions are stateless; nothing to terminate' }); return; }
    if (method !== 'POST') { res.writeHead(405, { Allow: 'POST, DELETE, OPTIONS' }); res.end(); return; }
    let raw;
    try { raw = await readBody(req, 256 * 1024); } catch (e) { return sendJson(res, e.status || 400, rpcErr(null, -32600, e.message)); }
    let payload;
    try { payload = JSON.parse(raw); } catch (e) { return sendJson(res, 400, rpcErr(null, -32700, 'Parse error: body is not valid JSON')); }
    const out = await mcp.handleAny(payload);
    if (!out) { res.writeHead(202, { 'Content-Length': '0' }); res.end(); return; }
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      (Array.isArray(out) ? out : [out]).forEach(m => res.write('event: message\ndata: ' + JSON.stringify(m) + '\n\n'));
      res.end(); return;
    }
    sendJson(res, 200, out);
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.normalize(path.join(ROOT, pathname));
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel) || /^(server|tools|node_modules|\.)/.test(rel) || /(^|\/)\./.test(rel) || rel === 'package.json') { res.writeHead(404); res.end('not found'); return; }
    fs.stat(file, (err, st) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      if (st.isDirectory()) { res.writeHead(301, { Location: base + pathname + '/' }); res.end(); return; }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': /\.(html|js|css|json)$/.test(ext) ? 'no-cache' : 'public, max-age=3600', 'Last-Modified': st.mtime.toUTCString() });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  async function onRequest(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { return sendJson(res, 400, errBody(400, 'bad_url', 'Malformed URL')); }
    if (base && (pathname === base || pathname.startsWith(base + '/'))) pathname = pathname.slice(base.length) || '/';
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const ip = clientIp(req);
    try {
      if (pathname === '/mcp' || pathname === '/mcp/') await handleMcp(req, res, url, ip);
      else if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname, url, ip);
      else if (o.serveStatic) serveStatic(req, res, pathname);
      else sendJson(res, 404, errBody(404, 'not_found', 'Not found'));
    } finally { log(req.method, pathname, res.statusCode, (Date.now() - started) + 'ms', ip); }
  }
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch(e => {
      log('ERROR', e && e.stack || e);
      if (!res.headersSent) sendJson(res, 500, errBody(500, 'internal', 'Internal server error')); else res.end();
    });
  });
  server.keepAliveTimeout = 65000;
  return {
    server: server, service: service, mcp: mcp, base: base, options: o,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.port, o.host, () => resolve(server.address())); }),
    close: () => new Promise(resolve => { service.stop(); server.close(() => resolve()); })
  };
}

/* ---------------------------------------------------------------- main */
if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const app = createApp({
    port: parseInt(a.port || process.env.PORT || '8772', 10), host: a.host || process.env.HOST || '0.0.0.0',
    dataFile: a.data || process.env.MASTERMIND_DATA || path.join(ROOT, 'server', 'data', 'state.json'),
    basePath: a['base-path'] || process.env.MASTERMIND_BASE_PATH || '', apiKey: a['api-key'] || process.env.MASTERMIND_API_KEY || '',
    allowedOrigins: list(a['allowed-origins'] || process.env.MASTERMIND_ALLOWED_ORIGINS), serveStatic: !a['no-static'], quiet: !!a.quiet,
    publicUrl: a['public-url'] || process.env.MASTERMIND_PUBLIC_URL || ''
  });
  app.listen().then(addr => {
    const host = app.options.host === '0.0.0.0' || app.options.host === '::' ? 'localhost' : app.options.host;
    const url = 'http://' + host + ':' + addr.port + app.base;
    console.log('Mastermind ' + VERSION);
    console.log('  game   ' + url + '/');
    console.log('  api    ' + url + '/api   (OpenAPI: ' + url + '/api/openapi.json)');
    console.log('  mcp    ' + url + '/mcp   (Streamable HTTP; stdio bridge: node server/mcp-stdio.js --url ' + url + '/mcp)');
    console.log('  docs   ' + url + '/docs/mcp.html');
    console.log('  data   ' + (app.options.dataFile || '(memory)') + (app.options.apiKey ? '   auth: bearer key required' : '   auth: none'));
  }).catch(e => { console.error('could not start: ' + e.message); process.exit(1); });
  const stop = () => { app.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { createApp, parseArgs, RateLimiter };
