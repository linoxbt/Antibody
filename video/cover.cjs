const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const V = process.argv[2], OUT = process.argv[3];
const srv = http.createServer((q, r) => { const f = path.join(V, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': { '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  await p.goto(`http://127.0.0.1:${srv.address().port}/cover.html`); await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(300);
  await p.screenshot({ path: OUT }); await b.close(); srv.close();
});
