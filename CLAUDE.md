# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

App code lives in `reader/` (the subdirectory). Docs, licence, and repo-level config are at the root.

## Commands

Run from the `reader/` subdirectory:

```bash
cd reader
npm start          # run the server (http://localhost:3000)
npm run dev        # run with --watch for auto-restart on file changes
```

Docker is also run from `reader/`:

```bash
cd reader
docker compose up --build
```

No build step — Node.js runs `server.js` directly.

## Architecture

Single-file Express server (`reader/server.js`) with a static CSS file (`reader/public/style.css`).

**Request flow for `GET /read?url=...`:**
1. Validate URL — must be `http`/`https`, not a private/loopback IP (SSRF guard via `dns.lookup`)
2. Check HTML cache (`cache/<sha256>.html`) — serve directly if present
3. Fetch with `node-fetch` v2 (CommonJS) — 60s timeout, 20 MB body limit, full browser headers. Falls back to Puppeteer on 403/429/503 (bot-protected pages). Puppeteer is launched with `--disable-blink-features=AutomationControlled` and `navigator.webdriver` overridden to avoid bot detection.
4. Decode font-based cipher spans (`decodeCipherHtml`) — see below
5. Parse with `jsdom` + `@mozilla/readability` — Readability strips scripts, ads, nav, iframes
6. Render via template literal — `article.content` injected as raw HTML (Readability output is already sanitized)
7. Cache rendered HTML to `cache/<sha256>.html`

**PDF generation (`GET /pdf?url=...`):** Puppeteer loads the cached HTML via the internal `/cached/:hash` route, injects CSS to force black-on-white and hide the controls bar, then renders to PDF. PDF is cached as `cache/<sha256>.pdf`. Both HTML and PDF are keyed by SHA-256 of the normalized URL (`parsed.href`).

**Re-fetch (`GET /refetch?url=...`):** Deletes the cached PDF (if any), then redirects to `/read` to re-fetch, re-run Readability, and overwrite the cached HTML.

**Puppeteer** runs as a lazy singleton browser instance started eagerly at server startup. Uses system Chromium (`CHROMIUM_PATH` env var, defaults to `/usr/bin/chromium-browser`) — Puppeteer's bundled Chromium download is skipped because it downloads x86-64 binaries which don't work on ARM64 (the Multipass VM on Apple Silicon).

**Font-based cipher decoding (`decodeCipherHtml`):** Some sites (e.g. chrysanthemumgarden.com) obfuscate text against scrapers using custom woff2 fonts as cipher keys. Text in certain `<span style="font-family: <randomName>">` elements is encoded; the font file maps each encoded glyph to the correct visual character so real browsers render it fine. The server decodes this by: (1) parsing `@font-face` rules from the HTML to find font-family → woff2 URL, (2) downloading the woff2 and reading each code point's PostScript glyph name via `fontkit` — standard glyph names are the plain letter, so `glyph.name` directly gives the decoded char, (3) replacing encoded span text using the resulting map. Hidden "garbage" spans (`height:1px; width:0`) that exist only to confuse scrapers are stripped. Font-family names are random per page load; the woff2 URL embeds the name so we fetch it fresh (cached in `fontCipherCache` within a server run).

**Adjustable reading controls** (font size, line height, margins) work entirely client-side: range sliders update CSS custom properties on `document.documentElement` with no server round-trip. Defaults live in `:root` in `style.css`.

**HTML templates** are plain template literal functions at the bottom of `server.js`: `homePage()`, `readerPage()`, `errorPage()`. All user-controlled strings pass through `esc()` before being interpolated; `article.content` is trusted Readability output.

## Key dependencies

| Package | Why |
|---|---|
| `@mozilla/readability` | Content extraction (same engine as Firefox Reader View) |
| `jsdom` | DOM environment for Readability to operate on |
| `node-fetch` v2 | HTTP fetch; v2 used to stay in CommonJS (`require`) |
| `express` | HTTP server and static file serving |
| `puppeteer` | Headless Chromium for server-side PDF generation |
| `fontkit` v1 | Parse woff2 fonts to extract glyph→char maps for cipher decoding |

## Deployment (Multipass VM)

The intended deployment is a Multipass Ubuntu 20.04 VM with bridged networking for LAN access. `quick.sh` at repo root tears down and rebuilds the VM from scratch. The server is started via `sudo systemd-run --no-block` to escape the transient cgroup that `multipass exec` creates (plain `nohup &` gets killed when the exec session ends).

```bash
# View server logs
multipass exec reader -- sudo journalctl -f
```

avahi-daemon is installed for mDNS so the VM is reachable as `reader.local`. If it advertises as `reader-2.local` after a force-stop/restart, run `sudo hostnamectl set-hostname reader && sudo systemctl restart avahi-daemon` inside the VM.

**Memory**: The VM needs at least 1.5 GB — Chromium PDF rendering OOMs at 512 MB.

## Security notes

- Private IP ranges are blocked before and after redirect to prevent SSRF
- `Content-Security-Policy` header is set on reader page responses
- The `size` option on `node-fetch` caps response body at 20 MB
- **Run in a container or VM** — the server fetches arbitrary user-supplied URLs
