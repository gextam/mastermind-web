#!/usr/bin/env node
/* ============================================================================
   tools/prep-assets.mjs — prepare the generated art without image libraries:
   headless Chrome loads the PNGs, trims the logo to its alpha bounding box,
   re-encodes the opaque pictures as JPEG and writes the results back.
   usage: node tools/prep-assets.mjs
   ========================================================================== */
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serveStatic } from './headless.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOBS = [
  { src: 'assets/logo.png', out: 'assets/logo.png', type: 'image/png', trim: true, maxW: 1100 },
  { src: 'assets/bg/table.png', out: 'assets/bg/table.jpg', type: 'image/jpeg', quality: 0.9, remove: true },
  { src: 'assets/walnut.png', out: 'assets/walnut.jpg', type: 'image/jpeg', quality: 0.92, remove: true }
];

async function main() {
  const srv = await serveStatic(ROOT);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await launch({ width: 800, height: 600, prefix: 'mm-prep-' });
  try {
    await browser.goto(base + '/tools/');
    for (const job of JOBS) {
      if (!existsSync(path.join(ROOT, job.src))) { console.log('skip ' + job.src + ' (missing)'); continue; }
      const result = await browser.page.eval(`(async () => {
        const img = new Image(); img.src = ${JSON.stringify(base + '/' + job.src)};
        await img.decode();
        let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight, opaque = true;
        const c = document.createElement('canvas'); c.width = sw; c.height = sh;
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
        if (${job.trim ? 'true' : 'false'}) {
          const d = ctx.getImageData(0, 0, sw, sh).data; let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
          for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const a = d[(y * sw + x) * 4 + 3]; if (a > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
          opaque = !(x1 >= 0 && (x0 > 0 || y0 > 0 || x1 < sw - 1 || y1 < sh - 1));
          if (!opaque) { const m = 12; sx = Math.max(0, x0 - m); sy = Math.max(0, y0 - m); sw = Math.min(img.naturalWidth, x1 + m) - sx; sh = Math.min(img.naturalHeight, y1 + m) - sy; }
        }
        const scale = Math.min(1, ${job.maxW || 99999} / sw);
        const o = document.createElement('canvas'); o.width = Math.round(sw * scale); o.height = Math.round(sh * scale);
        const octx = o.getContext('2d'); octx.imageSmoothingQuality = 'high'; octx.drawImage(img, sx, sy, sw, sh, 0, 0, o.width, o.height);
        return { w: o.width, h: o.height, opaque, data: o.toDataURL(${JSON.stringify(job.type)}, ${job.quality || 0.92}) };
      })()`);
      const buf = Buffer.from(result.data.split(',')[1], 'base64');
      await fs.writeFile(path.join(ROOT, job.out), buf);
      if (job.remove && job.out !== job.src) await fs.rm(path.join(ROOT, job.src), { force: true });
      console.log(job.out.padEnd(24) + result.w + 'x' + result.h + '  ' + (buf.length / 1024).toFixed(0) + ' KB' + (job.trim ? (result.opaque ? '  (opaque: not trimmed)' : '  (trimmed to alpha bounds)') : ''));
    }
  } finally { await browser.close(); srv.close(); }
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
