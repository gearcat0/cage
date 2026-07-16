# the cage

**Phase 1 of a larger project.** The cage is a hardened Electron renderer that
runs arbitrary untrusted HTML/CSS/JS with **no network access and no ambient
authority**, plus a suite of escape-attempt tests that prove it holds.

## The trust model, in a paragraph

The larger system distributes content as self-contained "things": single HTML
files (inline JS/CSS) that render themselves. A thing is **untrusted code with
nothing worth stealing and nowhere to send it.** All real authority — keys,
networking, storage, signing — lives in a *trusted shell* outside the cage. The
thing gets a tiny message bridge (`getArgs` / `emit`) and nothing else. The cage
is the wall between those two worlds: if it holds, a malicious thing can at worst
render deceptive pixels *inside its own rectangle* — it cannot exfiltrate, phone
home, persist a tracking identifier, open a window, navigate away, or reach any
Node/Electron capability. "No network" is enforced at **four independent layers**
so that any single layer failing is not a breach.

## Architecture

```
src/main/
  index.ts      app bootstrap, privileged thing: scheme, BaseWindow with two
                sibling native views (trusted chrome strip above, cage below)
  cage.ts       constructs the hardened WebContentsView + session (Layers 1–4)
  protocol.ts   thing:// handler — serves ONLY pre-supplied in-memory bytes
  bridge.ts     shell side of the bridge: getArgs stub + emit logger
  events.ts     main-process event log the tests read from OUTSIDE the renderer
src/preload/
  index.ts      contextBridge exposure of a FROZEN { getArgs, emit } and nothing else
src/renderer/
  index.html    the trusted chrome strip (id / hash / "UNSIGNED — test harness")
test/
  things/       one .html per attack (malicious) + benign.html (positive control)
  canary.ts     local TCP/HTTP/WS/UDP listener that must never receive a connection
  cage.spec.ts  the escape-attempt suite
```

The thing is loaded as `thing://<random-id>/index.html`, handled by
`protocol.handle()` on the cage's own session. The handler serves bytes **only**
from an in-memory map populated before load; it never touches the filesystem
based on thing input, and never touches the network.

### The four hardening layers

Each is independently identifiable in `src/main/cage.ts`, tagged `Layer N`:

1. **Process configuration** — `sandbox`, `contextIsolation`, `nodeIntegration:false`,
   `webSecurity`, `experimentalFeatures:false`, and a **fresh, non-persistent
   session partition per thing** (`thing-<id>`, no `persist:` prefix → in-memory
   only, so no thing can read another's storage breadcrumbs).
2. **Request interception** — cancel every request whose scheme isn't `thing:`;
   deny all permission requests *and* checks; deny `window.open`; prevent
   `will-navigate` / `will-redirect`.
3. **Non-webRequest egress** — a dead proxy (`127.0.0.1:1`) for any escaping
   HTTP(S)/SOCKS, plus `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` and
   a process-wide WebRTC flag (webRequest cannot see WebRTC — this closes it).
4. **Content-Security-Policy** — `default-src 'none'; connect-src 'none'; …`
   injected on every `thing:` response (and stamped on the bytes by the protocol
   handler). `connect-src 'none'` kills fetch/XHR/WebSocket/EventSource at the CSP
   layer; Layer 2 kills them again at the network layer. Both on purpose.

The **chrome strip** is a separate native `WebContentsView` composited *above*
the cage. The thing renders into a different view entirely, so it cannot paint
over, resize away, or overlay the trusted header — a spatial guarantee the suite
checks with a geometry assertion.

## Running it

```bash
pnpm install
pnpm build          # compile main / preload / renderer into out/
pnpm dev            # launch the app; loads the benign thing and renders it
pnpm test:cage      # build + run the full escape suite (green wall)
pnpm test:unit      # fast pure-logic unit tests (Vitest)
pnpm typecheck
```

`pnpm test:cage` prints a wall — one line per attack, all green when the cage
holds — ending in `CAGE HOLDS  22/22 attempts blocked, positive test passed.`

### How egress is verified (from outside the page)

Each malicious thing receives the canary's URLs through the legitimate bridge
(`getArgs().canary`) and tries to beacon to them. The suite then asserts, from
the **main process** and from the **canary listener** — both outside the
renderer — that nothing arrived: not a TCP socket, HTTP request, WebSocket
upgrade, or UDP datagram. The thing's own error callbacks are treated as
secondary evidence; the canary's silence is the proof.

### Linux sandbox note (dev machines and CI)

The cage configures its renderers with the OS-level Chromium sandbox
(`sandbox: true`, Layer 1). On a normal Linux desktop it initializes out of the
box. In a locked-down container (unprivileged user namespaces disabled by
AppArmor, and the setuid helper not root-owned) it cannot self-initialize and
Electron aborts on launch. To run `pnpm dev` with the real OS sandbox there,
enable it once:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# or, alternatively, make the setuid helper root-owned:
# sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Or, for a throwaway dev container, skip it: `pnpm dev:nosandbox` sets
`ELECTRON_DISABLE_SANDBOX=1` (read by the Electron binary before JS runs). That
turns the OS process sandbox **off** — a dev-only accommodation. Everything else
(network, storage, escalation layers) still applies.

**What the test suite exercises.** `pnpm test:cage` drives the app through
Playwright, which launches Electron with the OS sandbox disabled (Playwright's
default for Electron, so it runs anywhere including this container). The
behavioral guarantees the suite proves — no network egress, no Node/Electron
reachability, no persistence, no navigation/escalation, unspoofable chrome — are
enforced by `contextIsolation`, `nodeIntegration:false`, the CSP, the request
canceller, the permission handlers, and the per-thing partition. **None of those
depend on the OS sandbox.** The OS sandbox is the additional backstop against a
renderer memory-corruption exploit; it is present in the cage's configuration and
active whenever the app runs on a host where it can initialize (a normal `pnpm
dev`), but the suite does not attempt a memory-corruption exploit and so does not
rely on it.

## Adding a new attack test (the suite will grow)

1. **Add the malicious thing.** Create `test/things/<attack>.html`. Keep it a
   self-contained inline script that runs the attack on load and reports via the
   bridge. Read any target from `getArgs()` (the canary URLs are injected there):

   ```html
   <script>
     const canary = (window.bridge.getArgs() || {}).canary || {};
     const r = { attack: 'my-attack' };
     try { /* ...attempt the escape... */ } catch (e) { r.error = String(e); }
     // Always emit a final 'done' so the test can await it (even on failure).
     setTimeout(() => window.bridge.emit('done', r), 800);
   </script>
   ```

   Note: the script runs in `<head>` during parse, so `document.body` may be
   null — append to `document.documentElement` if you need the DOM.

2. **Add the assertion** in `test/cage.spec.ts`:

   ```ts
   test('my attack is blocked', async ({ open, canary }) => {
     const cage = await open({ thing: 'my-attack.html' })
     const r = await cage.waitForEmit('done')
     expect(/* the attack did not succeed */).toBe(true)
     expect(canary.silent()).toBe(true) // nothing left the process
   })
   ```

   For escalation checks, read the main-process event log with `cage.events()`
   and assert the relevant `blocked-request` / `navigation-blocked` /
   `window-open-denied` / `permission-denied` entry appears.

## Out of scope for this phase

Manifest/format, CBOR, signing/verification, encryption, Ethereum/Nostr identity,
naming/ENS, torrent transport, the SQLite index, the feed UI, blob-by-hash
attachments, versioning, publishing, code signing, auto-update. Search the code
for `// LATER:` for the places that leave room for them.
