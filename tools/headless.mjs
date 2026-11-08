/* ============================================================================
   tools/headless.mjs — shared headless-Chrome helpers for the tools: find a
   Chrome/Edge binary, launch it with remote debugging, a tiny CDP client and
   a static file server. Node 22+ (global fetch + WebSocket), no dependencies.
   ========================================================================== */
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs, existsSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const wait = ms => new Promise(r => setTimeout(r, ms));
function which(cmd) { try { execSync((process.platform === 'win32' ? 'where ' : 'which ') + cmd, { stdio: 'ignore' }); return true; } catch { return false; } }
export function findChrome(explicit) {
  if (explicit) return explicit;
  const env = process.env, pf = env.PROGRAMFILES || 'C:\\Program Files', pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const c = process.platform === 'win32'
    ? [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const x of c) if (x.includes(path.sep) ? existsSync(x) : which(x)) return x;
  throw new Error('No Chrome/Edge found. Pass --chrome=<path>');
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.json': 'application/json', '.svg': 'image/svg+xml' };
export function serveStatic(root) {
  return new Promise(resolve => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(root, p));
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>404</title>not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
      else if (msg.method) this.listeners.forEach(l => l(msg));
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  on(fn) { this.listeners.push(fn); }
  once(method, timeout = 15000) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.listeners = this.listeners.filter(x => x !== l); resolve(null); }, timeout);
      const l = msg => { if (msg.method === method) { clearTimeout(timer); this.listeners = this.listeners.filter(x => x !== l); resolve(msg.params); } };
      this.listeners.push(l);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}
const wsOpen = url => new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.addEventListener('open', () => resolve(ws)); ws.addEventListener('error', () => reject(new Error('websocket error'))); });
async function fetchJson(url, tries = 60) { for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { /* retry */ } await wait(250); } throw new Error('browser did not answer at ' + url); }

/* launch Chrome headless, return { page (CDP), close() } */
export async function launch(opts = {}) {
  const chrome = findChrome(opts.chrome);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), opts.prefix || 'mm-headless-'));
  const debugPort = 9222 + Math.floor(Math.random() * 400);
  const W = opts.width || 1600, H = opts.height || 900;
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
  const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = new CDP(await wsOpen(targets.find(t => t.type === 'page').webSocketDebuggerUrl));
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: opts.scale || 1, mobile: false });
  return {
    page, chrome,
    async goto(url) { const loaded = page.once('Page.loadEventFired'); await page.send('Page.navigate', { url }); await loaded; },
    async close() { page.close(); proc.kill(); await wait(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); }
  };
}
