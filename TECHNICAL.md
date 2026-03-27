# Technical overview

This document describes in detail how Reader works, what it is built with, and why each piece exists.

---

## High-level architecture

Reader is a server-rendered Node.js web application with no client-side framework and no build step. All meaningful work happens on the server: fetching, parsing, caching, and PDF generation. The browser receives finished HTML and a stylesheet. A small amount of vanilla JavaScript handles the live reading controls.

```
User's browser / phone
        │
        │  HTTP (LAN)
        ▼
  Ubuntu VM (Multipass)
  ├── Node.js / Express  ← handles all routes
  ├── node-fetch         ← fetches target URLs
  ├── jsdom              ← builds a DOM from raw HTML
  ├── @mozilla/readability ← extracts article content
  ├── Puppeteer          ← drives headless Chromium for PDF
  ├── Chromium           ← renders pages to PDF
  └── cache/             ← stores .html and .pdf files
```

The VM sits on the local network with a real LAN IP (bridged networking), so any device — phone, tablet, laptop — can reach it directly without the host Mac being involved.

---

## Host machine tooling

### Homebrew

[Homebrew](https://brew.sh) is the macOS package manager used to install two things:

- `multipass` (via `brew install --cask multipass`) — installs the Multipass application as a macOS `.app`
- `socat` (via `brew install socat`) — an alternative to bridged networking (see below)

Homebrew `--cask` installs macOS GUI applications distributed as binaries, as opposed to formulae which are compiled from source.

### Multipass

[Multipass](https://canonical.com/multipass) is a VM manager from Canonical (the company behind Ubuntu). On macOS it uses **QEMU** as the hypervisor, running Ubuntu guest VMs on top of Apple's Hypervisor framework (on Apple Silicon) or HVF (on Intel).

Key Multipass concepts used in this project:

- `multipass launch` creates and starts a VM from an Ubuntu cloud image downloaded from Canonical's servers. The `--network en0` flag attaches a second virtual NIC to the VM bridged to the host's `en0` interface, giving the VM a real IP on the local network (DHCP from your router).
- `multipass transfer -r` copies files into a running VM over a built-in file transfer mechanism (no SSH required).
- `multipass shell` opens an interactive shell in the VM (via a virtio console).

The VM's hostname is set to the instance name (`reader`) by Multipass automatically.

### socat (alternative networking)

`socat` (SOcket CAT) is a Unix utility that relays data between two byte streams. When bridged networking is unavailable or undesirable, it can relay traffic from the Mac's LAN interface to the VM's private IP:

```
socat TCP-LISTEN:3000,bind=0.0.0.0,fork TCP:<vm-ip>:3000
```

`TCP-LISTEN:3000,bind=0.0.0.0` opens a listening socket on all interfaces at port 3000. `fork` spawns a new child process per connection so multiple clients can connect. `TCP:<vm-ip>:3000` is the destination each connection is forwarded to. This is a stateless relay — socat does not inspect or buffer the traffic.

---

## VM operating system

### Ubuntu 20.04 LTS

The VM runs Ubuntu 20.04 LTS (Focal Fossa), a Debian-based Linux distribution. Ubuntu 20.04 is used because it is a well-supported Multipass image target and has a stable `apt` package ecosystem.

### apt (Advanced Package Tool)

`apt` is Ubuntu's package manager. `install.sh` uses it to install:

- `nodejs` — installed via the **NodeSource** repository (see below), not Ubuntu's default older version
- `chromium-browser` — the Chromium web browser, used headlessly for PDF generation
- `avahi-daemon` — the mDNS daemon (see below)

### NodeSource

Ubuntu 20.04's default `apt` repositories ship an old version of Node.js. `install.sh` adds the NodeSource PPA (Personal Package Archive) first:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

This script adds a NodeSource apt source to `/etc/apt/sources.list.d/` and imports their signing key, after which `apt-get install nodejs` installs Node.js 20.

### avahi-daemon

[Avahi](https://avahi.org) is the Linux implementation of mDNS (Multicast DNS) and DNS-SD (DNS Service Discovery), the same protocols used by Apple's Bonjour. When running, `avahi-daemon` broadcasts the VM's hostname on the local network over UDP multicast (224.0.0.251, port 5353). Any device that supports `.local` resolution — macOS, iOS, and most Linux systems — can then reach the VM as `reader.local` without knowing its IP.

Android support for `.local` is inconsistent across versions and vendor builds, which is why the IP fallback is documented.

---

## Runtime

### Node.js 20

[Node.js](https://nodejs.org) is the JavaScript runtime. The server uses CommonJS modules (`require`) throughout, which is why `node-fetch` is pinned to v2 (v3 is ESM-only). Node's built-in modules used directly:

- `dns.promises` — used for SSRF protection (resolving hostnames to IPs before fetching)
- `fs` — synchronous and callback-based file I/O for the cache
- `crypto` — SHA-256 hashing for cache keys
- `path` — cross-platform path construction

### npm

Node's built-in package manager. `npm install` reads `package.json`, downloads dependencies from the npm registry into `node_modules/`, and writes a `package-lock.json` lockfile. Puppeteer's `postinstall` script downloads a compatible Chromium binary into `~/.cache/puppeteer/` — however, this project overrides it with the system Chromium (see Puppeteer section).

---

## Node.js dependencies

### Express

[Express](https://expressjs.com) is a minimal HTTP server framework. In this project it handles:

- Routing (`app.get(...)`)
- Static file serving (`express.static`) for `public/style.css`
- Request/response lifecycle

No middleware beyond `express.static` is used. All HTML is generated as strings and sent with `res.send()`.

### node-fetch v2

[node-fetch](https://github.com/node-fetch/node-fetch) brings the browser `fetch` API to Node.js. Version 2 is used specifically because it uses CommonJS exports. Key options used:

- `timeout` — aborts the request if the server doesn't respond within 10 seconds
- `size` — limits the response body to 5 MB, preventing memory exhaustion from large pages
- `headers` — sends a realistic browser User-Agent and Accept header, since many sites block or degrade responses to unrecognised clients

After fetching, `response.url` is checked against the original URL. If redirects occurred, the final destination is re-validated for SSRF (see Security section).

### jsdom

[jsdom](https://github.com/jsdom/jsdom) is a full DOM and HTML implementation for Node.js. It parses the raw HTML string returned by `node-fetch` and constructs a live `document` object — the same API that exists in browsers. Readability requires a real DOM to operate on; it cannot work with raw HTML strings.

The `url` option passed to `new JSDOM(html, { url })` is important: it sets the document's base URL, which allows Readability to resolve relative URLs (links, image `src` attributes) to absolute ones.

### @mozilla/readability

[Readability](https://github.com/mozilla/readability) is Mozilla's article extraction library, extracted from Firefox's Reader View feature. Given a DOM document, `new Readability(document).parse()` returns a plain object containing:

- `title` — the article's headline
- `byline` — author information if found
- `content` — a sanitised HTML string of the article body (scripts, iframes, navigation, ads, and sidebars removed)
- `excerpt`, `siteName`, `lang`, and others

If the page does not look like an article (e.g. it is a homepage or a web application), `parse()` returns `null`. Readability uses a scoring algorithm based on element density, class names, and text-to-markup ratio to identify the main content block.

The sanitised `content` HTML is injected directly into the rendered page. Readability's sanitisation is the reason this is safe — executable content is stripped before Reader ever sees it.

### Puppeteer

[Puppeteer](https://pptr.dev) is a Node.js library that provides a high-level API over the Chrome DevTools Protocol (CDP) to control a Chromium browser programmatically.

In this project, Puppeteer is used exclusively to generate PDFs. It is not used for scraping — that is handled by `node-fetch` + `jsdom` + Readability.

The browser is launched once at server startup as a singleton and reused across requests:

```js
browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
```

`--no-sandbox` is required because Linux sandboxing (which isolates the renderer process using kernel namespaces and seccomp filters) requires specific kernel capabilities that may not be available in a VM environment. `executablePath` points to the system Chromium rather than a downloaded binary, because Puppeteer's bundled Chromium may not match the VM's CPU architecture (particularly on ARM64 VMs running on Apple Silicon Macs).

The `browser.on('disconnected')` event handler resets the singleton to `null` so the browser is re-launched automatically if it crashes.

For each PDF request, a new `page` is opened, navigated to the cached reader page at `http://localhost:3000/cached/<hash>`, and `page.pdf()` is called. Before generating the PDF, a style tag is injected to hide the controls bar and show the source URL link — neither of which is appropriate in print. The page is closed in a `finally` block to prevent handle leaks.

### Chromium

[Chromium](https://www.chromium.org) is the open-source browser that Chrome is built from. It is installed as a system package (`chromium-browser`) via `apt`. Puppeteer drives it headlessly — no window is displayed. Chromium handles the actual layout, CSS rendering, and PDF serialisation via its print pipeline.

---

## Application code

### Routes

| Route | Purpose |
|---|---|
| `GET /` | Home page — URL entry form |
| `GET /read?url=` | Fetch, parse, render, and cache an article |
| `GET /cached/:hash` | Serve a cached HTML page (used internally by Puppeteer) |
| `GET /pdf?url=` | Serve or generate a PDF for an article |
| `GET /refetch?url=` | Delete cached PDF, redirect to `/read` to re-fetch |

### SSRF protection

Server-Side Request Forgery (SSRF) is the main security concern in an application that fetches arbitrary user-supplied URLs. An attacker could supply `http://169.254.169.254/` (cloud metadata endpoints), `http://127.0.0.1:6379/` (Redis), or `http://192.168.1.1/` (router admin panel) to exfiltrate data or probe the internal network.

Protection is applied in two layers:

1. **Protocol allowlist** — `parseUrl()` rejects anything that is not `http:` or `https:`, blocking `file://`, `ftp://`, `javascript:` etc.
2. **IP blocklist** — before fetching, the hostname is resolved with `dns.lookup()` and checked against regex patterns covering all private and loopback ranges: `127.x.x.x`, `10.x.x.x`, `172.16–31.x.x`, `192.168.x.x`, `169.254.x.x`, `::1`, and IPv6 ULA/link-local. If DNS resolution fails, the address is also rejected. The check is run again on `response.url` after redirects complete, to catch redirect chains that terminate at an internal address.

### Caching

Cache files live in `cache/` (excluded from git via `.gitignore`). Cache keys are SHA-256 hashes of the normalised URL (`parsed.href`), which ensures consistent keys regardless of how the user typed the URL.

Two files per article:

- `cache/<hash>.html` — the fully rendered reader page HTML, written by `/read` on every successful parse (fire-and-forget, does not delay the response)
- `cache/<hash>.pdf` — the PDF, written by Puppeteer on first generation

When `/pdf` is requested, it checks for the cached PDF first. If absent, it checks for cached HTML and loads it via `/cached/:hash` (avoiding a second external fetch). Only if neither exists does it fall back to a live fetch via `/read`.

`/refetch` deletes the PDF cache and redirects to `/read`, which overwrites the HTML cache. This means Re-fetch always performs a full pipeline: external fetch → Readability → HTML cache overwrite. The next PDF request then generates a fresh PDF from the new HTML.

### HTML generation

There is no templating library. All HTML is produced by JavaScript template literal functions: `homePage()`, `readerPage()`, `errorPage()`, and `layout()`. User-controlled strings are passed through `esc()`, which HTML-encodes `& < > " '`. The `article.content` HTML from Readability is injected without escaping because it is already sanitised output, not user input.

### Security headers

Reader pages are served with two security headers:

- `Content-Security-Policy` — restricts what can execute in the browser. `img-src *` allows images from any origin (articles embed images from their original domains). `script-src 'self' 'unsafe-inline'` permits the inline controls script while blocking any scripts injected by article content.
- `X-Content-Type-Options: nosniff` — prevents browsers from MIME-sniffing responses, which can cause HTML to be executed as a script in some contexts.

---

## Frontend

### CSS custom properties

The reading controls (font size, line height, margins) work by updating CSS custom properties on `document.documentElement` via JavaScript:

```js
root.style.setProperty('--font-size', value + 'px');
```

The stylesheet reads these as `font-size: var(--font-size, 20px)`. The fallback value in the CSS ensures the page is styled correctly on first load before any slider interaction. No server round-trip is involved — changes are instantaneous.

### Dark mode

The stylesheet uses `@media (prefers-color-scheme: dark)` to redefine the colour custom properties. Because the rest of the CSS reads from custom properties, the entire colour scheme switches automatically with no duplicated rules.

### System font stack

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

This uses whatever sans-serif the operating system considers its UI font — San Francisco on macOS/iOS, Segoe UI on Windows, Roboto on Android. System fonts are already hinted and tuned for legibility on that specific screen, and no external font request is made.

### Reduced motion

`@media (prefers-reduced-motion: reduce)` disables all animations and transitions for users who have enabled that OS-level accessibility preference.

---

## PDF pipeline in detail

1. `GET /pdf?url=<url>` is received
2. URL is normalised via `new URL()` and hashed with SHA-256
3. If `cache/<hash>.pdf` exists → `res.sendFile()` immediately, done
4. If `cache/<hash>.html` exists → Puppeteer navigates to `http://localhost:3000/cached/<hash>`; otherwise Puppeteer navigates to `http://localhost:3000/read?url=<url>` (triggering a full fetch and caching the HTML as a side effect)
5. `page.addStyleTag()` injects CSS to hide `.controls-bar` and reveal `.pdf-source` (the source URL line that is normally hidden)
6. `page.pdf()` renders to A4 with 20 mm margins and writes the bytes to `cache/<hash>.pdf`
7. The same bytes are sent to the client as `application/pdf` with a `Content-Disposition: attachment` header, causing the browser to download rather than display them
8. The page handle is closed in `finally`

---

## mDNS / service discovery

`avahi-daemon` implements RFC 6762 (mDNS) and RFC 6763 (DNS-SD). On startup it sends unsolicited multicast announcements on `224.0.0.251:5353` (IPv4) and `[ff02::fb]:5353` (IPv6) advertising the VM's hostname (`reader`) on the `.local` pseudo-TLD. Querying devices send mDNS queries to the same multicast group rather than a DNS server; Avahi responds with the VM's current IP.

The result is that `reader.local` resolves on any device on the same LAN segment without DNS configuration, dynamic DNS, or knowing the VM's IP address.
