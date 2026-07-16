# Build brief — the cage

This document is a build brief for **phase 1** of a larger project. It is deliberately scoped to one deliverable: a hardened Electron renderer (the "cage") that runs arbitrary untrusted HTML/CSS/JS with **no network access and no ambient authority**, plus a **test suite of escape attempts** that proves the cage holds.

Do **not** build the format, envelope/signing, naming, torrent transport, or feed UI here. Those are later phases. The only job now is: *load a self-contained HTML file into a view that cannot reach the network, cannot persist data, cannot open windows, and cannot navigate — and demonstrate that with tests.*

---

## Context (read this first)

The larger system distributes content as self-contained "things": single HTML files (inline JS/CSS) that render themselves and can build new instances of themselves. State is passed in as an argument, never fetched. The security model is: **a thing is untrusted code with nothing worth stealing and nowhere to send it.** All authority — keys, networking, storage, signing — lives in a *trusted shell* outside the cage. The thing gets a tiny message bridge and nothing else.

The cage is the wall between those two worlds. If it holds, a malicious thing can at worst render deceptive pixels *inside its own frame*; it cannot exfiltrate, phone home, persist a tracking identifier, or escalate. This brief builds that wall and the tests that prove it.

**Design stance:** enforce "no network" at multiple independent layers so that any single layer failing is not a breach. Prefer denying by default and allowing narrowly. The cage should be small and auditable — resist adding convenience features to it.

---

## Tech stack

- **Electron** (latest stable) + **TypeScript**
- Scaffold with **electron-vite**
- Package manager: **pnpm**
- Test runner: **Vitest** for unit/logic, **Playwright for Electron** (`playwright` `_electron`) or **WebdriverIO** for driving the actual running app and asserting on real renderer behavior. Prefer the approach that lets tests observe whether a real network request left the process.
- Node **20+**

Target this repo initially at a personal GitHub/npm account; it will move to an org later. Don't set up publishing, code signing, or auto-update — those are explicitly out of scope for now. A plain `pnpm build` that produces a runnable app is enough.

---

## Architecture

Three parts:

1. **Main process** — creates the app, owns a privileged custom protocol that serves *only* pre-supplied local bytes, and constructs the locked-down session/view for each thing.
2. **Cage** — a `WebContentsView` (not a bare `BrowserWindow` webContents) configured with every hardening flag, an ephemeral session partition, and a request handler that cancels everything.
3. **A trivial host UI** — just enough shell chrome to load a thing from a local file for testing, and a header strip the thing cannot draw over. This is a stand-in for the real shell; keep it minimal.

The thing is loaded via a registered scheme, e.g. `thing://<id>/index.html`, handled by `protocol.handle()`. The handler serves bytes **only** from an in-memory/local map that was populated before load. It never touches the filesystem based on thing-controlled input, and never touches the network. This is the only "fetch" path the thing has, and it resolves to content the thing already came with.

### The bridge (stub only for now)

Expose a minimal `postMessage`-based bridge via a `contextBridge` preload. For phase 1 implement only:

- `getArgs()` → returns a fixed test payload (bytes/JSON). No real manifest yet.
- `emit(channel, data)` → forwards to the shell, which for now just logs it. No signing.

Explicitly **do not** expose: any signing, any decryption, any network, any filesystem, any storage, any `require`/Node API. The preload must run with `contextIsolation` and expose only these two functions on a frozen object.

---

## Hardening requirements (the cage)

Implement **all** of these. Each is an independent layer.

### Layer 1 — process configuration
Per thing, create a `WebContentsView` with `webPreferences`:
- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- `nodeIntegrationInSubFrames: false`
- `webSecurity: true`
- `allowRunningInsecureContent: false`
- `experimentalFeatures: false`
- a **fresh, non-persistent session partition per thing** — generate a random id and use `partition: 'thing-' + id` (note: **no** `persist:` prefix, so it's in-memory only). This prevents one thing (or a re-load of the same thing) from reading storage breadcrumbs left by another — that would be a tracking channel and must be impossible.

### Layer 2 — request interception
On that thing's `session`:
- `session.webRequest.onBeforeRequest((details, cb) => ...)` — **cancel every request** whose URL scheme is not the custom `thing:` scheme. Default action is `{ cancel: true }`. Only `thing://` reads into the pre-supplied local blob map are allowed.
- `session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))` — deny all permissions (geolocation, notifications, media, clipboard, etc.).
- `session.setPermissionCheckHandler(() => false)`.
- `contents.setWindowOpenHandler(() => ({ action: 'deny' }))`.
- `contents.on('will-navigate', e => e.preventDefault())` and block `will-redirect`.
- Register the `thing:` scheme as privileged/standard **before** app ready (`protocol.registerSchemesAsPrivileged`) with `standard: true, secure: true, supportFetchAPI: false, corsEnabled: false`.

### Layer 3 — non-webRequest egress paths
`webRequest` does **not** see WebRTC. Close that and related holes:
- `session.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1;socks=127.0.0.1:1' })` — route any escaping HTTP(S) to a dead port.
- `contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` — with all UDP forced through a non-existent proxy, WebRTC has no path out.
- Consider launching with relevant Chromium flags to disable WebRTC entirely if the app doesn't need it (it doesn't).

### Layer 4 — Content Security Policy
Inject a strict CSP via `session.webRequest.onHeadersReceived`, applied to the `thing:` responses:
```
default-src 'none';
script-src 'unsafe-inline' thing:;
style-src 'unsafe-inline' thing:;
img-src thing: data: blob:;
media-src thing: blob:;
font-src thing: data:;
connect-src 'none';
frame-src 'none';
form-action 'none';
base-uri 'none';
```
`connect-src 'none'` alone kills fetch/XHR/WebSocket/EventSource at the CSP layer; the request handler kills them again at the network layer. Both must be present — that's the point of layering.

### Unspoofable chrome
The header strip that will later show signer identity and verification status must be **outside** the cage's rendering surface — a separate view/region the thing cannot paint over, resize away, or cover with an overlay. For phase 1 it can just display the thing's id/hash and a static "UNSIGNED — test harness" label. The requirement being proven here is *spatial*: the thing's pixels are confined to the cage rectangle and cannot escape it.

---

## The escape-attempt test suite (the deliverable that matters most)

Create a set of **malicious test things** — small HTML files that each *try* to break out — and assert every attempt is blocked. This suite is both the correctness proof for phase 1 and a future standalone conformance artifact, so structure it cleanly and comment each attack with what it's testing.

For each attack, the test should: load the malicious thing into a real cage, exercise the attempt, and assert **no network egress occurred** and **no escalation succeeded**. Where possible, detect egress by observing at the OS/process boundary (e.g. a local listener that should *never* receive a connection, plus assertions that the request handler fired `cancel`), not only by trusting in-page error callbacks — a thorough version verifies from outside the sandbox that nothing left.

Attacks to cover (each its own test thing):

**Network egress**
- `fetch('http://localhost:<canary>/beacon')` and `fetch('https://example.com')`
- `XMLHttpRequest` to a canary URL
- `new WebSocket('ws://localhost:<canary>')`
- `new EventSource(...)`
- `<img src>` / `new Image().src` beacon to a canary
- `navigator.sendBeacon(...)`
- dynamic `<script src=...>` injection to a remote origin
- `fetch` of a `thing://` URL for content **not** in the supplied blob map (must fail — the handler serves only known bytes)
- `new RTCPeerConnection(...)` creating an offer / attempting a STUN/TURN connection to a canary
- CSS-based exfil attempt (e.g. `background: url(http://canary/...)`) — should be blocked by `img-src`/`connect-src`

**Persistence / tracking channels**
- write to `localStorage` / `sessionStorage`, then reload the same thing in a fresh partition and assert the value is gone
- `indexedDB` open + write, then assert it doesn't survive across a fresh partition load
- `document.cookie` set, assert not persisted/sent
- `caches`/Service Worker registration attempt — assert denied/unavailable
- assert two *different* things loaded in sequence cannot see each other's storage

**Escalation / capability probing**
- attempt to access `require`, `process`, `global`, `Buffer`, `module`, Node APIs — assert `undefined`
- attempt `window.open(...)` — assert denied (no new window/view)
- attempt `location = 'https://...'` and `history.pushState` navigation off the thing — assert prevented
- request permissions (geolocation, notifications, camera/mic, clipboard-read) — assert all denied
- attempt to read/enumerate the bridge for anything beyond `getArgs`/`emit` — assert the exposed surface is exactly those two, frozen
- attempt to cover/overlay or resize beyond the cage rectangle to spoof the chrome strip — assert the chrome region is unaffected (a rendering/geometry assertion)

**Bridge abuse**
- call `emit` with huge payloads / malformed data — assert the shell handles it without crashing and without granting anything
- rapid-fire `emit` (flood) — assert no resource is granted and the shell stays responsive

### Green-wall output
Provide a single command (`pnpm test:cage` or similar) that runs the whole suite and prints a clear pass/fail wall — one line per attack, all green when the cage holds. This output is the artifact you'll show people; make it legible.

Also include at least **one positive test**: a benign thing that renders supplied args correctly and successfully calls `getArgs()` and `emit()`, proving the cage isn't just "deny everything" but actually runs legitimate things.

---

## Repo layout

```
/                     electron-vite project root
  src/
    main/             main process: app, protocol handler, cage construction
      cage.ts         constructs the hardened WebContentsView + session
      protocol.ts     thing:// handler serving only supplied local bytes
      bridge.ts       shell-side bridge (getArgs stub, emit logger)
    preload/
      bridge.ts       contextBridge exposure of the frozen {getArgs, emit}
    renderer/         minimal host UI (load-from-file, header strip)
  test/
    things/           malicious + benign test things (one .html per attack)
    cage.spec.ts      the escape-attempt suite
    canary.ts         local listener that must never receive a connection
  package.json
  README.md           how to run the app and the suite; summary of the model
```

---

## Definition of done

- `pnpm dev` launches the app; a benign test thing loads from a local file and renders.
- `pnpm test:cage` runs the full escape suite and every attack is blocked (green wall), plus the positive test passes.
- Each hardening layer (1–4) is present and independently identifiable in the code, with a comment noting which layer it is.
- The bridge exposes **exactly** `getArgs` and `emit`, on a frozen object, and nothing else is reachable from the thing.
- Egress is verified from outside the page where feasible (the canary listener stays silent), not solely via in-page error handlers.
- `README.md` explains the trust model in a paragraph and documents how to add a new attack test, since the suite will grow.

---

## Explicitly out of scope for this phase

Manifest/format, CBOR encoding, signing/verification, NIP-44 encryption, Ethereum/Nostr identity, ENS or any naming, torrent/webtorrent transport, the SQLite library index, the feed UI, blob-by-hash attachments, versioning/supersedes, npm publishing, code signing, auto-update. Do not build these. If a decision here would constrain them, leave a short `// LATER:` note rather than implementing.
