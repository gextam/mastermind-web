/* ============================================================================
   MASTERMIND — canvas renderer: the study table, the walnut decoding board
   with its drilled rows, key-peg clusters and hinged codemaker shield, the
   peg tray, the row marker, drag ghosts and the celebration particles.
   Fixed 1920×1080 scene scaled to the window by CSS.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, Engine = MM.Engine, A = MM.Assets, L = MM.CONFIG.LAYOUT, T = MM.CONFIG.TIMING, STAGE = MM.CONFIG.STAGE;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeOut = u => 1 - Math.pow(1 - u, 3);
  const easeInOut = u => u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
  const backOut = u => { const c = 1.7; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  function Renderer(canvas, game) {
    this.canvas = canvas; this.game = game; this.ctx = canvas.getContext('2d');
    this.dpr = 1; this.layouts = new Map(); this.now = 0; this.ready = false;
    this.resize();
    root.addEventListener('resize', () => this.resize());
  }
  const P = Renderer.prototype;
  P.resize = function () {
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    this.dpr = dpr; this.canvas.width = STAGE.w * dpr; this.canvas.height = STAGE.h * dpr;
    this.canvas.style.width = STAGE.w + 'px'; this.canvas.style.height = STAGE.h + 'px';
    this.wood = null;
  };

  /* ------------------------------------------------------------ layout */
  P.layout = function (cfg) {
    const key = Engine.configKey(cfg) + ':' + cfg.maxGuesses;
    if (this.layouts.has(key)) return this.layouts.get(key);
    const Pn = cfg.pegs, N = cfg.maxGuesses, pad = L.boardPad;
    const rowsAreaH = L.boardBottom - L.boardTop - L.shieldH - pad * 2 - 16;
    const rowPitch = Math.min(L.rowPitchMax, rowsAreaH / N);
    const pegPitch = Math.min(L.pegPitchMax, 330 / Pn);
    const pegR = Math.floor(Math.min(L.pegRadiusMax, rowPitch * 0.41, pegPitch * 0.4));
    const keyR = Math.max(5, Math.round(pegR * 0.33));
    const keyCols = Pn <= 2 ? Pn : Pn <= 4 ? 2 : Pn <= 6 ? 3 : 4, keyRows = Math.ceil(Pn / keyCols), keyPitch = keyR * 2.7;
    const clusterW = keyCols * keyPitch, clusterH = keyRows * keyPitch;
    const numW = 22;
    const bw = pad + numW + Pn * pegPitch + L.keyGap + clusterW + pad;
    const x0 = L.boardCx - bw / 2, y0 = L.boardTop, y1 = L.boardBottom;
    const holesX0 = x0 + pad + numW;
    const rowsTop = y0 + pad + L.shieldH + 16;
    const keyX0 = holesX0 + Pn * pegPitch + L.keyGap;
    const syms = Engine.symbolList(cfg), slotPitch = Math.min(86, (L.trayW - 40) / syms.length), trayW = slotPitch * syms.length + 40;
    const lay = {
      key: key, cfg: cfg, x0: x0, y0: y0, x1: x0 + bw, y1: y1, w: bw, h: y1 - y0, pad: pad, numX: x0 + pad + 4,
      rowPitch: rowPitch, pegPitch: pegPitch, pegR: pegR, keyR: keyR, keyCols: keyCols, keyRows: keyRows, keyPitch: keyPitch, clusterW: clusterW, clusterH: clusterH,
      holesX0: holesX0, rowsTop: rowsTop, keyX0: keyX0,
      rowY: i => rowsTop + (N - 1 - i) * rowPitch + rowPitch / 2,
      holeX: c => holesX0 + c * pegPitch + pegPitch / 2,
      keyPos: (k, rowY) => ({ x: keyX0 + (k % keyCols) * keyPitch + keyPitch / 2, y: rowY - clusterH / 2 + Math.floor(k / keyCols) * keyPitch + keyPitch / 2 }),
      shield: { x: holesX0 - pegPitch * 0.12, y: y0 + pad, w: Pn * pegPitch + pegPitch * 0.24, h: L.shieldH, holeY: y0 + pad + L.shieldH * 0.58 },
      tray: { x: L.boardCx - trayW / 2, y: L.trayY, w: trayW, h: L.trayH, slotPitch: slotPitch, r: Math.min(pegR * 1.12, slotPitch * 0.36), syms: syms, slotX: i => L.boardCx - trayW / 2 + 20 + i * slotPitch + slotPitch / 2, slotY: L.trayY + L.trayH * 0.46 }
    };
    this.layouts.set(key, lay);
    return lay;
  };
  P.currentLayout = function () { return this.game.cfg ? this.layout(this.game.cfg) : this.layout(Engine.normalizeConfig({})); };
  /* what is under a stage coordinate */
  P.hitTest = function (x, y) {
    const lay = this.currentLayout(), g = this.game;
    const tr = lay.tray;
    for (let i = 0; i < tr.syms.length; i++) { if (Math.hypot(x - tr.slotX(i), y - tr.slotY) <= tr.r * 1.35) return { type: 'tray', color: tr.syms[i] }; }
    if (g.cfg) {
      const row = g.state === 'entry' ? -1 : g.rowIndex();
      const cy = row < 0 ? lay.shield.holeY : lay.rowY(row);
      if (Math.abs(y - cy) <= lay.pegR * 1.4) for (let c = 0; c < g.cfg.pegs; c++) if (Math.abs(x - lay.holeX(c)) <= lay.pegPitch / 2) return { type: 'hole', col: c, row: row };
      if (x >= lay.x0 && x <= lay.x1 && y >= lay.rowsTop - lay.rowPitch / 2 && y <= lay.y1) { const r = Math.floor((lay.y1 - lay.pad - y) / lay.rowPitch); return { type: 'row', row: r }; }
    }
    return null;
  };

  /* ---------------------------------------------------------- drawing */
  P.draw = function (now) {
    this.now = now;
    const ctx = this.ctx, g = this.game;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(ctx);
    const lay = this.currentLayout();
    ctx.save();
    if (g.anim.shake > 0) { const s = g.anim.shake; ctx.translate(Math.sin(now * 42) * 7 * s, Math.cos(now * 37) * 3 * s); }
    this.drawBoard(ctx, lay);
    this.drawRows(ctx, lay);
    this.drawShield(ctx, lay);
    this.drawMarker(ctx, lay);
    ctx.restore();
    this.drawTray(ctx, lay);
    this.drawDrag(ctx, lay);
    this.drawFx(ctx);
  };
  P.drawBackground = function (ctx) {
    const img = A.images.table;
    if (img) {
      const s = Math.max(STAGE.w / img.naturalWidth, STAGE.h / img.naturalHeight), w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, (STAGE.w - w) / 2, (STAGE.h - h) / 2, w, h);
    } else { ctx.fillStyle = '#1b3b26'; ctx.fillRect(0, 0, STAGE.w, STAGE.h); }
    const v = ctx.createRadialGradient(760, 420, 300, 960, 540, 1150);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, STAGE.w, STAGE.h);
  };
  P.woodFill = function (ctx, scale) {
    if (!this.wood) { this.wood = A.woodPattern(ctx); try { this.wood.setTransform(new DOMMatrix().scale(0.42)); } catch (e) { /* older browsers */ } }
    return this.wood;
  };
  P.drawBoard = function (ctx, lay) {
    const { x0, y0, w, h } = lay;
    /* shadow on the baize */
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 48; ctx.shadowOffsetX = 14; ctx.shadowOffsetY = 26;
    ctx.fillStyle = '#2a160b'; rr(ctx, x0, y0, w, h, 22); ctx.fill(); ctx.restore();
    /* walnut body */
    ctx.save(); rr(ctx, x0, y0, w, h, 22); ctx.clip();
    ctx.fillStyle = this.woodFill(ctx); ctx.fillRect(x0, y0, w, h);
    const light = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
    light.addColorStop(0, 'rgba(255,220,170,0.18)'); light.addColorStop(0.5, 'rgba(0,0,0,0)'); light.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = light; ctx.fillRect(x0, y0, w, h);
    const sheen = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.35, 'rgba(255,240,210,0.07)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen; ctx.fillRect(x0, y0, w, h);
    ctx.restore();
    /* bevelled edge */
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,225,180,0.32)'; rr(ctx, x0 + 1, y0 + 1, w - 2, h - 2, 21); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; rr(ctx, x0 - 0.5, y0 - 0.5, w + 1, h + 1, 23); ctx.stroke();
    /* routed channel around the guess rows */
    const cx0 = lay.holesX0 - lay.pegPitch * 0.1 - 6, cw = lay.keyX0 + lay.clusterW - cx0 + 8, cy0 = lay.rowsTop - lay.rowPitch * 0.15, ch = lay.y1 - lay.pad - cy0 + 4;
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.42)'; rr(ctx, cx0, cy0, cw, ch, 12); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,225,180,0.22)'; rr(ctx, cx0 + 1.5, cy0 + 1.5, cw, ch, 12); ctx.stroke();
    /* engraved row numbers */
    const N = lay.cfg.maxGuesses;
    ctx.font = Math.max(10, Math.round(lay.pegR * 0.5)) + 'px Georgia, serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) { const y = lay.rowY(i); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(String(i + 1), lay.numX, y + 1); ctx.fillStyle = 'rgba(255,230,190,0.5)'; ctx.fillText(String(i + 1), lay.numX, y); }
  };
  P.drawHole = function (ctx, x, y, r) { const s = A.hole(r); ctx.drawImage(s, x - s.width / 2, y - s.height / 2); };
  P.drawPeg = function (ctx, colorId, x, y, r, t, alpha) {
    let dy = 0, sc = 1, shScale = 1, shAlpha = 1;
    if (t != null) {
      if (t < 0) return;
      if (t < T.drop) { const u = t / T.drop, fall = u * u; dy = -(1 - fall) * 46; shScale = 0.55 + 0.45 * fall; shAlpha = 0.35 + 0.65 * fall; }
      else { const b = t - T.drop; if (b < 0.4) { dy = -Math.abs(Math.sin(b * 24)) * 6 * Math.exp(-b * 8); sc = 1 + 0.07 * Math.exp(-b * 11) * Math.cos(b * 44); } }
    }
    ctx.save(); if (alpha != null) ctx.globalAlpha = alpha;
    const sh = A.shadow(r); ctx.save(); ctx.globalAlpha *= shAlpha * 0.9; ctx.translate(x + 3, y + r * 0.62); ctx.scale(shScale, shScale); ctx.drawImage(sh, -sh.width / 2, -sh.height / 2); ctx.restore();
    const s = A.peg(colorId, r); ctx.translate(x, y + dy); ctx.scale(sc, sc); ctx.drawImage(s, -s.width / 2, -s.height / 2);
    ctx.restore();
  };
  P.drawKey = function (ctx, kind, x, y, r, t) {
    let sc = 1;
    if (t != null) { if (t < 0) return; if (t < 0.24) sc = backOut(t / 0.24); }
    const s = A.keyPeg(kind, r);
    ctx.save(); ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.globalAlpha = 0.5; const sh = A.shadow(r); ctx.drawImage(sh, -sh.width / 2 + 1, -sh.height / 2 + r * 0.5); ctx.globalAlpha = 1;
    ctx.drawImage(s, -s.width / 2, -s.height / 2); ctx.restore();
  };
  P.drawRows = function (ctx, lay) {
    const g = this.game, cfg = lay.cfg, N = cfg.maxGuesses, now = this.now;
    const cur = (g.state === 'playing' || g.state === 'busy' || g.state === 'anim') ? g.rowIndex() : -1;
    for (let i = 0; i < N; i++) {
      const y = lay.rowY(i), row = g.rows[i];
      if (i === cur && g.state !== 'anim') {
        ctx.fillStyle = 'rgba(255,214,140,0.10)'; ctx.strokeStyle = 'rgba(255,214,140,0.35)'; ctx.lineWidth = 1.5;
        rr(ctx, lay.holesX0 - lay.pegPitch * 0.1, y - lay.rowPitch / 2 + 3, lay.keyX0 + lay.clusterW - lay.holesX0 + lay.pegPitch * 0.1 + 4, lay.rowPitch - 6, 10); ctx.fill(); ctx.stroke();
      }
      for (let c = 0; c < cfg.pegs; c++) {
        const x = lay.holeX(c);
        this.drawHole(ctx, x, y, lay.pegR);
        if (row) { const t0 = g.anim.drops.get('r' + i + 'c' + c); this.drawPeg(ctx, row.ids[c], x, y, lay.pegR, t0 != null ? now - t0 : null); }
        else if (i === cur && g.current[c] != null) { const t0 = g.anim.drops.get(c); this.drawPeg(ctx, g.current[c], x, y, lay.pegR, t0 != null ? now - t0 : null); }
        else if (i === cur && g.hover && g.hover.type === 'hole' && g.hover.col === c && g.state === 'playing' && !g.drag) this.drawPeg(ctx, g.selected, x, y, lay.pegR, null, 0.38);
      }
      for (let k = 0; k < cfg.pegs; k++) { const p = lay.keyPos(k, y); this.drawHole(ctx, p.x, p.y, lay.keyR); }
      if (row) {
        const anims = g.anim.keys.filter(a => a.row === i);
        const kinds = []; for (let b = 0; b < row.black; b++) kinds.push('black'); for (let w = 0; w < row.white; w++) kinds.push('white');
        kinds.forEach((kind, k) => { const a = anims.find(z => z.idx === k); const p = lay.keyPos(k, y); this.drawKey(ctx, kind, p.x, p.y, lay.keyR, a ? now - a.t0 : null); });
      }
    }
  };
  P.drawShield = function (ctx, lay) {
    const g = this.game, sh = lay.shield, cfg = lay.cfg, now = this.now;
    /* the secret row's holes and pegs */
    for (let c = 0; c < cfg.pegs; c++) {
      const x = lay.holeX(c); this.drawHole(ctx, x, sh.holeY, lay.pegR);
      if (g.state === 'entry' || g.state === 'busy' && g.mode === 'maker' && !g.view) { if (g.current[c] != null) { const t0 = g.anim.drops.get(c); this.drawPeg(ctx, g.current[c], x, sh.holeY, lay.pegR, t0 != null ? now - t0 : null); } else if (g.state === 'entry' && g.hover && g.hover.type === 'hole' && g.hover.col === c && !g.drag) this.drawPeg(ctx, g.selected, x, sh.holeY, lay.pegR, null, 0.38); }
      else if (g.secret) this.drawPeg(ctx, g.secret[c], x, sh.holeY, lay.pegR, null);
    }
    /* the hinged cover */
    const a = g.anim.shield;
    let u = 0;                                         /* 0 closed, 1 fully open */
    if (a) { const dur = a.instant ? 0.001 : T.shield; const p = clamp((now - a.t0) / dur, 0, 1); u = a.open ? easeInOut(p) : 1 - easeInOut(p); }
    const angle = u * Math.PI * 0.62;                  /* up to ~112° */
    const hingeY = sh.y, x = sh.x, w = sh.w, h = sh.h;
    /* hinge bar */
    const brass = ctx.createLinearGradient(0, hingeY - 5, 0, hingeY + 7);
    brass.addColorStop(0, '#f6dc8a'); brass.addColorStop(0.5, '#b8862a'); brass.addColorStop(1, '#6a4a10');
    ctx.fillStyle = brass; rr(ctx, x - 6, hingeY - 5, w + 12, 11, 4); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; [x + 22, x + w / 2, x + w - 22].forEach(px => { ctx.beginPath(); ctx.arc(px, hingeY + 0.5, 2.6, 0, TAU); ctx.fill(); });
    if (angle < Math.PI / 2) {
      const ph = h * Math.cos(angle), dark = 0.15 + 0.55 * (angle / (Math.PI / 2));
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 18 + 30 * u; ctx.shadowOffsetY = 6 + 24 * u;
      rr(ctx, x, hingeY + 6, w, Math.max(2, ph - 6), 10); ctx.fillStyle = this.woodFill(ctx); ctx.fill(); ctx.restore();
      ctx.save(); rr(ctx, x, hingeY + 6, w, Math.max(2, ph - 6), 10); ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,' + dark + ')'; ctx.fillRect(x, hingeY, w, ph);
      const gl = ctx.createLinearGradient(x, 0, x + w, 0); gl.addColorStop(0, 'rgba(255,230,190,0.16)'); gl.addColorStop(0.5, 'rgba(255,255,255,0)'); gl.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = gl; ctx.fillRect(x, hingeY, w, ph);
      ctx.restore();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,225,180,0.35)'; rr(ctx, x + 1, hingeY + 7, w - 2, Math.max(2, ph - 8), 9); ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; rr(ctx, x, hingeY + 6, w, Math.max(2, ph - 6), 10); ctx.stroke();
      if (u < 0.3) {
        /* brass name plate */
        const pw = Math.min(190, w * 0.6), px = x + w / 2 - pw / 2, py = hingeY + 6 + ph * 0.5 - 13;
        ctx.globalAlpha = 1 - u / 0.3;
        const pb = ctx.createLinearGradient(0, py, 0, py + 26); pb.addColorStop(0, '#f1d684'); pb.addColorStop(0.5, '#c3933a'); pb.addColorStop(1, '#8a6218');
        ctx.fillStyle = pb; rr(ctx, px, py, pw, 26, 5); ctx.fill();
        ctx.strokeStyle = 'rgba(60,35,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#3a2404'; ctx.font = '700 12px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(g.mode === 'maker' ? 'YOUR CODE' : 'CODEMAKER', x + w / 2, py + 13.5);
        ctx.globalAlpha = 1;
      }
    } else {
      /* standing open: the inside face rises above the hinge */
      const rise = h * Math.sin(angle - Math.PI / 2) * 0.55;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 4;
      const inner = ctx.createLinearGradient(0, hingeY - rise, 0, hingeY); inner.addColorStop(0, '#3b2213'); inner.addColorStop(1, '#1d100a');
      ctx.fillStyle = inner; rr(ctx, x + 4, hingeY - rise, w - 8, rise, 6); ctx.fill(); ctx.restore();
    }
  };
  P.drawMarker = function (ctx, lay) {
    const g = this.game, m = g.anim.marker;
    if (!m || g.state === 'idle' || g.state === 'entry' || g.state === 'over') return;
    const u = easeOut(clamp((this.now - m.t0) / 0.45, 0, 1)), row = m.from + (m.to - m.from) * u;
    if (row >= lay.cfg.maxGuesses) return;
    const y = lay.rowsTop + (lay.cfg.maxGuesses - 1 - row) * lay.rowPitch + lay.rowPitch / 2, x = lay.x0 - 14;
    const s = Math.max(9, lay.pegR * 0.42);
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    const grad = ctx.createLinearGradient(x - s * 2, y - s, x, y + s); grad.addColorStop(0, '#f7df8f'); grad.addColorStop(0.5, '#c9962e'); grad.addColorStop(1, '#7a5612');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(x - s * 2.2, y - s); ctx.lineTo(x, y); ctx.lineTo(x - s * 2.2, y + s); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(60,35,0,0.6)'; ctx.lineWidth = 1; ctx.stroke();
  };
  P.drawTray = function (ctx, lay) {
    const g = this.game, tr = lay.tray;
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 16; ctx.fillStyle = '#2a160b'; rr(ctx, tr.x, tr.y, tr.w, tr.h, 18); ctx.fill(); ctx.restore();
    ctx.save(); rr(ctx, tr.x, tr.y, tr.w, tr.h, 18); ctx.clip(); ctx.fillStyle = this.woodFill(ctx); ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
    const gl = ctx.createLinearGradient(tr.x, 0, tr.x + tr.w, 0); gl.addColorStop(0, 'rgba(255,230,190,0.14)'); gl.addColorStop(1, 'rgba(0,0,0,0.3)'); ctx.fillStyle = gl; ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
    ctx.restore();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,225,180,0.3)'; rr(ctx, tr.x + 1, tr.y + 1, tr.w - 2, tr.h - 2, 17); ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; rr(ctx, tr.x - 0.5, tr.y - 0.5, tr.w + 1, tr.h + 1, 19); ctx.stroke();
    ctx.font = '600 11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const editable = g.canEdit();
    tr.syms.forEach((sym, i) => {
      const x = tr.slotX(i), y = tr.slotY, sel = g.selected === sym, hov = g.hover && g.hover.type === 'tray' && g.hover.color === sym;
      /* bowl */
      const bowl = ctx.createRadialGradient(x, y + 2, tr.r * 0.3, x, y, tr.r * 1.45); bowl.addColorStop(0, 'rgba(0,0,0,0.55)'); bowl.addColorStop(0.75, 'rgba(0,0,0,0.3)'); bowl.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bowl; ctx.beginPath(); ctx.arc(x, y, tr.r * 1.45, 0, TAU); ctx.fill();
      if (sel && editable) { ctx.strokeStyle = 'rgba(255,214,120,0.9)'; ctx.lineWidth = 3; ctx.shadowColor = 'rgba(255,200,90,0.8)'; ctx.shadowBlur = 16; ctx.beginPath(); ctx.arc(x, y - 7, tr.r + 8, 0, TAU); ctx.stroke(); ctx.shadowBlur = 0; }
      const lift = sel ? 7 : hov ? 3 : 0;
      this.drawPeg(ctx, sym, x, y - lift, tr.r, null, editable ? 1 : 0.55);
      const s = Engine.symbol(sym), label = (sym === 0 ? '0' : String(sym % 10)) + ' · ' + s.letter;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(label, x, tr.y + tr.h - 15); ctx.fillStyle = sel ? '#ffe4a0' : 'rgba(255,235,200,0.75)'; ctx.fillText(label, x, tr.y + tr.h - 16);
    });
  };
  P.drawDrag = function (ctx, lay) {
    const d = this.game.drag; if (!d) return;
    const r = lay.pegR * 1.1;
    ctx.save(); ctx.globalAlpha = 0.95; this.drawPeg(ctx, d.color, d.x, d.y - 12, r, null); ctx.restore();
  };
  P.drawFx = function (ctx) {
    const fx = this.game.fx; if (!fx.length) return;
    ctx.save();
    fx.forEach(p => {
      const u = p.t / p.life;
      if (p.type === 'confetti') {
        ctx.save(); ctx.globalAlpha = u > 0.8 ? (1 - u) / 0.2 : 1; ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.fillStyle = p.color; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.t * 9)));
        ctx.restore();
      } else {
        ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.max(0, 1 - u); ctx.translate(p.x, p.y); ctx.rotate(p.rot + p.t * 5);
        ctx.fillStyle = '#ffe9a0'; const s = p.size * (1 - u * 0.5); ctx.beginPath();
        for (let i = 0; i < 8; i++) { const rad = i % 2 ? s * 0.35 : s, an = i * Math.PI / 4; ctx.lineTo(Math.cos(an) * rad, Math.sin(an) * rad); }
        ctx.closePath(); ctx.fill(); ctx.restore();
      }
    });
    ctx.restore();
  };
  MM.Renderer = Renderer;
})(window);
