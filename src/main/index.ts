import { app, BaseWindow, WebContentsView, protocol, session } from 'electron'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createCage } from './cage.js'
import { installBridge, bindCage, unbindCage, type ThingArgs } from './bridge.js'
import type { CageResources, ResourceMap } from './protocol.js'
import { CasStore, EphemeralStore, type AttachmentTable } from './store.js'
import { cage as cageGlobals, record } from './events.js'

// CommonJS output (main/preload are CJS; renderer stays ESM in the browser).
// `__dirname` is provided by the bundler and points at out/main.
const PRELOAD = join(__dirname, '../preload/index.js')

// TEST-ONLY (finding 1.3): redirect Electron's userData/cache tree to a dir the
// suite controls, so the sealed-content-off-disk test can scan a known location
// for decrypted plaintext. Must run before app is ready. No effect in a real
// shell (env unset).
if (process.env.CAGE_USER_DATA_DIR) {
  app.setPath('userData', process.env.CAGE_USER_DATA_DIR)
}

// Expose the event log on the Electron `app` singleton so the Playwright suite
// can read it from OUTSIDE the renderer via `evaluate(({ app }) => app.__cage)`.
// (Playwright's main-process evaluate runs in a separate VM whose `globalThis`
// is NOT the app's, but the `app` object is shared across that boundary.)
;(app as unknown as { __cage: typeof cageGlobals }).__cage = cageGlobals

const CHROME_STRIP_HEIGHT = 44

// ── Layer 2 (bootstrap) — privileged scheme registration ─────────────────────
// Must run BEFORE app ready. `standard` gives thing: a real origin (so CSP and
// same-origin behave); `secure` lets it host inline scripts under CSP without
// being treated as insecure content. `supportFetchAPI:false` and
// `corsEnabled:false` narrow it further — a thing has no reason to fetch().
// `stream:true` lets the att/ route stream media with Range support.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'thing',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      allowServiceWorkers: false,
      stream: true
    }
  }
])

// ── Layer 3 (bootstrap) — WebRTC command-line switches ───────────────────────
// Two switches, each doing a distinct thing (finding P0-2, corrected):
//
//  1. force-webrtc-ip-handling-policy=disable_non_proxied_udp — the REAL,
//     process-wide WebRTC control. With no proxy that permits UDP (Layer 3
//     points at a dead one), no ICE candidate can carry a usable transport, so
//     WebRTC has no path out. This is the load-bearing switch; the per-contents
//     setWebRTCIPHandlingPolicy in cage.ts is the same control applied per view
//     and is now belt-and-braces to this one.
//  2. disable-features=WebRtcHideLocalIpsWithMdns — a companion, NOT a disabler.
//     It turns OFF the mDNS-hiding privacy feature, so that if a candidate ever
//     did form it would carry a raw 127.x/LAN IP rather than an `.local` name.
//     Since the dead proxy means no candidate leaves anyway, this makes a
//     hypothetical breach MORE visible to the canary, not less. It does not, by
//     itself, disable WebRTC — the name is easy to misread as if it did.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

// TEST-ONLY (finding N2): let the DNS/speculative-connection test point an
// attacker hostname at the canary via Chromium host-resolver-rules, so that any
// connection a leak produced would land on the canary and be witnessed. Gated
// on an env var the suite sets; never used in a real shell.
if (process.env.CAGE_HOST_RESOLVER_RULES) {
  app.commandLine.appendSwitch('host-resolver-rules', process.env.CAGE_HOST_RESOLVER_RULES)
}

// NOTE on the OS sandbox (finding P0-1): the cage REQUESTS the OS-level sandbox
// via webPreferences `sandbox: true`, but whether it is actually active depends
// on the launcher and host. Two ways it ends up OFF:
//   - `ELECTRON_DISABLE_SANDBOX=1` in the environment (the "dev:nosandbox"
//     accommodation for containers where the setuid helper can't self-init);
//     read by the Electron binary before JS runs.
//   - a `--no-sandbox` argv flag — which Playwright's Electron launcher injects
//     by DEFAULT, so the escape suite runs with the OS sandbox off.
// Neither weakens the behavioral guarantees (network/storage/escalation are
// enforced by contextIsolation + CSP + the request canceller + partitions,
// none of which depend on the OS sandbox); the OS sandbox is the extra backstop
// against a renderer memory-corruption exploit. Because it can be silently off,
// we record ground truth below and the reporter/suite surface it rather than
// letting a green wall imply Layer 1 was exercised when it was not.
// LATER: when the real shell needs no media at all, consider building Electron
// with WebRTC compiled out entirely.

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp'
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? 'application/octet-stream'
}

const DEFAULT_THING = `<!doctype html>
<html><head><meta charset="utf-8"><title>benign thing</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }
  pre { background: #8883; padding: 1rem; border-radius: 8px; overflow:auto; }
  .ok { color: #2a8a3e; font-weight: 600; }
</style></head>
<body>
  <h1>hello from inside the cage</h1>
  <p class="ok" id="status">running…</p>
  <p>ThingArgs passed in via the bridge:</p>
  <pre id="args">…</pre>
  <script>
    const args = window.bridge.getArgs();
    document.getElementById('args').textContent = JSON.stringify(args, null, 2);
    document.getElementById('status').textContent = 'rendered supplied args ✓';
    window.bridge.emit('hello', { rendered: true, sawArgs: args });
  </script>
</body></html>`

/** An attachment supplied to the test/dev harness: bytes come from a local
 *  file chosen by the OPERATOR (env config), never by the thing. */
interface AttSpec {
  name: string
  path: string
  mime: string
}

interface LoadSpec {
  html: string
  type: string
  args: unknown
  attachments: AttSpec[]
  /** Sealed things serve decrypted attachments from memory, never the CAS. */
  sealed: boolean
}

function specFromEnv(): { primary: LoadSpec; secondary: LoadSpec | null } {
  const primary: LoadSpec = {
    html: process.env.CAGE_THING ? readFileSync(process.env.CAGE_THING, 'utf8') : DEFAULT_THING,
    type: process.env.CAGE_TYPE ?? 'test',
    args: parseJson(process.env.CAGE_ARGS) ?? {},
    attachments: (parseJson(process.env.CAGE_ATTACHMENTS) as AttSpec[] | undefined) ?? [],
    sealed: process.env.CAGE_SEALED === '1'
  }
  // A second cage in the SAME run, with its own fresh partition — used by the
  // storage-isolation tests to prove two different things cannot see each
  // other's storage.
  const secondary: LoadSpec | null = process.env.CAGE_THING2
    ? {
        html: readFileSync(process.env.CAGE_THING2, 'utf8'),
        type: 'test',
        args: parseJson(process.env.CAGE_ARGS2) ?? {},
        attachments: [],
        sealed: false
      }
    : null
  return { primary, secondary }
}

function parseJson(s: string | undefined): unknown {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** The persistent, content-addressed store. Public things serve from here.
 *  Tests point CAGE_CAS_DIR at a temp dir so they can assert what does (and
 *  does not) get written. */
let casStore: CasStore | null = null
function cas(): CasStore {
  if (!casStore) {
    const dir =
      process.env.CAGE_CAS_DIR ?? join(process.env.XDG_DATA_HOME ?? tmpdir(), 'cage-cas')
    casStore = new CasStore(dir)
  }
  return casStore
}

/**
 * Admission-lite for the phase-2 harness: hash each supplied attachment, build
 * the manifest-style table, and place the bytes in the right store — the
 * on-disk CAS for public things, an ephemeral in-memory store for sealed ones
 * (decrypted sealed content MUST NOT be written to disk in the clear).
 *
 * LATER: the real admission pipeline (format §8.1) replaces this — decode +
 * verify envelope/manifest, then hand the SAME shapes (table + store) to the
 * cage. This function exists so the cage side is already shaped for it.
 */
function admitAttachments(spec: LoadSpec): { table: AttachmentTable; store: CageResources['store'] } {
  const store = spec.sealed ? new EphemeralStore() : cas()
  const table: AttachmentTable = new Map()
  for (const att of spec.attachments) {
    const bytes = readFileSync(att.path)
    const hash = store.put(bytes)
    table.set(att.name, { hash, mime: att.mime, size: bytes.length })
  }
  return { table, store }
}

function buildResources(id: string, html: string, spec: LoadSpec): { resources: ResourceMap; table: AttachmentTable } {
  const { table, store } = admitAttachments(spec)
  const resources: ResourceMap = new Map()
  resources.set(id, {
    blobs: new Map([
      ['index.html', { mime: mimeFor('index.html'), bytes: new TextEncoder().encode(html) }]
    ]),
    attachments: table,
    store
  })
  return { resources, table }
}

function shortHash(html: string): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 12)
}

// ── Cage id uniqueness invariant (prereq #4) ─────────────────────────────────
// Cross-id isolation rests on `fromPartition('thing-<id>')` giving a DISTINCT
// session per id. randomUUID() collisions are astronomically unlikely, but the
// invariant is load-bearing, so enforce it at the mint site rather than assume:
// a reused id would silently share a session (and thus storage + resources)
// between two cages. Fresh id or bust.
const mintedCageIds = new Set<string>()
function mintCageId(): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = randomUUID()
    if (!mintedCageIds.has(id)) {
      mintedCageIds.add(id)
      return id
    }
  }
  throw new Error('cage id mint failed: randomUUID collision (impossible in practice)')
}

/** Mount one cage into the window and load its thing. Returns when loaded. */
async function mountCage(
  win: BaseWindow,
  spec: LoadSpec,
  layout: (view: WebContentsView) => void,
  onTop: boolean
): Promise<{ id: string; hash: string }> {
  const id = mintCageId()
  const { resources, table } = buildResources(id, spec.html, spec)
  const handle = await createCage({ id, preloadPath: PRELOAD, resources })

  // Tear down per-cage state when the view is destroyed (N5, 1.3): forget the
  // bridge binding so `bindings` does not grow as the real shell mounts many
  // things, and drop the ephemeral sealed store so decrypted plaintext does
  // not linger in a main-process map beyond the cage's lifetime.
  const wc = handle.view.webContents
  wc.once('destroyed', () => {
    unbindCage(wc.id)
    const store = resources.get(id)?.store
    if (store instanceof EphemeralStore) store.clear()
    resources.delete(id)
  })

  // The decoded, read-only view the thing renders from. Names + metadata only:
  // no envelope, no prog, no hashes (see bridge.ts for the reasoning).
  const thingArgs: ThingArgs = {
    type: spec.type,
    args: spec.args,
    attachments: [...table.entries()].map(([name, e]) => ({
      name,
      mime: e.mime,
      size: e.size
    }))
  }
  bindCage(handle.view.webContents.id, { thingId: id, thingArgs, attachments: table })

  if (onTop) win.contentView.addChildView(handle.view)
  else win.contentView.addChildView(handle.view, 0)
  layout(handle.view)

  await handle.view.webContents.loadURL(`thing://${id}/index.html`)
  cageGlobals.bounds.cage = handle.view.getBounds()
  return { id, hash: shortHash(spec.html) }
}

app.whenReady().then(async () => {
  installBridge()

  // Record OS-sandbox ground truth (P0-1) so the suite can assert on it and the
  // reporter can state it. Detect `--no-sandbox` via BOTH raw argv and
  // Chromium's parsed switch table (`app.commandLine.hasSwitch`) — Playwright
  // injects the flag in a way that does not always survive in `process.argv`,
  // and the honest failure direction is to report OFF, never a false ON.
  record({
    type: 'sandbox-state',
    envDisabled: !!process.env.ELECTRON_DISABLE_SANDBOX,
    argvNoSandbox: process.argv.includes('--no-sandbox') || app.commandLine.hasSwitch('no-sandbox')
  })

  // Harden the DEFAULT session too. The untrusted thing never uses this session
  // (it gets its own partition), but the trusted chrome UI does — so allow only
  // the local schemes the chrome legitimately loads from (file/devtools/the dev
  // server) and cancel anything with a remote origin. Defense in depth: even a
  // compromised chrome UI cannot beacon out.
  const rendererOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : null
  const def = session.defaultSession
  def.webRequest.onBeforeRequest((details, cb) => {
    let scheme = ''
    let origin = ''
    try {
      const u = new URL(details.url)
      scheme = u.protocol
      origin = u.origin
    } catch {
      /* malformed -> cancel */
    }
    const localScheme =
      scheme === 'file:' ||
      scheme === 'devtools:' ||
      scheme === 'chrome:' ||
      scheme === 'blob:' ||
      scheme === 'data:'
    const isDevServer = rendererOrigin !== null && origin === rendererOrigin
    cb({ cancel: !(localScheme || isDevServer) })
  })

  const win = new BaseWindow({
    width: 1000,
    height: 760,
    backgroundColor: '#111214',
    title: 'the cage'
  })

  // ── Unspoofable chrome ────────────────────────────────────────────────────
  // The header strip is its own native WebContentsView, a sibling compositor
  // layer ABOVE the cage. The thing renders into a different view entirely, so
  // it cannot paint over, resize away, or overlay the chrome. The guarantee
  // proven here is spatial: the thing's pixels are confined to the cage rect.
  const chromeView = new WebContentsView({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.contentView.addChildView(chromeView)

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) await chromeView.webContents.loadURL(rendererUrl)
  else await chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))

  function layoutAll(): void {
    const { width, height } = win.getContentBounds()
    const chromeRect = { x: 0, y: 0, width, height: CHROME_STRIP_HEIGHT }
    const cageRect = { x: 0, y: CHROME_STRIP_HEIGHT, width, height: height - CHROME_STRIP_HEIGHT }
    chromeView.setBounds(chromeRect)
    cageGlobals.bounds.chrome = chromeRect
    cageGlobals.bounds.window = { x: 0, y: 0, width, height }
    // Cage views are laid out by the per-cage layout callback below.
    for (const v of cageChildren) v.setBounds(cageRect)
    cageGlobals.bounds.cage = cageRect
  }

  const cageChildren: WebContentsView[] = []
  const cageLayout = (view: WebContentsView): void => {
    cageChildren.push(view)
    layoutAll()
  }

  win.on('resize', layoutAll)
  layoutAll()

  const { primary, secondary } = specFromEnv()

  const info = await mountCage(win, primary, cageLayout, false)

  // Fill the chrome strip. The chrome view is our own trusted UI, so injecting
  // the id/hash directly is fine — a thing has no way to reach this view.
  await chromeView.webContents.executeJavaScript(
    `window.__setInfo && window.__setInfo(${JSON.stringify(info)})`
  )

  if (secondary) {
    // TEST-ONLY happens-before (finding P1-6): the same-run storage-isolation
    // test needs the primary to finish WRITING before the reader mounts, or the
    // reader can pass because there was nothing to find yet — not because
    // partitions are isolated. Gate the secondary mount on a named primary emit.
    const awaitChannel = process.env.CAGE_AWAIT_PRIMARY_EMIT
    if (awaitChannel) await waitForEmitChannel(awaitChannel)
    // Second cage: fresh partition, own random id. It renders on top of the
    // first for the storage-isolation and cross-id tests. Hand it the primary's
    // real id so the cross-id attack can try (and fail) to reach the primary's
    // resources from a different session — proving per-session registration.
    const secondaryWithId: LoadSpec = {
      ...secondary,
      args: { ...(secondary.args as Record<string, unknown>), primaryId: info.id }
    }
    await mountCage(win, secondaryWithId, cageLayout, true)
  }
})

/** Resolve once a `cage:emit` on `channel` has been recorded (or on timeout).
 *  Test-only, driven by CAGE_AWAIT_PRIMARY_EMIT; polls the shared event log
 *  (emit records carry their channel). */
function waitForEmitChannel(channel: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now()
    const seen = (): boolean =>
      cageGlobals.events.some((e) => e.type === 'emit' && e.channel === channel)
    if (seen()) return resolve()
    const timer = setInterval(() => {
      if (seen() || Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve()
      }
    }, 50)
  })
}

app.on('window-all-closed', () => app.quit())
