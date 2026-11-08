/* ============================================================================
   tools/mcp-client.js — a minimal MCP client over Streamable HTTP, used by
   the API tests and the demo player. Node 20+ (global fetch), no deps.
   ========================================================================== */
'use strict';

class McpClient {
  constructor(url, opts) {
    opts = opts || {};
    this.url = url; this.apiKey = opts.apiKey || ''; this.nextId = 1; this.protocolVersion = opts.protocolVersion || '2025-06-18';
    this.serverInfo = null; this.lastStatus = 0;
  }
  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocolVersion };
    if (this.apiKey) h.Authorization = 'Bearer ' + this.apiKey;
    return h;
  }
  async raw(payload, extraHeaders) {
    const r = await fetch(this.url, { method: 'POST', headers: Object.assign(this.headers(), extraHeaders || {}), body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
    this.lastStatus = r.status;
    const text = await r.text();
    const ct = r.headers.get('content-type') || '';
    let body = null;
    if (/text\/event-stream/.test(ct)) {
      const msgs = text.split(/\n\n/).map(b => b.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')).filter(Boolean).map(s => JSON.parse(s));
      body = msgs.length === 1 ? msgs[0] : msgs;
    } else if (text.trim()) { try { body = JSON.parse(text); } catch (e) { body = text; } }
    return { status: r.status, headers: r.headers, body: body };
  }
  async rpc(method, params) {
    const id = this.nextId++;
    const res = await this.raw({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    const msg = res.body;
    if (!msg || typeof msg !== 'object') { const e = new Error('HTTP ' + res.status + ' with no JSON-RPC response'); e.status = res.status; throw e; }
    if (msg.error) { const e = new Error(msg.error.message); e.rpc = msg.error; e.code = msg.error.code; throw e; }
    return msg.result;
  }
  async notify(method, params) { return this.raw({ jsonrpc: '2.0', method: method, params: params || {} }); }
  async initialize(clientInfo) {
    const r = await this.rpc('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: clientInfo || { name: 'mastermind-demo-client', version: '1.0.0' } });
    this.serverInfo = r.serverInfo; this.protocolVersion = r.protocolVersion;
    await this.notify('notifications/initialized');
    return r;
  }
  async listTools() { return (await this.rpc('tools/list')).tools; }
  /* call a tool; returns structuredContent (or parsed text); throws when the tool reports isError */
  async call(name, args) {
    const r = await this.rpc('tools/call', { name: name, arguments: args || {} });
    const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (r.isError) { const e = new Error(text || 'tool error'); e.toolError = true; e.result = r; throw e; }
    if (r.structuredContent !== undefined) return r.structuredContent;
    try { return JSON.parse(text); } catch (e) { return text; }
  }
}
module.exports = { McpClient };
