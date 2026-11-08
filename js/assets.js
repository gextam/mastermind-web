/* ============================================================================
   MASTERMIND — assets: image loading and the pre-rendered sprites (glossy code
   pegs, key pegs, holes, empty-slot rings), cached per colour and size.
   ========================================================================== */
(function (root) {
  'use strict';
  const MM = root.MM, Engine = MM.Engine;
  const cache = new Map();
  const images = {};
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }
  const rgb = c => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  const rgba = (c, a) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; }
  function cached(key, make) { let c = cache.get(key); if (!c) { c = make(); cache.set(key, c); } return c; }

  function load(map) {
    const keys = Object.keys(map);
    return Promise.all(keys.map(k => new Promise(resolve => {
      const img = new Image();
      img.onload = () => { images[k] = img; resolve(); };
      img.onerror = () => { images[k] = null; resolve(); };
      img.src = map[k];
    })));
  }

  /* a glossy plastic sphere: body gradient lit from the upper left, ambient
     occlusion at the rim, a soft rim light bottom-right, two specular highlights */
  function sphere(base, r, opts) {
    opts = opts || {};
    const pad = 3, size = r * 2 + pad * 2, c = canvas(size, size), ctx = c.getContext('2d'), cx = r + pad, cy = r + pad;
    const light = mix(base, [255, 255, 255], opts.lightMix == null ? 0.55 : opts.lightMix), dark = mix(base, [0, 0, 0], 0.55), darker = mix(base, [0, 0, 0], 0.78);
    const body = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.08, cx, cy, r * 1.05);
    body.addColorStop(0, rgb(light)); body.addColorStop(0.28, rgb(mix(base, light, 0.35))); body.addColorStop(0.7, rgb(base)); body.addColorStop(0.92, rgb(dark)); body.addColorStop(1, rgb(darker));
    ctx.fillStyle = body; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    /* rim light */
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    const rim = ctx.createRadialGradient(cx + r * 0.35, cy + r * 0.45, r * 0.55, cx + r * 0.3, cy + r * 0.4, r * 1.05);
    rim.addColorStop(0, 'rgba(255,255,255,0)'); rim.addColorStop(0.8, 'rgba(255,255,255,0)'); rim.addColorStop(1, 'rgba(255,255,255,' + (opts.rim == null ? 0.22 : opts.rim) + ')');
    ctx.fillStyle = rim; ctx.fillRect(0, 0, size, size);
    ctx.restore();
    /* main specular */
    const spec = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.44, 0, cx - r * 0.36, cy - r * 0.44, r * 0.42);
    spec.addColorStop(0, 'rgba(255,255,255,' + (opts.spec == null ? 0.95 : opts.spec) + ')'); spec.addColorStop(0.35, 'rgba(255,255,255,0.45)'); spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec; ctx.beginPath(); ctx.ellipse(cx - r * 0.36, cy - r * 0.44, r * 0.42, r * 0.3, -0.6, 0, Math.PI * 2); ctx.fill();
    /* small secondary speck */
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(cx + r * 0.22, cy - r * 0.58, r * 0.1, r * 0.06, 0.5, 0, Math.PI * 2); ctx.fill();
    /* thin dark edge for definition */
    ctx.strokeStyle = rgba(darker, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2); ctx.stroke();
    return c;
  }
  function peg(colorId, r) {
    r = Math.round(r);
    return cached('peg:' + colorId + ':' + r, () => {
      const sym = Engine.symbol(colorId);
      if (colorId === 0) return ring(r);
      const base = hexToRgb(sym.hex);
      const white = colorId === 7, black = colorId === 8;
      return sphere(base, r, { lightMix: white ? 0.2 : black ? 0.35 : 0.55, spec: white ? 1 : 0.95, rim: black ? 0.35 : 0.22 });
    });
  }
  function keyPeg(kind, r) {
    r = Math.round(r);
    return cached('key:' + kind + ':' + r, () => kind === 'black' ? sphere([24, 22, 26], r, { lightMix: 0.4, rim: 0.4, spec: 0.8 }) : sphere([244, 240, 228], r, { lightMix: 0.25, rim: 0.15, spec: 1 }));
  }
  /* the empty-symbol marker: a hollow dark ring */
  function ring(r) {
    const pad = 3, size = r * 2 + pad * 2, c = canvas(size, size), ctx = c.getContext('2d'), cx = r + pad, cy = r + pad;
    ctx.strokeStyle = 'rgba(230,220,200,0.85)'; ctx.lineWidth = Math.max(2, r * 0.22); ctx.setLineDash([r * 0.5, r * 0.3]);
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2); ctx.stroke();
    return c;
  }
  /* a drilled hole in the board: dark recess with a bevelled lip */
  function hole(r) {
    r = Math.round(r);
    return cached('hole:' + r, () => {
      const pad = 4, size = r * 2 + pad * 2, c = canvas(size, size), ctx = c.getContext('2d'), cx = r + pad, cy = r + pad;
      const lip = ctx.createRadialGradient(cx, cy, r * 0.8, cx, cy, r * 1.15);
      lip.addColorStop(0, 'rgba(0,0,0,0)'); lip.addColorStop(0.55, 'rgba(0,0,0,0.35)'); lip.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lip; ctx.fillRect(0, 0, size, size);
      const g = ctx.createRadialGradient(cx + r * 0.2, cy + r * 0.25, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#2a1d14'); g.addColorStop(0.6, '#140d08'); g.addColorStop(1, '#070403');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      /* inner shadow from the upper-left edge */
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(cx - r * 0.18, cy - r * 0.2, r, 0, Math.PI * 2); ctx.arc(cx + r * 0.1, cy + r * 0.1, r * 0.92, 0, Math.PI * 2, true); ctx.fill();
      ctx.restore();
      /* lit lower-right lip */
      ctx.strokeStyle = 'rgba(255,220,170,0.28)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, r + 0.5, 0.15 * Math.PI, 0.6 * Math.PI); ctx.stroke();
      return c;
    });
  }
  /* soft elliptical shadow under a peg */
  function shadow(r) {
    r = Math.round(r);
    return cached('shadow:' + r, () => {
      const w = r * 2.6, h = r * 1.4, c = canvas(w, h), ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r * 1.2);
      g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.save(); ctx.translate(w / 2, h / 2); ctx.scale(1, h / w); ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      return c;
    });
  }
  function woodPattern(ctx) {
    return cached('wood', () => {
      const img = images.walnut;
      if (img) return ctx.createPattern(img, 'repeat');
      const c = canvas(256, 256), x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 256, 0);
      for (let i = 0; i <= 16; i++) g.addColorStop(i / 16, i % 2 ? '#5a2f17' : '#6b3a1e');
      x.fillStyle = g; x.fillRect(0, 0, 256, 256);
      return ctx.createPattern(c, 'repeat');
    });
  }
  MM.Assets = { images: images, load: load, peg: peg, keyPeg: keyPeg, hole: hole, shadow: shadow, woodPattern: woodPattern, hexToRgb: hexToRgb, mix: mix, rgba: rgba, cache: cache };
})(window);
