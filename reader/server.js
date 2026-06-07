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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ]
    });
    browser.on('disconnected', () => { browser = null; });
  }
  return browser;
}
const FETCH_TIMEOUT_MS = 60000;
const MAX_BODY_BYTES = 20 * 1024 * 1024; // 20 MB

// ── Font-based cipher decoding ───────────────────────────────────────────────
//
// Some sites (e.g. chrysanthemumgarden.com) obfuscate text using custom woff2
// fonts as cipher keys. Encoded text is placed in spans with a random
// font-family name; the font renders each encoded glyph as the correct visual
// character, so real browsers render it fine but scrapers see gibberish.
//
// The woff2 fonts have no PostScript glyph names. We decode by comparing glyph
// paths (bezier curves) between the cipher font and the page's real fonts.
// The cipher was built by copying glyphs from a page font into a scrambled
// code point mapping, so the paths are identical — an exact match gives the
// decoded character.
//
// Flow (Puppeteer path only):
//   1. After page loads, do one fast page.evaluate() to collect all woff2 URLs
//      (cipher and reference) using the Performance API — works cross-origin.
//   2. Close the site's page immediately.
//   3. Download both sets of fonts in Node.js and compare glyph paths via fontkit.
//   4. Apply the resulting maps to the HTML before passing to Readability.
//
// Also strips hidden "garbage" spans (height:1px, width:0).

// Collect all woff2 URLs the browser loaded (cipher + reference).
// Uses the Performance API which works cross-origin, avoiding CORS issues with
// external stylesheets. Cipher @font-face rules (inline CSS) also give us the
// family→URL mapping needed to label the results.
async function extractFontUrlsFromPage(page) {
  return page.evaluate(() => {
    const CIPHER_NAME = /^[a-zA-Z]{8,12}$/;

    // Get cipher family→URL from inline @font-face rules (same-origin, always works)
    const cipherFonts = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (!(rule instanceof CSSFontFaceRule)) continue;
          const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
          if (!CIPHER_NAME.test(family)) continue;
          const src = rule.style.getPropertyValue('src') || '';
          const m = src.match(/url\(['"]?([^'")\s]+\.woff2[^'")\s]*)['"]?\)/);
          if (m) cipherFonts.push({ family, url: m[1] });
        }
      } catch (_) {}
    }

    // Get ALL woff2 URLs actually downloaded by the browser (cross-origin safe)
    const allLoaded = performance.getEntriesByType('resource')
      .filter(r => r.name.includes('.woff2'))
      .map(r => r.name);

    // Reference fonts = loaded woff2s that are not cipher fonts
    const cipherUrls = new Set(cipherFonts.map(f => f.url));
    const refUrls = allLoaded.filter(url => !cipherUrls.has(url));

    return { cipherFonts, refUrls };
  });
}

// Build cipher maps by comparing glyph paths between cipher and reference fonts.
// The cipher font glyphs are identical copies of glyphs from a reference font,
// just at different code points — so path comparison is exact.
const glyphPathCache = new Map(); // url → { letter: fingerprint }

async function buildFontCipherMapsFromPaths(fontUrls) {
  if (!fontUrls || fontUrls.cipherFonts.length === 0 || fontUrls.refUrls.length === 0) return null;

  const fontkit = require('fontkit');
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function glyphFingerprint(glyph, unitsPerEm) {
    try {
      const cmds = glyph.path.commands;
      if (!cmds || cmds.length === 0) return null;
      const s = 1000 / unitsPerEm;
      return cmds.map(c => {
        switch (c.command) {
          case 'moveTo':           return `M${Math.round(c.x*s)},${Math.round(c.y*s)}`;
          case 'lineTo':           return `L${Math.round(c.x*s)},${Math.round(c.y*s)}`;
          case 'bezierCurveTo':    return `C${Math.round(c.x1*s)},${Math.round(c.y1*s)},${Math.round(c.x2*s)},${Math.round(c.y2*s)},${Math.round(c.x*s)},${Math.round(c.y*s)}`;
          case 'quadraticCurveTo': return `Q${Math.round(c.x1*s)},${Math.round(c.y1*s)},${Math.round(c.x*s)},${Math.round(c.y*s)}`;
          case 'closePath':        return 'Z';
          default:                 return c.command;
        }
      }).join('');
    } catch (_) { return null; }
  }

  async function downloadAndParse(url) {
    const resp = await fetch(url, { timeout: 10000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return fontkit.create(await resp.buffer());
  }

  // Build reference fingerprint table: path_string → letter
  const refFingerprints = new Map();
  for (const url of fontUrls.refUrls) {
    try {
      const font = await downloadAndParse(url);
      let added = 0;
      for (const ch of letters) {
        const glyph = font.glyphForCodePoint(ch.charCodeAt(0));
        if (!glyph || glyph.id === 0) continue;
        const fp = glyphFingerprint(glyph, font.unitsPerEm);
        if (fp && !refFingerprints.has(fp)) { refFingerprints.set(fp, ch); added++; }
      }
      console.log(`[cipher] ref font ${url.split('/').pop()}: ${added} glyphs indexed`);
    } catch (e) {
      console.error(`[cipher] ref font error (${url.split('/').pop()}): ${e.message}`);
    }
  }

  if (refFingerprints.size === 0) return null;

  // Match each cipher font's glyphs to the reference fingerprints
  const maps = {};
  for (const { family, url } of fontUrls.cipherFonts) {
    try {
      const font = await downloadAndParse(url);
      const map = {};
      for (const ch of letters) {
        const glyph = font.glyphForCodePoint(ch.charCodeAt(0));
        if (!glyph || glyph.id === 0) continue;
        const fp = glyphFingerprint(glyph, font.unitsPerEm);
        if (fp) {
          const decoded = refFingerprints.get(fp);
          if (decoded) map[ch] = decoded;
        }
      }
      console.log(`[cipher] ${family}: ${Object.keys(map).length} chars mapped via path comparison`);
      maps[family] = map;
    } catch (e) {
      console.error(`[cipher] cipher font error (${family}): ${e.message}`);
    }
  }

  return Object.keys(maps).length > 0 ? maps : null;
}

// Apply cipher maps to HTML: strip garbage spans and decode cipher spans.
// prebuiltMaps (from buildPuppeteerCipherMaps) takes priority; otherwise
// falls back to fontkit parsing of the woff2 files (works if they have glyph names).
async function decodeCipherHtml(html, prebuiltMaps) {
  // Strip hidden garbage spans injected to confuse scrapers
  html = html.replace(
    /<span[^>]+style="[^"]*height:\s*1px[^"]*"[^>]*>[\s\S]*?<\/span>/gi,
    ''
  );

  // Determine which cipher maps to use
  let cipherMaps = prebuiltMaps || {};

  if (!prebuiltMaps || Object.keys(prebuiltMaps).length === 0) {
    // Fallback: try fontkit (works for fonts that include PostScript glyph names)
    const fontFaceMap = {};
    const fontFaceRe =
      /font-family:\s*['"]([^'"]+)['"]\s*;[\s\S]*?src:\s*url\(['"]([^'"]+\.woff2)['"]\)/gi;
    let m;
    while ((m = fontFaceRe.exec(html)) !== null) {
      fontFaceMap[m[1]] = m[2];
    }
    if (Object.keys(fontFaceMap).length > 0) {
      const fontCipherCache = require._fontCipherCache || (require._fontCipherCache = new Map());
      await Promise.all(Object.entries(fontFaceMap).map(async ([family, url]) => {
        try {
          if (fontCipherCache.has(url)) {
            cipherMaps[family] = fontCipherCache.get(url);
            return;
          }
          const resp = await fetch(url, { timeout: 10000 });
          if (!resp.ok) return;
          const buf = await resp.buffer();
          const fontkit = require('fontkit');
          const font = fontkit.create(buf);
          const map = {};
          for (let code = 0x20; code < 0x7F; code++) {
            const glyph = font.glyphForCodePoint(code);
            if (!glyph || glyph.id === 0) continue;
            const name = glyph.name;
            if (!name) continue;
            let decoded = null;
            if (name.length === 1 && /[a-zA-Z0-9]/.test(name)) decoded = name;
            else if (/^uni([0-9A-Fa-f]{4})$/i.test(name))
              decoded = String.fromCharCode(parseInt(name.slice(3), 16));
            if (decoded) map[String.fromCharCode(code)] = decoded;
          }
          fontCipherCache.set(url, map);
          cipherMaps[family] = map;
        } catch (e) {
          console.error(`[cipher] fontkit fallback failed for ${family}: ${e.message}`);
        }
      }));
    }
  }

  if (Object.keys(cipherMaps).length === 0) return html;

  // Log mapped char counts
  for (const [family, map] of Object.entries(cipherMaps)) {
    const count = Object.keys(map).length;
    if (count > 0) console.log(`[cipher] ${family}: ${count} chars mapped`);
  }

  // Decode cipher spans
  html = html.replace(
    /<span\s+style="font-family:\s*([^";]+?)\s*;?\s*">([\s\S]*?)<\/span>/gi,
    (match, family, text) => {
      const cipherMap = cipherMaps[family.trim()];
      if (!cipherMap || Object.keys(cipherMap).length === 0) return match;
      return text.split('').map(c => cipherMap[c] || c).join('');
    }
  );

  return html;
}

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

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

  const hash = crypto.createHash('sha256').update(parsed.href).digest('hex');
  const htmlCachePath = path.join(CACHE_DIR, hash + '.html');
  if (fs.existsSync(htmlCachePath)) {
    console.log(`[read] cache hit: ${parsed.href}`);
    return res.sendFile(htmlCachePath);
  }

  console.log(`[read] fetching: ${parsed.href}`);
  let html;
  let finalUrl = parsed.href;

  // Try node-fetch first; fall back to Puppeteer for bot-protected pages
  let usedPuppeteer = false;
  try {
    const response = await fetch(parsed.href, {
      timeout: FETCH_TIMEOUT_MS,
      size: MAX_BODY_BYTES,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      },
    });

    // Check final URL after redirects for SSRF
    if (response.url && response.url !== parsed.href) {
      const { parsed: finalParsed, error: finalError } = parseUrl(response.url);
      if (!finalError && await isPrivate(finalParsed.hostname)) {
        return res.send(errorPage('That address is not reachable.'));
      }
      finalUrl = response.url;
    }

    if (response.status === 403 || response.status === 429 || response.status === 503) {
      console.log(`[read] HTTP ${response.status}, will retry with Puppeteer: ${parsed.href}`);
      throw Object.assign(new Error('bot-block'), { botBlock: true });
    }

    if (!response.ok) {
      console.error(`[read] HTTP ${response.status} for: ${parsed.href}`);
      return res.send(
        errorPage(`The page returned an error: ${response.status} ${response.statusText}.`)
      );
    }

    try {
      html = await response.text();
      console.log(`[read] body size: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB`);
    } catch (err) {
      if (err.type === 'max-size') {
        console.error(`[read] body too large: ${parsed.href}`);
        return res.send(errorPage('The page is too large to load (limit: 20 MB).'));
      }
      console.error(`[read] body read error: ${err.message}`);
      return res.send(errorPage('Failed to read the page content.'));
    }
  } catch (err) {
    if (err.botBlock) {
      // Fall through to Puppeteer below
    } else if (err.type === 'request-timeout') {
      console.error(`[read] timeout: ${parsed.href}`);
      return res.send(errorPage('The request timed out. The site may be slow or unreachable.'));
    } else {
      console.error(`[read] fetch error: ${err.message}`);
      return res.send(errorPage('Could not reach that address. Check the URL and try again.'));
    }
  }

  let puppeteerCipherMaps = null;
  let fontUrlsForDecode = null;

  if (!html) {
    // Puppeteer fallback for bot-protected pages
    console.log(`[read] fetching via Puppeteer: ${parsed.href}`);
    usedPuppeteer = true;
    let page;
    try {
      const b = await getBrowser();
      page = await b.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      await page.setViewport({ width: 1280, height: 800 });
      const puppeteerResponse = await page.goto(parsed.href, { waitUntil: 'networkidle2', timeout: FETCH_TIMEOUT_MS });

      // SSRF check on final URL after redirects
      const finalPuppeteerUrl = page.url();
      if (finalPuppeteerUrl && finalPuppeteerUrl !== parsed.href) {
        const { parsed: finalParsed, error: finalError } = parseUrl(finalPuppeteerUrl);
        if (!finalError && await isPrivate(finalParsed.hostname)) {
          return res.send(errorPage('That address is not reachable.'));
        }
        finalUrl = finalPuppeteerUrl;
      }

      const status = puppeteerResponse ? puppeteerResponse.status() : 0;
      if (status && status >= 400) {
        console.error(`[read] Puppeteer HTTP ${status} for: ${parsed.href}`);
        return res.send(errorPage(`The page returned an error: ${status}.`));
      }

      html = await page.content();
      console.log(`[read] Puppeteer body size: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB`);
      fontUrlsForDecode = await extractFontUrlsFromPage(page);
    } catch (err) {
      console.error(`[read] Puppeteer fetch error: ${err.message}`);
      return res.send(errorPage('Could not reach that address. Check the URL and try again.'));
    } finally {
      if (page) await page.close();
    }

    if (fontUrlsForDecode) {
      try {
        puppeteerCipherMaps = await buildFontCipherMapsFromPaths(fontUrlsForDecode);
      } catch (e) {
        console.error(`[cipher] path comparison failed: ${e.message}`);
      }
    }
  }

  // Save raw HTML for debugging cipher decoding
  fs.writeFile(path.join(CACHE_DIR, hash + '.raw.html'), html, () => {});

  // Decode font-based cipher spans before parsing (non-fatal if it fails)
  try {
    // Log a sample of each cipher map so we can verify the mappings
    if (puppeteerCipherMaps) {
      for (const [family, map] of Object.entries(puppeteerCipherMaps)) {
        const sample = Object.entries(map).slice(0, 10).map(([k, v]) => `${k}→${v}`).join(' ');
        console.log(`[cipher-map] ${family}: ${sample}`);
      }
    }
    html = await decodeCipherHtml(html, puppeteerCipherMaps);
  } catch (err) {
    console.error(`[cipher] decode failed: ${err.message}`);
  }

  console.log(`[read] parsing: ${parsed.href}${usedPuppeteer ? ' (via Puppeteer)' : ''}`);
  let article;
  try {
    const dom = new JSDOM(html, { url: finalUrl });
    article = new Readability(dom.window.document).parse();
  } catch (err) {
    console.error(`[read] parse error: ${err.message}`);
    return res.send(errorPage('Could not parse the page content.'));
  }

  if (!article) {
    console.error(`[read] readability returned null for: ${parsed.href}`);
    return res.send(
      errorPage(
        'Could not extract readable content from that page. ' +
          'It may be a homepage, web app, or require a login.'
      )
    );
  }

  console.log(`[read] done: ${parsed.href}`);

  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; img-src *; font-src 'self';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const rendered = readerPage(article, parsed.href);
  fs.writeFile(htmlCachePath, rendered, () => {});
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
  const htmlCachePath = path.join(CACHE_DIR, hash + '.html');
  if (fs.existsSync(htmlCachePath)) {
    fs.unlink(htmlCachePath, () => {});
    console.log(`[refetch] deleted cached HTML for: ${rawUrl}`);
  }
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
    await page.addStyleTag({ content: `
      .controls-bar { display: none !important; }
      .pdf-source { display: block !important; }
      .reader { font-size: 14px !important; }
      html, body { background: #fff !important; color: #000 !important; }
      .reader, article, .article-content, .article-title, .byline { color: #000 !important; }
      .article-content a { color: #000 !important; }
      .article-content blockquote { color: #444 !important; border-color: #ccc !important; }
      .article-content pre, .article-content code { background: #f0f0f0 !important; color: #000 !important; }
      .pdf-source, .pdf-source a { color: #444 !important; }
    ` });

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
      <input type="range" id="fs" min="12" max="40" step="2" value="20">
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
    <button class="ctrl-invert" id="ctrl-invert" aria-label="Invert colors" title="Invert colors">Invert</button>
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

  document.getElementById('ctrl-invert').addEventListener('click', function() {
    var inverted = document.documentElement.classList.toggle('inverted');
    this.classList.toggle('active', inverted);
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

// ── Global error handlers ────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[crash] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[crash] unhandledRejection:', reason);
});

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
