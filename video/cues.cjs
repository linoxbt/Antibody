const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), http = require('http');
const V = process.argv[2];
const srv = http.createServer((q, r) => { const f = path.join(V, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.addInitScript(`window.__TL = ${fs.readFileSync(path.join(V, 'timeline.json'), 'utf8')};`);
  await p.goto(`http://127.0.0.1:${srv.address().port}/stage.html`); await p.waitForFunction(() => window.READY);
  fs.writeFileSync(path.join(V, 'cues.json'), JSON.stringify(await p.evaluate(() => window.CUES)));
  await b.close(); srv.close();
});
