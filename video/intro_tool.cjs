// intro.html: `stills <out> t...` | `cues` | `render <out.mp4> <from> <to>` (frames at 30 fps)
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path');
const V = process.argv[2], mode = process.argv[3], args = process.argv.slice(4);
const T = { '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { const f = path.join(V, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${srv.address().port}/intro.html`); await p.waitForFunction(() => window.READY); await p.evaluate(() => document.fonts.ready);
  if (mode === 'cues') fs.writeFileSync(path.join(V, 'intro_cues.json'), JSON.stringify(await p.evaluate(() => window.CUES)));
  if (mode === 'stills') for (const t of args.slice(1).map(Number)) { await p.evaluate((t) => window.render(t), t); await p.screenshot({ path: `${args[0]}/i${t.toFixed(2).padStart(6, '0')}.png` }); }
  if (mode === 'render') {
    const [out, from, to] = [args[0], +args[1], +args[2]];
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let f = from; f < to; f++) { await p.evaluate((t) => window.render(t), f / 30); const buf = await p.screenshot({ type: 'jpeg', quality: 95 }); if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r)); }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  }
  if (errs.length) console.log('ERRORS', errs.slice(0, 5));
  await b.close(); srv.close();
});
