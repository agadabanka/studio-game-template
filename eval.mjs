/*
 * Shared Studio eval — proves a game is AI-evaluable & shippable.
 * Per renderer (webgl + canvas), on FRESH pages:
 *   determinism (two identical 700-step runs) · 0-death gate · non-black readback.
 * Writes out/scorecard.json + out/shot-<renderer>.png and exits non-zero on failure.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'out');
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/index.html';
  const f = path.join(SRC, u);
  if (!f.startsWith(SRC) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function fresh(r) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${BASE}/?r=${r}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 20000 });
  page._errs = errors;
  return page;
}
async function evalRenderer(r) {
  const p1 = await fresh(r); const s1 = await p1.evaluate(() => window.__run(700)); await p1.close();
  const p2 = await fresh(r); const s2 = await p2.evaluate(() => window.__run(700)); await p2.close();
  const detKeys = ['x', 'y', 'vx', 'vy', 'frame', 'deaths', 'won', 'coins'];
  const deterministic = detKeys.every(k => s1[k] === s2[k]);

  const pg = await fresh(r); const gate = await pg.evaluate(() => window.__gate(3000)); await pg.close();

  const ps = await fresh(r);
  await ps.evaluate(() => window.__run(200));
  const readback = await ps.evaluate(() => {
    const c = document.querySelector('canvas'); const off = document.createElement('canvas'); off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d');
    try { ctx.drawImage(c, 0, 0); const d = ctx.getImageData(0, 0, off.width, off.height).data; let nb = 0; const tot = d.length / 4;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) nb++; return { nonblackRatio: +(nb / tot).toFixed(4) }; }
    catch (e) { return { err: String(e) }; }
  });
  await ps.screenshot({ path: path.join(OUT, `shot-${r}.png`) });
  const errs = ps._errs.slice(0, 6); await ps.close();
  return { renderer: r, deterministic, det: { s1, s2 }, gate, readback, errors: errs };
}

const results = {};
for (const r of ['webgl', 'canvas']) { try { results[r] = await evalRenderer(r); } catch (e) { results[r] = { renderer: r, fatal: String(e) }; } }
await browser.close(); server.close();
const ok = x => !!(x && x.deterministic && x.gate && x.gate.won && x.gate.deaths === 0 && x.readback && x.readback.nonblackRatio > 0.02);
const verdict = { webgl: ok(results.webgl), canvas: ok(results.canvas) };
fs.writeFileSync(path.join(OUT, 'scorecard.json'), JSON.stringify({ verdict, results }, null, 2));
console.log(JSON.stringify({ verdict, results }, null, 2));
process.exit((verdict.webgl || verdict.canvas) ? 0 : 1);
