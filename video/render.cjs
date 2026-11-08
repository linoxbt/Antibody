// Deterministic frame render: each worker renders frames [from, to) to its own MP4 segment.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), path = require('path');
const [V, OUT, from, to] = [process.argv[2], process.argv[3], +process.argv[4], +process.argv[5]];
const T = { '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const srv = http.createServer((q, r) => { const f = path.join(V, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const tl = JSON.parse(fs.readFileSync(path.join(V, 'timeline.json'), 'utf8'));
  const fps = tl.fps;
  const b = await chromium.launch({ args: ['--disable-gpu-vsync', '--force-color-profile=srgb'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.addInitScript(`window.__TL = ${JSON.stringify(tl)};`);
  await p.goto(`http://127.0.0.1:${srv.address().port}/stage.html`); await p.waitForFunction(() => window.READY); await p.evaluate(() => document.fonts.ready);
  // warm every screenshot so no frame catches an image mid-decode
  await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(fps), OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let f = from; f < to; f++) {
    await p.evaluate((t) => window.render(t), f / fps);
    const buf = await p.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if ((f - from) % 300 === 0) console.log(`${path.basename(OUT)} frame ${f} (${((Date.now() - t0) / Math.max(1, f - from + 1)).toFixed(0)} ms/frame)`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  await b.close(); srv.close();
});
