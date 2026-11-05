/**
 * The blog post as a page on the site: docs/blog.md → web/blog.html, in the
 * same layout as the other docs pages (clean URL /blog). Run after editing the
 * post; build-site runs it too, so the published page never drifts.
 *
 *   npx tsx scripts/render-blog.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Marked } from 'marked';

export function renderBlog(md: string): string {
  const title = /^# (.+)$/m.exec(md)?.[1] ?? 'Antibody';
  const body = md.replace(/^# .+\n/, '');
  const slug = (t: string) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const toc: { id: string; text: string }[] = [];
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slug(text);
        if (depth === 2) toc.push({ id, text: text.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}">${text}</h${depth}>\n`;
      },
      link({ href, title: t, tokens }) {
        const text = this.parser.parseInline(tokens);
        const ext = /^https?:/.test(href);
        return `<a href="${href}"${t ? ` title="${t}"` : ''}${ext ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
      },
      table(token) {
        // Wide tables scroll inside their own box on phones (and can be reached by keyboard).
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
        const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('\n');
        return `<div class="table-wrap" tabindex="0"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
      },
    },
  });
  const html = marked.parse(body, { async: false }) as string;
  const plain = title.replace(/[*_`]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${plain} · Antibody</title>
  <meta name="description" content="How Antibody protects an AI agent's memory on Walrus, uses Tatum's Sui gateway, learns from every attack, and ran on Sui mainnet." />
  <meta property="og:title" content="${plain}" />
  <meta property="og:type" content="article" />
  <meta name="theme-color" content="#030407" />
  <script src="/assets/js/theme-init.js"></script>
  <link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/assets/img/apple-touch-icon.png" />
  <link rel="preload" href="/assets/fonts/dm-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="/assets/css/brand.css" />
  <link rel="stylesheet" href="/assets/css/docs.css" />
</head>
<body data-page="blog">
  <div class="app-bg" aria-hidden="true"></div>
  <main class="wrap">
    <div class="page-head">
      <div><span class="eyebrow">Blog <b>· Total Recall</b></span><h1 class="words">${title.replace(/\.$/, '')}<span class="tail">.</span></h1></div>
    </div>
    <div class="docs">
      <nav class="toc" aria-label="On this page">
${toc.map((t) => `        <a href="#${t.id}">${t.text}</a>`).join('\n')}
      </nav>
      <article class="doc blog">
${html}
      </article>
    </div>
  </main>
  <script type="module" src="/assets/js/pages/static.js"></script>
</body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync('web/blog.html', renderBlog(readFileSync('docs/blog.md', 'utf8')));
  console.log('web/blog.html written from docs/blog.md');
}
