# the cage — and the shell

**Phases 1–3 of a larger project.** The cage is a hardened Electron renderer
that runs arbitrary untrusted HTML/CSS/JS with **no network access and no
ambient authority**, plus a suite of escape-attempt tests that prove it holds.
Phase 2 fleshed out the shell↔thing bridge into the real four-method interface.
**Phase 3 adds the shell** — the trusted client that holds the keyring, admits
hostile bundles through an isolated pipeline, indexes them in a library, and
mounts admitted things into cages with all trust signals in unforgeable chrome.

This repo now contains three layers, kept together for ease of testing and
CI-enforced to stay decoupled (`test/unit/boundary.test.ts`):

- **`src/format/`** — the thing format (canonical CBOR, hashing, signing/verify,
  sealed envelopes, bundle admission). Pure TS; the spec lives in the separate
  `gearcat0/format` repo. See `src/format/README.md`.
- **`src/main/`, `src/preload/`** — the cage. Imports neither the shell nor
  format.
- **`src/shell/`** — the trusted client (admission, keyring, library, mount,
  chrome UI, transport/naming stubs). See `src/shell/README.md`.

## The trust model, in a paragraph

The larger system distributes content as self-contained "things": single HTML
files (inline JS/CSS) that render themselves. A thing is **untrusted code with
nothing worth stealing and nowhere to send it.** All real authority — keys,
networking, storage, signing — lives in a *trusted shell* outside the cage. The
thing gets a tiny message bridge and nothing else. The cage is the wall between
those two worlds: if it holds, a malicious thing can at worst render deceptive
pixels *inside its own rectangle* — it cannot exfiltrate, phone home, persist a
tracking identifier, open a window, navigate away, or reach any Node/Electron
capability. "No network" is enforced at **four independent layers** so that any
single layer failing is not a breach.

## The bridge (phase 2)

Four methods on a frozen object, and nothing else. Every method either hands
the thing data it already came with, or accepts a *request* that grants nothing
until a human confirms it in trusted chrome:

- `getArgs()` — a decoded, read-only `ThingArgs` view (`type`, `args`,
  attachment names + mime + size). **Never** raw CBOR, and **never** the
  envelope: author/signature/timestamp live in chrome pixels the thing cannot
  touch, because a thing that can draw "signed by alice.eth" can lie.
  Attachment hashes are withheld too — things address blobs by *name*.
- `getBlob(name)` — a `thing://<id>/att/<name>` URL, or null. A string, not
  bytes: the protocol handler streams from the shell's store, so the bridge
  moves no attachment bytes at all. The security gate is the admitted
  attachment table + the handler (an unknown name 404s there whether or not it
  came through `getBlob`).
- `viewerInfo()` — coarse and non-identifying: `locale` + `colorScheme`,
  nothing that fingerprints.
- `emit(channel, data)` — fire-and-forget request that grants nothing.
  `emit("draft", {type, args, blobs})` streams the program's working state;
  the shell validates the shape, enforces per-blob AND total-bytes caps,
  hashes inline blobs into an attachment table, renders it as the live
  preview, and lets the human sign EXACTLY that latest draft via the chrome
  Publish button. (`emit("publish")` is retired — publish is shell-owned.)
  Blob values: raw bytes, `{bytes, mime}` (typed attachments survive nosniff
  serving), or `{carry: true}` — keep the mounted instance's attachment of
  that name, resolved shell-side (a program can display its attachments but
  cannot read their bytes back).

Attachment bytes live in a **content-addressed store** (`<cas>/blobs/<hex>`)
for public things, or an **ephemeral in-memory store** for sealed things —
decrypted sealed content must never be written to disk in the clear. Integrity
is verified once at admission (format spec §8.1), not per serve. The `att/`
route serves with the manifest's MIME, `nosniff`, and single-range `Range`
support so media seeking works.

## Architecture

```
src/main/
  index.ts      app bootstrap, privileged thing: scheme, BaseWindow with two
                sibling native views (trusted chrome strip above, cage below),
                admission-lite for the test/dev harness
  cage.ts       constructs the hardened WebContentsView + session (Layers 1–4)
  protocol.ts   thing:// handler — index.html from pre-supplied bytes, att/<name>
                streamed by admitted name (mime + nosniff + Range), 404 otherwise
  store.ts      CasStore (persistent, content-addressed, on-disk) and
                EphemeralStore (memory-only, for sealed things)
  bridge.ts     shell side of the bridge: ThingArgs view, name→URL resolution,
                coarse viewerInfo, emit + draft validation
  draft.ts      pure receipt-side validation of emit("draft") payloads (caps,
                shape, attachment-table assembly)
  events.ts     main-process event log the tests read from OUTSIDE the renderer
src/preload/
  index.ts      contextBridge exposure of a FROZEN { getArgs, getBlob,
                viewerInfo, emit } and nothing else
src/renderer/
  index.html    the trusted chrome strip (id / hash / "UNSIGNED — test harness")
test/
  things/       one .html per attack (malicious) + positive controls
  canary.ts     local TCP/HTTP/WS/UDP listener that must never receive a connection
  cage.spec.ts  the escape-attempt suite + the phase-2 bridge suite
```

The thing is loaded as `thing://<random-id>/index.html`, handled by
`protocol.handle()` on the cage's own session. The handler serves the program
**only** from an in-memory map populated before load, and attachments **only**
by resolving an admitted name to a hash and streaming that hash from the
shell-controlled store; it never touches the filesystem based on thing input,
and never touches the network.

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
pnpm dev            # launch THE SHELL with HMR (electron-vite dev server)
pnpm start          # launch the built shell from out/ (run after build)
pnpm dev:cage       # launch the legacy CAGE harness (benign thing in a bare cage)
pnpm dist           # build installers for THIS platform (see Packaging)
pnpm test:cage      # build + run the full escape suite (green wall) — mac/win/linux
pnpm test:unit      # fast pure-logic unit tests (Vitest)
pnpm typecheck
```

The **shell** is the product — the user-facing client (feed, New, trust
chrome). `package.json`'s `main` is `out/main/shell/main.js`, so `pnpm dev`
(with HMR), `pnpm start` (from the build), `pnpm preview`, `electron .`, and the
packaged installer all launch the shell. The phase-1 **cage harness**
(`out/main/index.js`) — a bare cage that renders one benign thing, used for the
escape demo — is now launched only by `pnpm dev:cage`. On a headless box add a
virtual display and disable the OS sandbox via the env var Electron reads before
JS runs (the same one `dev:nosandbox` uses):
`ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a pnpm start`.

> **Windows prerequisite.** `better-sqlite3` is a native module compiled during
> install, so a C++ toolchain must be present **before** `pnpm install`. Install
> the Visual Studio Build Tools (VC++ workload) once:
>
> ```powershell
> winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
> ```
>
> macOS (Xcode Command Line Tools) and Linux (`build-essential`, `python3`) need
> the equivalent. This is only for building from source; the packaged installers
> ship the compiled module, so end-user testers need none of it.

## Packaging (installers for testers)

`electron-builder` packages the **shell** into installers. Config is
`electron-builder.yml`; the app icon is `build/icon.png` (a placeholder —
`pnpm gen:icon` regenerates it).

```bash
pnpm dist          # installers for the current platform → release/
pnpm dist:linux    # AppImage + deb
pnpm dist:mac      # dmg + zip   (must run on macOS — Apple toolchain)
pnpm dist:win      # nsis .exe   (best run on Windows)
pnpm pack:dir      # unpacked app in release/, no installer — quick local check
```

- **The packaged app launches the shell.** `main` is the shell entry, so no
  `extraMetadata` rewrite is needed (that footgun rewrites the source
  `package.json` in place — avoided deliberately).
- **`better-sqlite3` is native** and rebuilt against the target Electron ABI
  during packaging (`npmRebuild`), then unpacked from the asar so its `.node`
  loads. Each installer therefore ships a module matching its own Electron;
  testers need no toolchain.
- **Cross-platform builds** happen in CI, not locally: a **macOS `.dmg` can only
  be built on a Mac**, and Windows `.exe` is most reliable on Windows.
  `.github/workflows/release.yml` builds all three on their own runners on a
  `v*` tag push and drafts a GitHub Release with the artifacts attached:

  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

### Signing (unsigned for now)

Alpha builds are **unsigned**, so first launch shows a warning the tester
bypasses once: macOS Gatekeeper (right-click → **Open**, or
`xattr -dr com.apple.quarantine "/Applications/Shell.app"`); Windows SmartScreen
(**More info → Run anyway**); Linux `chmod +x Shell-*.AppImage`. To sign later,
add an Apple Developer ID + notarization creds (macOS) and a code-signing cert
(Windows) as CI secrets — electron-builder reads them from the environment; no
config change beyond providing the certs.

`pnpm test:cage` prints a wall — one line per attack, all green when the cage
holds — ending in `CAGE HOLDS  <n>/<n> attempts blocked, positive test passed.`,
followed by the **OS-sandbox status** for that run. Under Playwright the OS
sandbox is off (see below), so the banner reads `(OS SANDBOX: OFF — Layer 1 not
exercised; --no-sandbox)`. That qualifier is deliberate: the behavioral
guarantees below do not depend on Layer 1, and the banner must never let a green
wall imply the OS sandbox was exercised when it was not (finding P0-1). The
`harness integrity` test records the sandbox state from a real launch and fails
unless a `--no-sandbox` run is explicitly acknowledged with
`CAGE_ALLOW_NO_SANDBOX=1` (which `pnpm test:cage` sets).

`pnpm test:cage` is cross-platform: a small Node launcher
(`scripts/run-cage-tests.mjs`) sets `CAGE_ALLOW_NO_SANDBOX` on the child (no
POSIX-only `VAR=value` prefix, so Windows `cmd` is fine) and only wraps the run
in `xvfb-run` on **headless Linux** where it is installed — macOS, Windows, and
any desktop with a display server run Playwright directly, no X server required.
The `test` workflow runs the suite on all three OSes on every push/PR.

### How egress is verified (from outside the page)

Each malicious thing receives the canary's URLs through the legitimate bridge
(`getArgs().args.canary`) and tries to beacon to them. The suite then asserts, from
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
rely on it. Rather than assert this in prose alone, the app records the measured
sandbox state at startup (`--no-sandbox` seen via `app.commandLine.hasSwitch`,
plus the env var), the `harness integrity` test reads it back from a real
launch, and the reporter prints it in the banner — so the claim here is one the
suite demonstrates, not one you have to take on trust. A static Vitest assertion
(`test/unit/hardening.test.ts`) separately guards every `webPreferences` Layer 1
flag, because no behavioral test can catch a refactor that drops `sandbox: true`
(every behavioral test passes with it off).

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

Signing and envelope assembly, sealing/encryption, the keyring and any key
material in the shell, the review/confirm UI, `requestFile()` and file-picking,
request/response `emit`, Ethereum/Nostr identity, naming/ENS, torrent transport,
the SQLite index, the feed UI, versioning, code signing, auto-update. The bridge
holds no keys, does no crypto, opens no network, and reads only the local
content-addressed (or ephemeral) blob store behind the existing handler. Search
the code for `// LATER:` for the places that leave room for what comes next.
