import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { chromium } from 'playwright';
const ROOT = path.dirname(fileURLToPath(import.meta.url)); const SRC = path.join(ROOT, 'src');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = http.createServer((req, res) => { let u = req.url.split('?')[0]; if (u === '/') u = '/index.html'; const f = path.join(SRC, u); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise(r => server.listen(0, r)); const BASE = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage(); await p.goto(`${BASE}/?r=webgl`); await p.waitForFunction(() => window.__ready === true);
const rows = await p.evaluate(() => {
  window.__trace = [];
  window.__game.reset(); window.__game.autopilot(true); window.__rec.begin();
  for (let i = 0; i < 130; i++) window.__rec.step(1);
  // show every frame where a jump was decided, plus context around the first one
  const t = window.__trace;
  const jumps = t.filter(r => r.J === 1).map(r => `JUMP f${r.f} x${r.x} g${r.g} gA${r.gA} bR${r.bR} eA${r.eA}`);
  return { jumpFrames: jumps.slice(0, 8), firstJumpContext: t.slice(0, 70).map(r => `f${r.f} x${r.x} g${r.g} gA${r.gA} bR${r.bR} eA${r.eA} J${r.J}`) };
});
console.log('JUMPS:', JSON.stringify(rows.jumpFrames, null, 1));
console.log('CONTEXT:\n' + rows.firstJumpContext.join('\n'));
console.log(rows.join('\n'));
await b.close(); server.close();
