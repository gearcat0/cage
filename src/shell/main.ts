import { app, BaseWindow, WebContentsView, ipcMain, protocol, session, dialog, webContents } from 'electron'
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
import { CasStore, EphemeralStore } from '../main/store.js'
import { installBridge, setPublishObserver, setPreviewObserver, type ThingMode } from '../main/bridge.js'
import type { Draft } from '../main/draft.js'
import {
  admitBundle,
  buildBundle,
  encodeEnvelope,
  encodeManifest,
  fromHex,
  hash,
  jsToCbor,
  parseBundle,
  toHex,
  DEFAULT_BUNDLE_LIMITS,
  type AdmissionResult,
  type Attachment,
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

// Hermetic profile: when SHELL_USER_DATA_DIR is set (tests, alternate
// profiles), move Electron's OWN userData there too. Otherwise the default
// session's storage (e.g. the chrome's safety-ack localStorage) lands in the
// shared ~/.config profile and leaks state between every run on the machine —
// which made test outcomes depend on whether a human had ever clicked
// "I understand" in some unrelated session.
if (process.env.SHELL_USER_DATA_DIR) app.setPath('userData', process.env.SHELL_USER_DATA_DIR)

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
  /** Switch the open thing's mode (same path as the chrome toggle). */
  setMode?: (mode: 'view' | 'edit') => Promise<'view' | 'edit'>
  /** TEST: active mode + the wcIds of the cages, for spec targeting. */
  modeState?: () => {
    activeMode: 'view' | 'edit'
    viewWcId: number | null
    editWcId: number | null
    previewWcId: number | null
  } | null
  /** Copy a thing (new instance, same program/type/args/attachments, your key). */
  copyThing?: (envelopeHash: string) => Promise<Record<string, unknown>>
  /** Delete a thing from the library (+ blob GC + seed removal). */
  deleteThing?: (envelopeHash: string) => Record<string, unknown>
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

  // ── The open thing: up to TWO cages, one per mode ──────────────────────────
  // The shell owns view/edit switching; the program renders whichever mode it
  // is told via getArgs().mode. Both cages stay alive while the thing is open
  // (only one visible) so in-progress edit state survives toggling — cages are
  // ephemeral by design, so a remount would wipe the form. The edit cage
  // mounts lazily on first switch. wcIds is recorded at BIND time (before the
  // program loads — a thing can emit publish during its own load, well before
  // mountThing resolves) so an emit from either cage is confirmable.
  interface OpenThing {
    stored: StoredThing
    envelopeHash: string
    /** Header facts (+ verified name) cached for same-hash reopen. */
    header: Record<string, unknown>
    view: MountedThing | null // null only while the initial mount is in flight
    edit: MountedThing | null // lazily mounted on first switch to edit
    editMounting: Promise<MountedThing> | null
    /** Live preview of the UNPUBLISHED draft: the same program mounted in view
     *  mode with the args the edit cage last emitted on the "draft" channel.
     *  Shown in place of the signed view while it exists — under a chrome
     *  badge that says so, never under "✓ signed". */
    preview: MountedThing | null
    previewMounting: boolean
    pendingDraft: Draft | null
    draftTimer: ReturnType<typeof setTimeout> | null
    activeMode: ThingMode
    wcIds: Set<number>
  }
  let current: OpenThing | null = null

  function destroyCurrent(): void {
    if (!current) return
    const o = current
    current = null
    if (o.draftTimer) clearTimeout(o.draftTimer)
    o.view?.destroy()
    o.edit?.destroy()
    o.preview?.destroy()
    // An edit mount still in flight is destroyed when it lands.
    if (o.editMounting) void o.editMounting.then((m) => m.destroy()).catch(() => {})
  }

  function applyVisibility(): void {
    if (!current) return
    // While a publish confirm is pending OR the chrome has a modal overlay
    // open (compose, delete confirm, safety notice), hide BOTH cages: modals
    // live in chrome pixels, and the cage views are native siblings composited
    // ABOVE the chrome — they would overpaint the modal, leaving the user a
    // dimmed, unclickable shell with no visible prompt.
    const occluded = pendingConfirms.size > 0 || chromeOverlays > 0
    const showPreview = current.activeMode === 'view' && current.preview !== null
    current.view?.view.setVisible(!occluded && current.activeMode === 'view' && !showPreview)
    current.preview?.view.setVisible(!occluded && showPreview)
    current.edit?.view.setVisible(!occluded && current.activeMode === 'edit')
  }

  // Chrome-side modal overlays announce themselves so the cages can yield.
  let chromeOverlays = 0
  ipcMain.on('shell:overlay', (_e, delta: unknown) => {
    if (delta !== 1 && delta !== -1) return
    chromeOverlays = Math.max(0, chromeOverlays + delta)
    applyVisibility()
  })

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
    // ALL cages get bounds — hidden ones must be right-sized when revealed.
    const rect = cageRect()
    current?.view?.view.setBounds(rect)
    current?.edit?.view.setBounds(rect)
    current?.preview?.view.setBounds(rect)
  }
  win.on('resize', layout)

  function applyZoom(): void {
    const z = zoomFactor()
    chrome.webContents.setZoomFactor(z)
    for (const m of [current?.view, current?.edit, current?.preview]) {
      if (m && !m.view.webContents.isDestroyed()) m.view.webContents.setZoomFactor(z)
    }
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

  function notifyModeChanged(mode: ThingMode): void {
    chrome.webContents.send('shell:mode-changed', { mode, preview: current?.preview != null })
  }

  async function openThing(envelopeHash: string): Promise<Record<string, unknown>> {
    // Same-hash reopen is a mode reset, NOT a remount — unsaved edit state
    // survives, and "open always lands in view" still holds.
    if (current && current.envelopeHash === envelopeHash && current.view) {
      await setMode('view')
      library.markRead(envelopeHash)
      notifyFeedChanged()
      return { ...current.header, mode: 'view' }
    }
    const stored = library.load(envelopeHash)
    if (!stored) return { error: 'not found or not mountable (sealed)' }
    destroyCurrent()
    const o: OpenThing = {
      stored,
      envelopeHash,
      header: {},
      view: null,
      edit: null,
      editMounting: null,
      preview: null,
      previewMounting: false,
      pendingDraft: null,
      draftTimer: null,
      activeMode: 'view',
      wcIds: new Set()
    }
    // Set BEFORE the await: a publish emitted during load must find `current`.
    current = o
    const m = await mountThing({
      win,
      preloadPath: CAGE_PRELOAD,
      stored,
      bounds: cageRect(),
      mode: 'view',
      onBound: (wcId) => o.wcIds.add(wcId)
    })
    if (current !== o) {
      // Raced by a newer open — this mount lost.
      m.destroy()
      return { error: 'superseded' }
    }
    o.view = m
    // The new cage joins the app-level zoom: same factor, zoom keys watched.
    watchZoomKeys(m.view.webContents)
    applyVisibility()
    applyZoom()
    library.markRead(envelopeHash)
    notifyFeedChanged()
    // The verified primary name for the author — a chrome trust signal. Shown
    // ONLY when it forward+reverse-confirms against the thing's author key.
    const nv = await naming.primaryName(m.header.authorScheme, m.header.authorKey)
    o.header = { ...m.header, name: nv.status === 'verified' ? nv.name : null, nameStatus: nv.status }
    notifyModeChanged('view')
    return { ...o.header, mode: 'view' }
  }

  /** Switch the open thing's mode. The edit cage mounts lazily on first use
   *  and then stays alive (hidden) so its state survives further toggles. */
  async function setMode(mode: ThingMode): Promise<ThingMode> {
    const o = current
    if (!o || !o.view) return 'view'
    if (mode === 'edit' && !o.edit) {
      if (!o.editMounting) {
        o.editMounting = mountThing({
          win,
          preloadPath: CAGE_PRELOAD,
          stored: o.stored,
          bounds: cageRect(),
          mode: 'edit',
          onBound: (wcId) => o.wcIds.add(wcId)
        })
      }
      const m = await o.editMounting
      if (current !== o) {
        // The thing was closed/replaced while mounting; destroyCurrent's
        // in-flight cleanup owns `m` — nothing more to do here.
        return current?.activeMode ?? 'view'
      }
      if (!o.edit) {
        o.edit = m
        o.editMounting = null
        watchZoomKeys(m.view.webContents)
      }
    }
    o.activeMode = mode
    applyVisibility()
    applyZoom()
    // Hand keyboard focus to the cage that just became visible, so e.g.
    // switching to edit lets the user type immediately.
    const active = mode === 'edit' ? o.edit : (o.preview ?? o.view)
    if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus()
    notifyModeChanged(o.activeMode)
    return o.activeMode
  }

  // ── Live preview: render the unpublished draft in final form ───────────────
  // The edit cage emits its working state on the "draft" channel (same shape
  // as publish; grants nothing, confirms nothing). The shell mounts the SAME
  // program in view mode with the draft's args — the preview goes through the
  // identical path a published instance would, so what you preview is exactly
  // what you would publish.

  /** Synthesize the StoredThing a draft WOULD be if published: same program,
   *  the draft's type/args/attachments, blobs served from an ephemeral store
   *  (they exist nowhere on disk — nothing was signed or persisted). */
  function previewStoredFrom(stored: StoredThing, draft: Draft): StoredThing {
    const store = new EphemeralStore()
    const att = new Map<string, Attachment>()
    for (const [name, bytes] of Object.entries(draft.blobs)) {
      store.put(bytes)
      const a = draft.att[name]!
      att.set(name, { h: fromHex(a.h), m: a.m, n: a.n })
    }
    return {
      row: stored.row,
      program: stored.program,
      manifest: { v: 1, prog: stored.manifest.prog, type: draft.type, args: jsToCbor(draft.args), att },
      store
    }
  }

  async function mountPreview(o: OpenThing): Promise<void> {
    if (o.previewMounting) return // the running mount re-checks pendingDraft when done
    const draft = o.pendingDraft
    if (!draft) return
    o.pendingDraft = null
    o.previewMounting = true
    // The user is mid-typing in the edit cage while previews remount under
    // them — note who holds focus so it can be handed back if the swap (view
    // attach/destroy) steals it. Losing focus per keystroke is unusable.
    const focusedBefore = webContents.getFocusedWebContents()?.id ?? null
    try {
      // jsToCbor may throw (e.g. float args) — keep the last good preview.
      const previewStored = previewStoredFrom(o.stored, draft)
      const m = await mountThing({
        win,
        preloadPath: CAGE_PRELOAD,
        stored: previewStored,
        bounds: cageRect(),
        mode: 'view',
        visible: false, // revealed by applyVisibility; a background load must not steal focus
        onBound: (wcId) => o.wcIds.add(wcId)
      })
      if (current !== o) {
        m.destroy()
        return
      }
      const oldPreviewId = o.preview ? o.preview.view.webContents.id : null
      if (o.preview) {
        o.preview.destroy()
        if (oldPreviewId !== null) o.wcIds.delete(oldPreviewId)
      }
      o.preview = m
      watchZoomKeys(m.view.webContents)
      applyVisibility()
      applyZoom()
      notifyModeChanged(o.activeMode)
      if (focusedBefore !== null) {
        if (o.edit && focusedBefore === o.edit.view.webContents.id) o.edit.view.webContents.focus()
        else if (focusedBefore === oldPreviewId) m.view.webContents.focus()
      }
    } catch {
      /* invalid draft — previous preview (or the signed view) stays */
    } finally {
      o.previewMounting = false
      if (o.pendingDraft && current === o) void mountPreview(o)
    }
  }

  // Coalesce keystroke-rate drafts into one remount per quiet period.
  const PREVIEW_DEBOUNCE_MS = 250
  setPreviewObserver((req) => {
    const o = current
    // Drafts drive the preview of the EDITING session: accept them only from
    // the edit cage. (The preview cage runs the same program in view mode —
    // accepting drafts from any cage would let a program remount its own
    // preview in a loop.)
    if (!o || !o.edit || req.senderId !== o.edit.view.webContents.id) return
    o.pendingDraft = req.draft
    if (o.draftTimer) return
    o.draftTimer = setTimeout(() => {
      o.draftTimer = null
      if (current === o) void mountPreview(o)
    }, PREVIEW_DEBOUNCE_MS)
    o.draftTimer.unref?.()
  })

  /** Drop the draft preview (approved publish: the draft is now a real, signed
   *  instance in the feed — the preview badge would be lying). */
  function clearPreview(): void {
    const o = current
    if (!o) return
    if (o.draftTimer) {
      clearTimeout(o.draftTimer)
      o.draftTimer = null
    }
    o.pendingDraft = null
    if (o.preview) {
      const oldId = o.preview.view.webContents.id
      o.preview.destroy()
      o.wcIds.delete(oldId)
      o.preview = null
      applyVisibility()
      notifyModeChanged(o.activeMode)
    }
  }

  /** Copy: a NEW instance signed by THIS identity carrying the exact same
   *  program, type, args (the byte-faithful CBOR value — no JS round trip),
   *  and attachments. This is the shell-level "edit the selected object"
   *  primitive: things are immutable, so editing starts by making your own
   *  copy — including of things authored by someone else. Sealed things are
   *  refused: silently republishing private content as public is a footgun. */
  async function copyThing(envelopeHash: string): Promise<Record<string, unknown>> {
    const stored = library.load(envelopeHash)
    if (!stored) return { status: 'invalid', reason: 'not found or not mountable (sealed, undecrypted)' }
    if (stored.row.sealed) return { status: 'invalid', reason: 'refusing to copy a sealed thing into a public one' }
    const attachments = new Map<string, { bytes: Uint8Array; mime?: string }>()
    for (const [name, att] of stored.manifest.att) {
      const bytes = stored.store.readAll(toHex(att.h))
      if (!bytes) return { status: 'invalid', reason: `attachment missing from store: ${name}` }
      attachments.set(name, { bytes, mime: att.m })
    }
    const tar = await buildBundle(keyring.signer, {
      program: stored.program,
      type: stored.manifest.type,
      args: stored.manifest.args,
      attachments
    })
    return ingestBytes(tar)
  }

  /** The seed store is keyed by TAR hash with no envelope index — scan and
   *  parse to find the bundle(s) whose envelope matches. Seeds are few. */
  function removeSeedsFor(envelopeHashHex: string): void {
    for (const tarHash of seedStore.list()) {
      const bytes = seedStore.readAll(tarHash)
      if (!bytes) continue
      try {
        if (toHex(hash(parseBundle(bytes).envelope)) === envelopeHashHex) seedStore.delete(tarHash)
      } catch {
        /* unparseable seed — leave it */
      }
    }
  }

  /** Delete a thing everywhere the shell holds it: close it if open, drop the
   *  library row (+ GC of now-unreferenced content blobs), and stop seeding
   *  its bundle. Copies held by others are of course unaffected — a signed
   *  thing is public and permanent once shared. */
  function deleteThing(envelopeHash: string): Record<string, unknown> {
    if (current?.envelopeHash === envelopeHash) destroyCurrent()
    const deleted = library.delete(envelopeHash)
    if (deleted) {
      removeSeedsFor(envelopeHash)
      notifyFeedChanged()
    }
    return { deleted }
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
    // Only a cage of the currently open thing may raise a confirmable publish
    // — either mode's cage: same stored program, same human confirm.
    if (!current || !current.wcIds.has(req.senderId)) return
    const stored = current.stored
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
    const timer = setTimeout(() => {
      pendingConfirms.delete(id)
      applyVisibility()
    }, PUBLISH_CONFIRM_TTL_MS)
    timer.unref?.()
    pendingConfirms.set(id, { draft: req.draft, program: stored.program, timer })
    applyVisibility() // cages hide while the human decides in chrome
    const confirmReq = { id, kind: 'publish', summary }
    shell.lastConfirm = confirmReq
    chrome.webContents.send('shell:confirm-request', confirmReq)
  })
  ipcMain.on('shell:confirm-response', (_e, id: unknown, approved: unknown) => {
    if (typeof id !== 'number' || typeof approved !== 'boolean') return
    const p = pendingConfirms.get(id)
    pendingConfirms.delete(id)
    applyVisibility() // restore the cages once nothing is pending
    if (!p) return
    clearTimeout(p.timer)
    if (!approved) {
      shell.lastPublish = { status: 'denied' }
      return
    }
    clearPreview()
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
  ipcMain.handle('shell:set-mode', (_e, mode: unknown) => setMode(mode === 'edit' ? 'edit' : 'view'))
  ipcMain.handle('shell:copy', (_e, h: unknown) =>
    typeof h === 'string' ? copyThing(h) : { status: 'invalid', reason: 'bad hash' }
  )
  ipcMain.handle('shell:delete', (_e, h: unknown) => (typeof h === 'string' ? deleteThing(h) : { deleted: false }))
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
    destroyCurrent()
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
  shell.setMode = (m) => setMode(m)
  shell.copyThing = (h) => copyThing(h)
  shell.deleteThing = (h) => deleteThing(h)
  shell.modeState = () =>
    current
      ? {
          activeMode: current.activeMode,
          viewWcId: current.view ? current.view.view.webContents.id : null,
          editWcId: current.edit ? current.edit.view.webContents.id : null,
          previewWcId: current.preview ? current.preview.view.webContents.id : null
        }
      : null
  shell.signAndAdmit = async (type: string) => {
    const program = new TextEncoder().encode('<!doctype html><h1>self-signed</h1>')
    const manifest: Manifest = { v: 1, prog: hash(program), type, args: null, att: new Map() }
    const manifestBytes = encodeManifest(manifest)
    const envelope = await encodeEnvelope({ man: hash(manifestBytes), created: 1 }, keyring.signer)
    return summarize(admitBundle({ envelope, manifest: manifestBytes, program, blobs: new Map() }))
  }
  // Load the chrome only AFTER every IPC handler and surface datum above is
  // live: the chrome's boot script invokes shell:identity + shell:feed while
  // the page is still loading, and an unregistered handler (or an undefined
  // identity) kills that boot script — which is exactly a blank feed on
  // startup, populated only by the next feed-changed event.
  dbg('chrome-load')
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) await chrome.webContents.loadURL(`${rendererUrl}/shell/chrome/index.html`)
  else await chrome.webContents.loadFile(join(__dirname, '../../renderer/shell/chrome/index.html'))
  dbg('chrome-loaded')
  layout()

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
