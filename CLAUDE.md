# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # run the server (http://localhost:3000)
npm run dev        # run with --watch for auto-restart on file changes
```

No build step — Node.js runs `server.js` directly.

## Architecture

Single-file Express server (`server.js`) with a static CSS file (`public/style.css`).

**Request flow for `GET /read?url=...`:**
1. Validate URL — must be `http`/`https`, not a private/loopback IP (SSRF guard via `dns.lookup`)
2. Fetch with `node-fetch` v2 (CommonJS) — 10s timeout, 5 MB body limit, browser-like User-Agent
3. Parse with `jsdom` + `@mozilla/readability` — Readability strips scripts, ads, nav, iframes
4. Render via template literal — `article.content` injected as raw HTML (Readability output is already sanitized)

**Adjustable reading controls** (font size, line height, margins) work entirely client-side: range sliders update CSS custom properties on `document.documentElement` with no server round-trip. Defaults live in `:root` in `style.css`.

**HTML templates** are plain template literal functions at the bottom of `server.js`: `homePage()`, `readerPage()`, `errorPage()`. All user-controlled strings pass through `esc()` before being interpolated; `article.content` is trusted Readability output.

## Key dependencies

| Package | Why |
|---|---|
| `@mozilla/readability` | Content extraction (same engine as Firefox Reader View) |
| `jsdom` | DOM environment for Readability to operate on |
| `node-fetch` v2 | HTTP fetch; v2 used to stay in CommonJS (`require`) |
| `express` | HTTP server and static file serving |

## Security notes

- Private IP ranges are blocked before and after redirect to prevent SSRF
- `Content-Security-Policy` header is set on reader page responses
- The `size` option on `node-fetch` caps response body at 5 MB
- **Run in a container or VM** — the server fetches arbitrary user-supplied URLs
