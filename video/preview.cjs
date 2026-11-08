// Render stills of the compositor at given times (QA).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const V = process.argv[2], OUT = process.argv[3], times = process.argv.slice(4).map(Number);
const T = { '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const srv = http.createServer((q, r) => { const f = path.join(V, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(`window.__TL = ${fs.readFileSync(path.join(V, 'timeline.json'), 'utf8')};`);
  await p.goto(`http://127.0.0.1:${srv.address().port}/stage.html`); await p.waitForFunction(() => window.READY); await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  for (const t of times) { await p.evaluate((t) => window.render(t), t); await p.screenshot({ path: `${OUT}/t${String(t.toFixed(1)).padStart(6, '0')}.png` }); }
  if (errs.length) console.log('ERRORS', errs.slice(0, 5));
  await b.close(); srv.close();
});
