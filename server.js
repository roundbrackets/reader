'use strict';

const express = require('express');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const fetch = require('node-fetch');
const dns = require('dns').promises;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3000;

// ── Puppeteer (lazy singleton) ───────────────────────────────────────────────

let browser = null;
async function getBrowser() {
  if (!browser) {
    const puppeteer = require('puppeteer');
    browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    browser.on('disconnected', () => { browser = null; });
  }
  return browser;
}
const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

app.use(express.static(path.join(__dirname, 'public')));

// ── SSRF protection ──────────────────────────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
];

async function isPrivate(hostname) {
  try {
    const { address } = await dns.lookup(hostname);
    return PRIVATE_RANGES.some(re => re.test(address));
  } catch {
    return true; // treat DNS failure as unreachable
  }
}

function parseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "That doesn't look like a valid URL. Please include http:// or https://." };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Only http and https URLs are supported.' };
  }
  return { parsed };
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.send(homePage());
});

app.get('/read', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.redirect('/');

  const { parsed, error: urlError } = parseUrl(rawUrl);
  if (urlError) return res.send(errorPage(urlError));

  if (await isPrivate(parsed.hostname)) {
    return res.send(errorPage('That address is not reachable.'));
  }

  let response;
  try {
    response = await fetch(parsed.href, {
      timeout: FETCH_TIMEOUT_MS,
      size: MAX_BODY_BYTES,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } catch (err) {
    if (err.type === 'request-timeout') {
      return res.send(errorPage('The request timed out. The site may be slow or unreachable.'));
    }
    return res.send(errorPage('Could not reach that address. Check the URL and try again.'));
  }

  // Check final URL after redirects for SSRF
  if (response.url && response.url !== parsed.href) {
    const { parsed: finalParsed, error: finalError } = parseUrl(response.url);
    if (!finalError && await isPrivate(finalParsed.hostname)) {
      return res.send(errorPage('That address is not reachable.'));
    }
  }

  if (!response.ok) {
    return res.send(
      errorPage(`The page returned an error: ${response.status} ${response.statusText}.`)
    );
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    if (err.type === 'max-size') {
      return res.send(errorPage('The page is too large to load (limit: 5 MB).'));
    }
    return res.send(errorPage('Failed to read the page content.'));
  }

  let article;
  try {
    const dom = new JSDOM(html, { url: response.url || parsed.href });
    article = new Readability(dom.window.document).parse();
  } catch {
    return res.send(errorPage('Could not parse the page content.'));
  }

  if (!article) {
    return res.send(
      errorPage(
        'Could not extract readable content from that page. ' +
          'It may be a homepage, web app, or require a login.'
      )
    );
  }

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; img-src *; font-src 'self';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const rendered = readerPage(article, parsed.href);
  const hash = crypto.createHash('sha256').update(parsed.href).digest('hex');
  fs.writeFile(path.join(CACHE_DIR, hash + '.html'), rendered, () => {});
  res.send(rendered);
});

app.get('/cached/:hash', (req, res) => {
  const hash = req.params.hash.replace(/[^a-f0-9]/g, '');
  const htmlPath = path.join(CACHE_DIR, hash + '.html');
  if (!fs.existsSync(htmlPath)) return res.status(404).send('Not cached');
  res.sendFile(htmlPath);
});

app.get('/refetch', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.redirect('/');

  const { parsed, error } = parseUrl(rawUrl);
  if (error) return res.send(errorPage(error));

  const hash = crypto.createHash('sha256').update(parsed.href).digest('hex');
  const pdfCachePath = path.join(CACHE_DIR, hash + '.pdf');
  if (fs.existsSync(pdfCachePath)) {
    fs.unlink(pdfCachePath, () => {});
    console.log(`[refetch] deleted cached PDF for: ${rawUrl}`);
  }

  // Redirect to /read which re-fetches, re-runs Readability, and overwrites HTML cache
  res.redirect(`/read?url=${encodeURIComponent(rawUrl)}`);
});

app.get('/pdf', async (req, res) => {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) return res.redirect('/');

  const { parsed, error } = parseUrl(rawUrl);
  if (error) return res.send(errorPage(error));

  const hash = crypto.createHash('sha256').update(parsed.href).digest('hex');
  const cachePath = path.join(CACHE_DIR, hash + '.pdf');

  if (fs.existsSync(cachePath)) {
    console.log(`[pdf] cache hit: ${rawUrl}`);
    return res.sendFile(cachePath);
  }

  console.log(`[pdf] generating: ${rawUrl}`);
  const htmlCachePath = path.join(CACHE_DIR, hash + '.html');
  const sourceUrl = fs.existsSync(htmlCachePath)
    ? `http://localhost:${PORT}/cached/${hash}`
    : `http://localhost:${PORT}/read?url=${encodeURIComponent(rawUrl)}`;
  console.log(`[pdf] source: ${fs.existsSync(htmlCachePath) ? 'cached HTML' : 'live fetch'}`);

  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.goto(sourceUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    console.log('[pdf] page loaded, rendering PDF...');
    await page.addStyleTag({ content: '.controls-bar { display: none !important; } .pdf-source { display: block !important; }' });

    const title = await page.title();
    const safeFilename = title.replace(/[^a-z0-9_\- ]/gi, '').trim() || 'article';

    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      printBackground: false,
      path: cachePath,
    });

    console.log(`[pdf] done, saved to cache: ${cachePath}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[pdf] error:', err.message);
    res.send(errorPage('Could not generate PDF: ' + err.message));
  } finally {
    if (page) await page.close();
  }
});

// ── HTML helpers ─────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${body}
</body>
</html>`;
}

function homePage() {
  return layout(
    'Reader',
    `<main class="home">
  <h1>Reader</h1>
  <p class="tagline">Enter a URL to read it in a clean, low-vision friendly format.</p>
  <form action="/read" method="get">
    <label for="url">Web address</label>
    <div class="input-row">
      <input
        type="url"
        id="url"
        name="url"
        placeholder="https://example.com/article"
        required
        autofocus
      >
      <button type="submit">Read</button>
    </div>
  </form>
</main>`
  );
}

function readerPage(article, originalUrl) {
  const title = article.title || 'Article';
  const byline = article.byline
    ? `<p class="byline">${esc(article.byline)}</p>`
    : '';

  return layout(
    title,
    `<div class="controls-bar" id="controls-bar" role="toolbar" aria-label="Reading controls">
  <div class="controls-inner">
    <div class="control-group">
      <label for="fs">Text size</label>
      <input type="range" id="fs" min="14" max="40" step="2" value="20">
      <span class="ctrl-val" id="fs-val">20px</span>
    </div>
    <div class="control-group">
      <label for="lh">Line spacing</label>
      <input type="range" id="lh" min="1.2" max="2.4" step="0.1" value="1.8">
      <span class="ctrl-val" id="lh-val">1.8</span>
    </div>
    <div class="control-group">
      <label for="mg">Margins</label>
      <input type="range" id="mg" min="0" max="15" step="1" value="5">
      <span class="ctrl-val" id="mg-val">5%</span>
    </div>
    <a href="${esc(originalUrl)}" class="ctrl-link" target="_blank" rel="noopener noreferrer">View original</a>
    <a href="/" class="ctrl-link">New URL</a>
    <a href="/pdf?url=${esc(originalUrl)}" class="ctrl-link">Save as PDF</a>
    <a href="/refetch?url=${esc(originalUrl)}" class="ctrl-link ctrl-refetch">Re-fetch</a>
    <button class="ctrl-toggle" id="ctrl-toggle" aria-label="Minimise controls" title="Minimise controls">▲</button>
  </div>
</div>

<main class="reader">
  <article>
    <h1 class="article-title">${esc(title)}</h1>
    ${byline}
    <div class="article-content">${article.content}</div>
    <p class="pdf-source">Source: <a href="${esc(originalUrl)}">${esc(originalUrl)}</a></p>
  </article>
</main>

<script>
  var root = document.documentElement;

  document.getElementById('fs').addEventListener('input', function() {
    root.style.setProperty('--font-size', this.value + 'px');
    document.getElementById('fs-val').textContent = this.value + 'px';
  });

  document.getElementById('lh').addEventListener('input', function() {
    root.style.setProperty('--line-height', this.value);
    document.getElementById('lh-val').textContent = parseFloat(this.value).toFixed(1);
  });

  document.getElementById('mg').addEventListener('input', function() {
    root.style.setProperty('--margin', this.value + '%');
    document.getElementById('mg-val').textContent = this.value + '%';
  });

  var bar = document.getElementById('controls-bar');
  var toggle = document.getElementById('ctrl-toggle');
  toggle.addEventListener('click', function() {
    var minimised = bar.classList.toggle('minimised');
    toggle.textContent = minimised ? '▼' : '▲';
    toggle.setAttribute('aria-label', minimised ? 'Expand controls' : 'Minimise controls');
    toggle.setAttribute('title', minimised ? 'Expand controls' : 'Minimise controls');
  });
</script>`
  );
}

function errorPage(message) {
  return layout(
    'Reader — Error',
    `<main class="home">
  <h1>Reader</h1>
  <p class="error-msg">${esc(message)}</p>
  <a href="/" class="back-link">Try another URL</a>
</main>`
  );
}

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`Reader running at http://localhost:${PORT}`);
  try {
    await getBrowser();
    console.log('[browser] ready');
  } catch (err) {
    console.error('[browser] failed to start:', err.message);
  }
});
