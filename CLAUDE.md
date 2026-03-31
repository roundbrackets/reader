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
2. Fetch with `node-fetch` v2 (CommonJS) — 60s timeout, 20 MB body limit, browser-like User-Agent
3. Parse with `jsdom` + `@mozilla/readability` — Readability strips scripts, ads, nav, iframes
4. Render via template literal — `article.content` injected as raw HTML (Readability output is already sanitized)
5. Cache rendered HTML to `cache/<sha256>.html`

**PDF generation (`GET /pdf?url=...`):** Puppeteer loads the cached HTML via the internal `/cached/:hash` route, injects CSS to force black-on-white and hide the controls bar, then renders to PDF. PDF is cached as `cache/<sha256>.pdf`. Both HTML and PDF are keyed by SHA-256 of the normalized URL (`parsed.href`).

**Re-fetch (`GET /refetch?url=...`):** Deletes the cached PDF (if any), then redirects to `/read` to re-fetch, re-run Readability, and overwrite the cached HTML.

**Puppeteer** runs as a lazy singleton browser instance started eagerly at server startup. Uses system Chromium (`CHROMIUM_PATH` env var, defaults to `/usr/bin/chromium-browser`) — Puppeteer's bundled Chromium download is skipped because it downloads x86-64 binaries which don't work on ARM64 (the Multipass VM on Apple Silicon).

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
