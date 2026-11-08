/* ============================================================================
   MASTERMIND server — persistence. Live games and finished-game records in a
   single JSON file, written atomically and debounced. Pass no file for an
   in-memory store (tests).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

class Store {
  constructor(file, opts) {
    opts = opts || {};
    this.file = file || null;
    this.games = new Map();
    this.records = [];
    this.dirty = false;
    this.timer = null;
    this.maxRecords = opts.maxRecords || 20000;
    this.saveDelay = opts.saveDelay || 250;
  }
  load() {
    if (!this.file || !fs.existsSync(this.file)) return this;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      (j.games || []).forEach(g => this.games.set(g.id, g));
      this.records = Array.isArray(j.records) ? j.records : [];
    } catch (e) { console.error('[store] could not read ' + this.file + ': ' + e.message); }
    return this;
  }
  putGame(g) { this.games.set(g.id, g); this.touch(); }
  getGame(id) { return this.games.get(id) || null; }
  deleteGame(id) { if (this.games.delete(id)) this.touch(); }
  listGames() { return Array.from(this.games.values()); }
  addRecord(r) {
    this.records.push(r);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    this.touch();
  }
  findRecord(id) { for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i].game_id === id) return this.records[i]; return null; }
  touch() {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.saveDelay);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, saved_at: new Date().toISOString(), games: Array.from(this.games.values()), records: this.records }));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('[store] could not write ' + this.file + ': ' + e.message); }
  }
  /* drop finished games after keepFinishedMs and abandoned games after idleMs (records are kept) */
  prune(now, opts) {
    let n = 0;
    for (const [id, g] of this.games) {
      const age = now - (g.updatedAt || g.createdAt);
      if ((g.status !== 'playing' && age > opts.keepFinishedMs) || (g.status === 'playing' && age > opts.idleMs)) { this.games.delete(id); n++; }
    }
    if (n) this.touch();
    return n;
  }
}
module.exports = Store;
