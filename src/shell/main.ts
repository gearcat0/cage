import { app, BaseWindow, WebContentsView, ipcMain, protocol, session, dialog } from 'electron'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { AdmissionService } from './admission/index.js'
import { Keyring } from './keyring/index.js'
import { Library, type StoredThing, type ThingRow } from './library/index.js'
import { mountThing, type MountedThing } from './mount/index.js'
import { TransportService, FileTransport, SeedTransport, WebtorrentTransport } from './transport/index.js'
import { NamingService, DirectResolver, EnsResolver, NostrResolver, type EnsClient } from './naming/index.js'
import { createMockEnsClient } from './naming/mock-ens.js'
import { createViemEnsClient } from './naming/ens-viem.js'
import { CasStore } from '../main/store.js'
import { installBridge, setPublishObserver } from '../main/bridge.js'
import type { Draft } from '../main/draft.js'
import {
  admitBundle,
  buildBundle,
  encodeEnvelope,
  encodeManifest,
  hash,
  jsToCbor,
  DEFAULT_BUNDLE_LIMITS,
  type AdmissionResult,
  type BundleLimits,
  type CborValue,
  type Manifest
} from '../format/index.js'

// ── The shell — trusted client (brief phases §1–5) ───────────────────────────
// Admission (isolated) → library (index + CAS) → mount (thing → cage) with all
// trust signals in unforgeable chrome. Keys are software-only for now.

// This entry is at out/main/shell/main.js, so out/preload and out/renderer are
// two levels up.
const CAGE_PRELOAD = join(__dirname, '../../preload/index.js')
const CHROME_PRELOAD = join(__dirname, '../../preload/shell/chrome.js')

// Layout (must match src/shell/chrome/shell.css).
const TOP_BAR = 48
const FEED_WIDTH = 300
const THING_HEADER = 44

// ── Bootstrap: privileged thing: scheme + WebRTC (before app ready) ──────────
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
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns')

// Display scale. Ctrl+/- zoom is per-webContents, so it scales the trusted
// chrome and the cage content independently and can never resize the app as a
// whole; forcing the DEVICE scale factor scales every view uniformly while all
// bounds math stays in DIP (chrome strip and cage rect keep their alignment).
// Linux defaults to 2x (no usable systemwide HiDPI signal there); SHELL_SCALE
// overrides on any platform.
const SCALE = process.env.SHELL_SCALE ?? (process.platform === 'linux' ? '2' : null)
if (SCALE) app.commandLine.appendSwitch('force-device-scale-factor', SCALE)

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** A no-op ENS client — ENS names resolve to nothing (used when viem is absent
 *  so the shell starts cleanly; live ENS is disabled until viem is installed). */
const NULL_ENS_CLIENT: EnsClient = {
  async getAddress() {
    return null
  },
  async getName() {
    return null
  },
  async getText() {
    return null
  }
}

async function makeEnsClient(): Promise<EnsClient> {
  const mock = process.env.SHELL_ENS_MOCK
  if (mock) {
    try {
      return createMockEnsClient(JSON.parse(mock))
    } catch {
      return NULL_ENS_CLIENT
    }
  }
  try {
    return await createViemEnsClient(process.env.SHELL_ENS_RPC)
  } catch {
    // viem not installed → live ENS disabled, names become unresolvable.
    return NULL_ENS_CLIENT
  }
}

function summarize(r: AdmissionResult): Record<string, unknown> {
  if (r.status === 'valid') {
    return {
      status: 'valid',
      sealed: r.sealed,
      type: r.manifest.type,
      envelopeHash: hex(r.envelopeHash),
      author: { scheme: r.envelope.author.s, k: hex(r.envelope.author.k) },
      attachments: [...r.attachments.keys()]
    }
  }
  if (r.status === 'invalid') return { status: 'invalid', reason: r.reason }
  if (r.status === 'unverifiable') return { status: 'unverifiable', scheme: r.scheme }
  return { status: 'not-for-me' }
}

function limitsFromEnv(): BundleLimits {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    ...DEFAULT_BUNDLE_LIMITS,
    maxBundleBytes: num('SHELL_MAX_BUNDLE_BYTES', DEFAULT_BUNDLE_LIMITS.maxBundleBytes),
    maxTotalBytes: num('SHELL_MAX_TOTAL_BYTES', DEFAULT_BUNDLE_LIMITS.maxTotalBytes),
    maxEntryBytes: num('SHELL_MAX_ENTRY_BYTES', DEFAULT_BUNDLE_LIMITS.maxEntryBytes)
  }
}

interface ComposeAttachment {
  name: string
  base64: string
  mime?: string
}

interface ShellSurface {
  ready: boolean
  identity?: { address: string; nostrPubkey: string; keyStorage: 'os' | 'software' }
  userDataDir?: string
  admit?: (raw: number[]) => Promise<Record<string, unknown>>
  signAndAdmit?: (type: string) => Promise<Record<string, unknown>>
  ingest?: (raw: number[]) => Promise<Record<string, unknown>>
  /** TEST: author a bundle from bytes (no native dialogs), ingest it, and return
   *  its `.thing` bytes so a fresh shell can re-admit them (the flyer round-trip). */
  compose?: (
    programBase64: string,
    type: string,
    attachments?: ComposeAttachment[]
  ) => Promise<{ outcome: Record<string, unknown>; tarBase64: string }>
  feed?: (query?: unknown) => ThingRow[]
  open?: (envelopeHash: string) => Promise<Record<string, unknown>>
  /** Fetch a locator (file:/bundle:/magnet:) then admit it. */
  fetch?: (locator: string) => Promise<Record<string, unknown>>
  /** TEST: does the seed store hold this bundle tar-hash? */
  seedHas?: (hashHex: string) => boolean
  lastConfirm?: { id: number; kind: string; summary: Record<string, unknown> } | null
  /** TEST: outcome of the most recent decided publish ({status:'denied'} on deny). */
  lastPublish?: Record<string, unknown> | null
}

const shell: ShellSurface = { ready: false, lastConfirm: null, lastPublish: null }
;(app as unknown as { __shell: ShellSurface }).__shell = shell

// Optional file-based startup tracing (SHELL_DEBUG_FILE) — off by default. Kept
// because a hang in whenReady is otherwise invisible under a headless launcher.
const dbg = (m: string): void => {
  const f = process.env.SHELL_DEBUG_FILE
  if (!f) return
  try {
    appendFileSync(f, `${Date.now()} ${m}\n`)
  } catch {
    /* ignore */
  }
}
process.on('unhandledRejection', (r) => dbg(`UNHANDLED REJECTION ${String(r)}`))

app.whenReady().then(async () => {
  dbg('ready')
  installBridge()

  // Harden the DEFAULT session (the trusted chrome's session): allow only local
  // schemes + the dev server, cancel any remote origin — defense in depth so
  // even a compromised chrome cannot beacon out. (Cages use their own sessions.)
  const rendererOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : null
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    let scheme = ''
    let origin = ''
    try {
      const u = new URL(details.url)
      scheme = u.protocol
      origin = u.origin
    } catch {
      /* malformed -> cancel */
    }
    const local =
      scheme === 'file:' || scheme === 'devtools:' || scheme === 'chrome:' || scheme === 'blob:' || scheme === 'data:'
    const dev = rendererOrigin !== null && origin === rendererOrigin
    cb({ cancel: !(local || dev) })
  })

  const userDataDir = process.env.SHELL_USER_DATA_DIR ?? app.getPath('userData')
  dbg('keyring')
  const keyring = Keyring.loadOrCreate(userDataDir)
  dbg('library')
  const library = new Library(join(userDataDir, 'library'))
  dbg('admission')
  const admission = new AdmissionService({ limits: limitsFromEnv() })
  // Seed store: retains every admitted bundle's raw tar bytes (content-addressed
  // by tar-hash) so the shell can re-serve it. `bundle:<hash>` fetches from here.
  const seedStore = new CasStore(join(userDataDir, 'seeds'))
  const fetchLimits = {
    maxBytes: numEnv('SHELL_MAX_FETCH_BYTES', 256 * 1024 * 1024),
    timeoutMs: numEnv('SHELL_FETCH_TIMEOUT_MS', 30_000)
  }
  const transport = new TransportService(fetchLimits)
    .register(new FileTransport())
    .register(new SeedTransport(seedStore))
    .register(new WebtorrentTransport())

  // ENS client: an in-memory mock for tests (deterministic, no network); a
  // viem-backed client for live use; a null client if viem is absent (ENS
  // names simply become unresolvable rather than crashing the shell).
  const ensClient = await makeEnsClient()
  const naming = new NamingService()
    .register(new DirectResolver())
    .register(new EnsResolver(ensClient))
    .register(new NostrResolver())
  dbg('window')

  // ── Window + chrome ────────────────────────────────────────────────────────
  const win = new BaseWindow({ width: 1200, height: 820, backgroundColor: '#08080a', title: 'the shell' })
  const chrome = new WebContentsView({
    webPreferences: { preload: CHROME_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.contentView.addChildView(chrome)

  let mounted: MountedThing | null = null
  // The stored thing behind the mounted cage and that cage's webContents id,
  // recorded at BIND time (before the program loads — a thing can emit publish
  // during its own load, well before mountThing resolves). Kept so an approved
  // publish can reuse the SAME program bytes for the new instance.
  let mountedStored: StoredThing | null = null
  let mountedWcId = -1

  // ── Lockstep zoom (Ctrl +/−/0) ─────────────────────────────────────────────
  // Per-webContents zoom would scale the chrome and the cage content
  // independently (the original complaint) — so zoom is a single app-level
  // state applied to BOTH views, and the native layout follows: the chrome's
  // CSS pixels grow with its zoom factor, so the cage rect must scale by the
  // same factor to stay aligned with the feed/header the chrome draws.
  let zoomLevel = 0
  const zoomFactor = (): number => Math.pow(1.2, zoomLevel)

  function cageRect(): Electron.Rectangle {
    const { width, height } = win.getContentBounds()
    const z = zoomFactor()
    const x = Math.round(FEED_WIDTH * z)
    const y = Math.round((TOP_BAR + THING_HEADER) * z)
    return { x, y, width: width - x, height: height - y }
  }
  function layout(): void {
    const { width, height } = win.getContentBounds()
    chrome.setBounds({ x: 0, y: 0, width, height })
    if (mounted) mounted.view.setBounds(cageRect())
  }
  win.on('resize', layout)

  function applyZoom(): void {
    const z = zoomFactor()
    chrome.webContents.setZoomFactor(z)
    if (mounted && !mounted.view.webContents.isDestroyed()) mounted.view.webContents.setZoomFactor(z)
    layout()
  }
  /** Take over Ctrl +/−/0 for this view. preventDefault also stops the default
   *  menu accelerators, so the per-webContents zoom never fires. Real input
   *  only — a thing's synthetic key events do not raise before-input-event. */
  function watchZoomKeys(wc: Electron.WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
      if (input.key === '+' || input.key === '=') zoomLevel = Math.min(zoomLevel + 1, 5)
      else if (input.key === '-') zoomLevel = Math.max(zoomLevel - 1, -5)
      else if (input.key === '0') zoomLevel = 0
      else return
      event.preventDefault()
      applyZoom()
    })
  }
  watchZoomKeys(chrome.webContents)

  dbg('chrome-load')
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) await chrome.webContents.loadURL(`${rendererUrl}/shell/chrome/index.html`)
  else await chrome.webContents.loadFile(join(__dirname, '../../renderer/shell/chrome/index.html'))
  dbg('chrome-loaded')
  layout()

  function notifyFeedChanged(): void {
    chrome.webContents.send('shell:feed-changed')
  }

  // ── Core operations (shared by IPC handlers and test hooks) ────────────────
  async function ingestBytes(raw: Uint8Array): Promise<Record<string, unknown>> {
    const result = await admission.admit(raw, keyring.unsealer)
    if (result.status === 'valid') {
      library.store(result, Date.now())
      // Seed the raw admitted bundle so it can be re-served by bundle:<hash>.
      seedStore.put(raw)
      notifyFeedChanged()
    }
    return summarize(result)
  }

  /** Fetch by a locator OR a name, then run it through admission. A locator is
   *  fetched directly; a name is resolved to a locator (discovery) first, and
   *  the admitted author is forward-verified against the name. The transport and
   *  resolver are content-untrusted; admission is the gate. */
  async function fetchNameOrLocator(input: string): Promise<Record<string, unknown>> {
    let locator = input
    let name: string | null = null
    if (!transport.supports(input)) {
      // Not a direct locator — resolve it as a name (discovery).
      name = input
      try {
        locator = await naming.resolve(input)
      } catch (e) {
        return { status: 'invalid', reason: `naming: ${(e as Error).message}` }
      }
    }
    let bytes: Uint8Array
    try {
      bytes = await transport.fetch(locator)
    } catch (e) {
      return { status: 'invalid', reason: `transport: ${(e as Error).message}` }
    }
    const outcome = await ingestBytes(bytes)
    // Forward-verify: if fetched BY a name, confirm the admitted thing is by
    // that name's author. A mismatch is surfaced, not silently accepted.
    if (name && outcome.status === 'valid') {
      const author = outcome.author as { scheme: string; k: string } | undefined
      if (author) {
        const v = await naming.verifyName(name, author.scheme, author.k)
        outcome.nameVerification = v
      }
    }
    return outcome
  }

  // ── Authoring: build + sign + ingest a thing (brief §7) ────────────────────
  // The mirror of ingest. buildBundle signs with the keyring Signer (format never
  // sees key bytes); the new thing is admitted + stored like any other, so the
  // author sees it in their own feed and it is seeded for `bundle:<hash>`.
  function attachmentsMap(list?: ComposeAttachment[]): Map<string, { bytes: Uint8Array; mime?: string }> {
    const att = new Map<string, { bytes: Uint8Array; mime?: string }>()
    for (const a of list ?? []) att.set(a.name, { bytes: base64ToBytes(a.base64), mime: a.mime })
    return att
  }

  async function composeAndIngest(
    programBase64: string,
    type: string,
    attachments?: ComposeAttachment[]
  ): Promise<{ tar: Uint8Array; outcome: Record<string, unknown> }> {
    const tar = await buildBundle(keyring.signer, {
      program: base64ToBytes(programBase64),
      type: type.trim() || 'page',
      attachments: attachmentsMap(attachments)
    })
    const outcome = await ingestBytes(tar)
    return { tar, outcome }
  }

  function getFeed(query: unknown): ThingRow[] {
    const q = (query ?? {}) as { type?: string; author?: string; limit?: number }
    return library.feed(q)
  }

  async function openThing(envelopeHash: string): Promise<Record<string, unknown>> {
    const stored = library.load(envelopeHash)
    if (!stored) return { error: 'not found or not mountable (sealed)' }
    if (mounted) mounted.destroy()
    mountedStored = null
    mountedWcId = -1
    mounted = await mountThing({
      win,
      preloadPath: CAGE_PRELOAD,
      stored,
      bounds: cageRect(),
      mode: 'view',
      onBound: (wcId) => {
        mountedWcId = wcId
        mountedStored = stored
      }
    })
    // The new cage joins the app-level zoom: same factor, zoom keys watched.
    watchZoomKeys(mounted.view.webContents)
    applyZoom()
    library.markRead(envelopeHash)
    notifyFeedChanged()
    // The verified primary name for the author — a chrome trust signal. Shown
    // ONLY when it forward+reverse-confirms against the thing's author key.
    const nv = await naming.primaryName(mounted.header.authorScheme, mounted.header.authorKey)
    return { ...mounted.header, name: nv.status === 'verified' ? nv.name : null, nameStatus: nv.status }
  }

  // ── Confirm flow: a thing's publish request is decided HERE, in chrome ─────
  // A pending publish holds the full draft (blob bytes included) plus the
  // program bytes captured at request time, so approval publishes exactly what
  // was mounted when the human saw the dialog — even across a remount. Bounded:
  // few pending, short TTL, deleted on response. Blob bytes never cross to the
  // chrome renderer; the dialog gets type/args/att metadata only.
  interface PendingPublish {
    draft: Draft
    program: Uint8Array
    timer: ReturnType<typeof setTimeout>
  }
  let nextConfirmId = 1
  const pendingConfirms = new Map<number, PendingPublish>()
  const MAX_PENDING_PUBLISH = 4
  const PUBLISH_CONFIRM_TTL_MS = 5 * 60_000

  /** Approved publish: rebuild a bundle with the SAME program as the mounted
   *  thing + the draft's type/args/blobs, sign with the keyring, and ingest it
   *  (admission → library → seed → feed refresh). No save dialog, no envelope
   *  chaining (path/seq/prev) — the new instance is a standalone thing in the
   *  author's own feed. */
  async function persistApprovedDraft(p: PendingPublish): Promise<Record<string, unknown>> {
    let args: CborValue
    try {
      // A draft can pass validateDraft (JSON-measured) yet not be canonical
      // CBOR — floats, say. Surface that as a failed publish, not a crash.
      args = jsToCbor(p.draft.args)
    } catch (e) {
      return { status: 'invalid', reason: `publish: ${(e as Error).message}` }
    }
    const attachments = new Map<string, { bytes: Uint8Array; mime?: string }>()
    for (const [name, bytes] of Object.entries(p.draft.blobs)) {
      // Draft blobs carry no MIME (FORMAT_SPEC_NOTES §4); validateDraft already
      // recorded application/octet-stream in the att table — reuse it.
      attachments.set(name, { bytes, mime: p.draft.att[name]?.m })
    }
    const tar = await buildBundle(keyring.signer, {
      program: p.program,
      type: p.draft.type,
      args,
      attachments
    })
    return ingestBytes(tar)
  }

  setPublishObserver((req) => {
    // Only the currently mounted cage may raise a confirmable publish.
    if (!mountedStored || req.senderId !== mountedWcId) return
    while (pendingConfirms.size >= MAX_PENDING_PUBLISH) {
      const oldest = pendingConfirms.keys().next().value as number
      clearTimeout(pendingConfirms.get(oldest)!.timer)
      pendingConfirms.delete(oldest)
    }
    const id = nextConfirmId++
    // What the human decides on: type + args + attachment table — args is
    // JSON-serializable and ≤256 KB by validateDraft.
    const summary: Record<string, unknown> = {
      type: req.draft.type,
      args: req.draft.args,
      att: req.draft.att,
      argsBytes: req.argsBytes,
      blobBytes: req.blobBytes
    }
    const timer = setTimeout(() => pendingConfirms.delete(id), PUBLISH_CONFIRM_TTL_MS)
    timer.unref?.()
    pendingConfirms.set(id, { draft: req.draft, program: mountedStored.program, timer })
    const confirmReq = { id, kind: 'publish', summary }
    shell.lastConfirm = confirmReq
    chrome.webContents.send('shell:confirm-request', confirmReq)
  })
  ipcMain.on('shell:confirm-response', (_e, id: unknown, approved: unknown) => {
    if (typeof id !== 'number' || typeof approved !== 'boolean') return
    const p = pendingConfirms.get(id)
    pendingConfirms.delete(id)
    if (!p) return
    clearTimeout(p.timer)
    if (!approved) {
      shell.lastPublish = { status: 'denied' }
      return
    }
    void persistApprovedDraft(p).then((outcome) => {
      shell.lastPublish = outcome
      chrome.webContents.send('shell:publish-result', outcome)
    })
  })

  // ── IPC surface for the chrome ─────────────────────────────────────────────
  ipcMain.handle('shell:identity', () => shell.identity)
  ipcMain.handle('shell:feed', (_e, query) => getFeed(query))
  ipcMain.handle('shell:ingest', (_e, base64: string) => ingestBytes(base64ToBytes(base64)))
  ipcMain.handle('shell:fetch', (_e, locator: string) => fetchNameOrLocator(locator))
  ipcMain.handle('shell:open', (_e, envelopeHash: string) => openThing(envelopeHash))
  ipcMain.handle(
    'shell:compose',
    async (_e, input: { programBase64: string; type: string; attachments?: ComposeAttachment[] }) => {
      const { tar, outcome } = await composeAndIngest(input.programBase64, input.type, input.attachments)
      if (outcome.status !== 'valid') return { outcome, path: null }
      // Offer to save the shareable .thing. The author already holds it (ingested
      // + seeded); saving is how it leaves this machine (the flyer model).
      const envHash = String(outcome.envelopeHash ?? 'thing')
      const safeType = (input.type.trim() || 'thing').replace(/[^a-z0-9-]/gi, '-')
      const res = await dialog.showSaveDialog(win, {
        title: 'Save thing to share',
        defaultPath: `${safeType}-${envHash.slice(0, 8)}.thing`,
        filters: [{ name: 'thing bundle', extensions: ['thing'] }]
      })
      if (res.canceled || !res.filePath) return { outcome, path: null }
      await writeFile(res.filePath, tar)
      return { outcome, path: res.filePath }
    }
  )
  ipcMain.handle('shell:close', () => {
    if (mounted) {
      mounted.destroy()
      mounted = null
      mountedStored = null
      mountedWcId = -1
    }
  })

  // ── Public + test surface ──────────────────────────────────────────────────
  shell.identity = {
    address: hex(keyring.identity.address),
    nostrPubkey: hex(keyring.identity.nostrPubkey),
    keyStorage: keyring.keyStorage
  }
  shell.userDataDir = userDataDir
  shell.admit = async (raw) => summarize(await admission.admit(Uint8Array.from(raw), keyring.unsealer))
  shell.ingest = async (raw) => ingestBytes(Uint8Array.from(raw))
  shell.fetch = (locator) => fetchNameOrLocator(locator)
  shell.compose = async (programBase64, type, attachments) => {
    const { tar, outcome } = await composeAndIngest(programBase64, type, attachments)
    return { outcome, tarBase64: bytesToBase64(tar) }
  }
  shell.seedHas = (hashHex) => seedStore.has(hashHex)
  shell.feed = (query) => getFeed(query)
  shell.open = (envelopeHash) => openThing(envelopeHash)
  shell.signAndAdmit = async (type: string) => {
    const program = new TextEncoder().encode('<!doctype html><h1>self-signed</h1>')
    const manifest: Manifest = { v: 1, prog: hash(program), type, args: null, att: new Map() }
    const manifestBytes = encodeManifest(manifest)
    const envelope = await encodeEnvelope({ man: hash(manifestBytes), created: 1 }, keyring.signer)
    return summarize(admitBundle({ envelope, manifest: manifestBytes, program, blobs: new Map() }))
  }
  shell.ready = true
  dbg('ready-done')
}).catch((e) => dbg(`whenReady FAILED ${String(e)}\n${(e as Error).stack}`))

app.on('window-all-closed', () => app.quit())

function base64ToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, 'base64')
  return new Uint8Array(bin)
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
