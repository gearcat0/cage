import { app, BaseWindow, Menu, WebContentsView, ipcMain, protocol, session, dialog, webContents } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { AdmissionService } from './admission/index.js'
import { Keyring, KeyringLoadError } from './keyring/index.js'
import { ethAddressHex, generateMnemonic12, mnemonicToAccounts, validatePrivkeyHex } from './keyring/hd.js'
import { z } from 'zod'
import {
  Library,
  isDraftId,
  refTarget,
  type DraftBlobInput,
  type DraftRow,
  type StoredThing,
  type ThingRow
} from './library/index.js'
import { STARTERS, starterByKey, starterBytes } from './starters/index.js'
import { mountThing, type MountedThing } from './mount/index.js'
import { TransportService, FileTransport, SeedTransport, WebtorrentTransport } from './transport/index.js'
import { NamingService, DirectResolver, EnsResolver, NostrResolver, type EnsClient } from './naming/index.js'
import { createMockEnsClient } from './naming/mock-ens.js'
import { createViemEnsClient } from './naming/ens-viem.js'
import { CasStore, EphemeralStore } from '../main/store.js'
import { installBridge, setDraftObserver, type ThingMode } from '../main/bridge.js'
import { cage as cageGlobals, record } from '../main/events.js'
import type { Draft } from '../main/draft.js'
import {
  admitBundle,
  buildBundle,
  fromHex,
  encodeEnvelope,
  encodeManifest,
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

// ── Opening a .thing from the desktop ────────────────────────────────────────
// Double-clicking a bundle (or `shell foo.thing`) must land in THIS shell's
// library, not a second copy of the app with its own database — hence the
// single-instance lock, which is keyed on the userData dir set above (so the
// test suite's per-run profiles each get their own lock).
//
// Paths arrive differently per platform: in argv on Windows/Linux (and again
// via `second-instance` when the app is already running), and as `open-file`
// events on macOS — which can fire BEFORE the app is ready, so they queue.
const pendingOpenFiles: string[] = []
/** Drains the queue once the shell is up; set inside whenReady. */
let drainOpenFiles: (() => void) | null = null

function thingPathsIn(argv: readonly string[]): string[] {
  return argv.filter((a) => !a.startsWith('-') && a.toLowerCase().endsWith('.thing') && existsSync(a))
}

function queueOpenFiles(paths: string[]): void {
  if (paths.length === 0) return
  pendingOpenFiles.push(...paths)
  drainOpenFiles?.()
}

app.on('open-file', (event, path) => {
  event.preventDefault() // macOS: we handle it, so don't let the default fire
  queueOpenFiles([path])
})

// SHELL_ALLOW_MULTI lets a developer run two shells side by side (different
// profiles) without the lock refusing the second.
// DIAGNOSTIC (SHELL_EXIT_LOG): the shell has several CLEAN exit paths, so an
// exit code of 0 does not say which one ran -- and "the app went away
// mid-test" looks identical from outside whichever it was. Record the reason.
let quitReason = 'unknown'
const noteQuit = (why: string): void => {
  quitReason = why
}
if (process.env.SHELL_EXIT_LOG) {
  app.on('quit', () => {
    try {
      appendFileSync(process.env.SHELL_EXIT_LOG!, JSON.stringify({ quitReason, pid: process.pid, at: Date.now() }) + '\n')
    } catch {
      /* diagnostics must never break a shutdown */
    }
  })
}

const singleInstance = process.env.SHELL_ALLOW_MULTI === '1' || app.requestSingleInstanceLock()
if (!singleInstance) {
  // Another shell owns this profile: it has been handed our argv via
  // `second-instance` and will open the file. Leave immediately — two
  // processes on one SQLite library is the thing to avoid.
  noteQuit('single-instance-lock-lost')
  app.exit(0)
} else {
  app.on('second-instance', (_event, argv) => {
    queueOpenFiles(thingPathsIn(argv))
    focusMainWindow?.()
  })
  queueOpenFiles(thingPathsIn(process.argv))
}

/** Raise the window when a second launch hands us a file. Set inside whenReady. */
let focusMainWindow: (() => void) | null = null

/** Our own version, read from package.json (three levels up from
 *  out/main/shell — the same relative shape inside a packaged asar). In dev
 *  the app runs as a bare file under Electron, so app.getVersion() would
 *  report ELECTRON's version, not ours. */
function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? app.getVersion()
  } catch {
    return app.getVersion()
  }
}

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
  /** TEST: outcome of the most recent .thing opened from the desktop. */
  lastFileOpen?: Record<string, unknown> | null
  /** Switch the open thing's mode (same path as the chrome toggle). */
  setMode?: (mode: 'view' | 'edit') => Promise<'view' | 'edit'>
  /** TEST: active mode + the wcIds of the cages, for spec targeting. */
  modeState?: () => {
    activeMode: 'view' | 'edit'
    viewWcId: number | null
    editWcId: number | null
    previewWcId: number | null
    previewMounting: boolean
    hasPendingDraft: boolean
    draftTimerPending: boolean
    lastPreviewKey: string | null
    previewDestroyed: boolean | null
  } | null
  /** Raise the publish confirm for the open thing's latest draft. */
  publishDraft?: () => Record<string, unknown>
  exportThing?: (envelopeHash: string) => { tarBase64: string; filename: string } | { error: string }
  /** Types the user can create something of (starters + library programs). */
  knownTypes?: () => { key: string; testKey: string; source: string; type: string; progHash: string }[]
  /** Local unsigned drafts, newest edit first. */
  drafts?: () => DraftRow[]
  newDraft?: (key: string, args?: unknown) => Record<string, unknown>
  /** Start a comment draft seeded with the target's hash. */
  newComment?: (targetHash: string) => Record<string, unknown>
  /** TEST: the attachment set a draft is holding. */
  draftBlobs?: (draftId: string) => { name: string; hash: string; mime: string; size: number }[]
  /** Things claiming to reply to a hash. */
  replies?: (targetHash: string) => { count: number; rows: ThingRow[] }
  deleteDraft?: (id: string) => Record<string, unknown>
  /** Copy a thing (new instance, same program/type/args/attachments, your key). */
  copyThing?: (envelopeHash: string) => Promise<Record<string, unknown>>
  /** Delete a thing from the library (+ blob GC + seed removal). */
  deleteThing?: (envelopeHash: string) => Record<string, unknown>
}

const shell: ShellSurface = { ready: false, lastConfirm: null, lastPublish: null, lastFileOpen: null }
;(app as unknown as { __shell: ShellSurface }).__shell = shell
// The bridge/cage event log, readable from OUTSIDE the renderer via
// `evaluate(({ app }) => app.__cage)` — same surface the cage harness exposes.
;(app as unknown as { __cage: typeof cageGlobals }).__cage = cageGlobals

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
  let keyring: Keyring
  try {
    keyring = Keyring.loadOrCreate(userDataDir)
  } catch (e) {
    // The identity file exists but is unreadable. NEVER silently regenerate —
    // the file (or a .bak sibling) may still be recoverable. Tell the human
    // and stop. (SHELL_BOOT_ERROR_FILE: tests cannot drive a native dialog.)
    const keyPath = e instanceof KeyringLoadError ? e.path : join(userDataDir, 'identity.key.enc')
    const msg =
      `Your identity file could not be read:\n\n${keyPath}\n\n` +
      `The shell will NOT overwrite it — it may still be recoverable. ` +
      `Timestamped backups (identity.key.enc.bak-<time>) may exist in the same folder; ` +
      `restoring one recovers that identity. To start with a brand-new identity instead, ` +
      `move the unreadable file out of that folder and relaunch.`
    const marker = process.env.SHELL_BOOT_ERROR_FILE
    if (marker) {
      try {
        writeFileSync(marker, msg)
      } catch {
        /* ignore */
      }
    } else {
      dialog.showErrorBox('Identity unreadable', msg)
    }
    app.exit(1)
    return
  }
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

  // ── Application menu ───────────────────────────────────────────────────────
  // Deliberately minimal: appMenu (macOS conventions), editMenu (clipboard
  // shortcuts in chrome inputs), Help → About. NO viewMenu — its zoom roles
  // would fight the app-level lockstep zoom, its reload would reload views
  // out from under the shell, and devtools must never open into a cage.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'Account & Keys…', click: () => chrome.webContents.send('shell:open-account') },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const }
        ]
      },
      { role: 'editMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'About',
            click: () => {
              void dialog.showMessageBox(win, {
                type: 'info',
                title: 'About',
                message: 'the shell',
                detail: [
                  `version ${appVersion()}`,
                  `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`
                ].join('\n')
              })
            }
          }
        ]
      }
    ])
  )

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
    /** The edit cage's wcId, recorded at BIND time — drafts are accepted from
     *  it even while it is still loading (programs emit an initial draft). */
    editWcId: number | null
    /** The most recent draft the edit cage streamed — what the preview shows,
     *  and EXACTLY what the chrome Publish button signs on approval. */
    latestDraft: Draft | null
    latestDraftMeta: { argsBytes: number; blobBytes: number } | null
    /** Identity key of the currently mounted preview (dedupe: identical
     *  drafts must not remount — that is visible flicker). */
    lastPreviewKey: string | null
    /** Non-null when this open thing is a local, UNSIGNED draft. Every draft
     *  branch keys off THIS — never off re-parsing the id. */
    draftId: string | null
    /** Autosave: the last streamed draft, and its debounce timer. */
    pendingSave: Draft | null
    saveTimer: ReturnType<typeof setTimeout> | null
    activeMode: ThingMode
    wcIds: Set<number>
  }
  let current: OpenThing | null = null

  function destroyCurrent(opts: { flush?: boolean } = {}): void {
    if (!current) return
    const o = current
    openLog('destroyCurrent', { hash: o.envelopeHash.slice(0, 12), from: new Error().stack?.split('\n')[2]?.trim().slice(0, 90) })
    current = null
    // Persist unsaved draft edits before tearing down — unless the caller is
    // deleting the draft (a flush would resurrect the row it just removed).
    if (opts.flush !== false) flushAutosave(o)
    if (o.saveTimer) clearTimeout(o.saveTimer)
    if (o.draftTimer) clearTimeout(o.draftTimer)
    o.view?.destroy()
    o.edit?.destroy()
    o.preview?.destroy()
    // An edit mount still in flight is destroyed when it lands.
    if (o.editMounting) void o.editMounting.then((m) => m.destroy()).catch(() => {})
  }

  /** Focus invariant: no HIDDEN cage may hold the keyboard. Focus lands on
   *  freshly attached views at platform-dependent moments (during load on
   *  some platforms, after it on others), so this is enforced from events +
   *  settle points rather than sequenced once. Chrome focus is never touched.
   */
  function enforceCageFocus(): void {
    const o = current
    if (!o) return
    const focused = webContents.getFocusedWebContents()
    if (!focused || !o.wcIds.has(focused.id)) return // chrome or unrelated — leave alone
    const active = o.activeMode === 'edit' ? o.edit : (o.preview ?? o.view)
    if (!active || active.view.webContents.isDestroyed()) return
    if (active.view.webContents.id === focused.id) return
    active.view.webContents.focus()
  }

  /** Watch a cage's webContents from BIND time (before its load): any focus
   *  it gains while not the active cage bounces to the active one. */
  function guardCageFocus(wcId: number): void {
    const wc = webContents.fromId(wcId)
    // setImmediate: let the focus transition settle before inspecting it.
    wc?.on('focus', () => setImmediate(enforceCageFocus))
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
    chrome.webContents.send('shell:mode-changed', {
      mode,
      preview: current?.preview != null,
      // Publish is enabled exactly when a draft exists to sign — which is also
      // how the chrome detects that the program supports the edit contract.
      publishable: current?.latestDraft != null
    })
  }

  /** DIAGNOSTIC (SHELL_EXIT_LOG): what main was ASKED to open and what it
   *  answered. A test that hangs with modeState:null cannot tell from outside
   *  whether the open was refused, never arrived, or never finished. */
  const openLog = (event: string, detail: Record<string, unknown>): void => {
    if (!process.env.SHELL_EXIT_LOG) return
    try {
      // pid: every shell in a run appends to ONE file, so without it the
      // separate processes read as a single impossible timeline.
      appendFileSync(
        process.env.SHELL_EXIT_LOG,
        JSON.stringify({ open: event, pid: process.pid, at: Date.now(), ...detail }) + '\n'
      )
    } catch {
      /* diagnostics must never break the shell */
    }
  }

  /** DIAGNOSTIC: forward the cage renderer's bridge probe lines into the trace.
   *  Only [bridge-probe] lines, and only when SHELL_EXIT_LOG is set -- a cage
   *  can say anything, so nothing else it prints is copied. */
  function probeCageConsole(wcId: number, role: string): void {
    if (!process.env.SHELL_EXIT_LOG) return
    const wc = webContents.fromId(wcId)
    if (!wc) return
    wc.on('console-message', (_e, level, message, line, sourceId) => {
      if (typeof message !== 'string') return
      if (message.startsWith('[bridge-probe]')) {
        openLog('cage:probe', { role, wcId, msg: message.slice(0, 220) })
      } else if (level === 3) {
        // Errors too: a program whose handler THROWS before reaching emit
        // looks exactly like a program that chose not to emit.
        openLog('cage:error', { role, wcId, msg: message.slice(0, 220), line, src: String(sourceId).slice(-40) })
      }
    })
  }

  async function openThing(envelopeHash: string): Promise<Record<string, unknown>> {
    openLog('request', { hash: envelopeHash.slice(0, 12), hasCurrent: current !== null })
    const draft = isDraftId(envelopeHash) ? library.getDraft(envelopeHash) : null
    if (isDraftId(envelopeHash) && !draft) return { error: 'draft not found' }
    // Same-id reopen is a mode reset, NOT a remount — unsaved edit state
    // survives. A thing lands in view; a draft is unfinished work, so it lands
    // back in edit.
    if (current && current.envelopeHash === envelopeHash && current.view) {
      await setMode(draft ? 'edit' : 'view')
      if (!draft) {
        library.markRead(envelopeHash)
        notifyFeedChanged()
      }
      // Reply facts are library state, not properties of this mount: the
      // target may have been deleted and comments may have arrived since the
      // header was built. Recompute them rather than serve a stale claim.
      const claimedNow = refTarget(current.stored.manifest.args)
      current.header = {
        ...current.header,
        replyTo: claimedNow,
        replyToKnown: claimedNow ? library.get(claimedNow) !== null : false,
        replyCount: draft ? 0 : library.countRefsTo(envelopeHash)
      }
      return { ...current.header, mode: current.activeMode }
    }
    const stored = draft ? draftStoredFrom(draft) : library.load(envelopeHash)
    if (!stored) {
      openLog('refused', { hash: envelopeHash.slice(0, 12), why: draft ? 'draft program missing' : 'not loadable' })
      return { error: draft ? 'draft program missing from the store' : 'not found or not mountable (sealed)' }
    }
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
      editWcId: null,
      latestDraft: null,
      latestDraftMeta: null,
      lastPreviewKey: null,
      draftId: draft ? draft.id : null,
      pendingSave: null,
      saveTimer: null,
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
      zoomFactor: zoomFactor(),
      onBound: (wcId) => {
        o.wcIds.add(wcId)
        guardCageFocus(wcId)
        probeCageConsole(wcId, 'view')
      }
    })
    if (current !== o) {
      // Raced by a newer open — this mount lost. NOTE: if `current` was nulled
      // (destroyCurrent) rather than replaced, nothing re-sets it, and the
      // shell is left with nothing mounted.
      openLog('superseded', { hash: envelopeHash.slice(0, 12), currentIsNull: current === null })
      m.destroy()
      return { error: 'superseded' }
    }
    openLog('mounted', { hash: envelopeHash.slice(0, 12) })
    o.view = m
    m.view.webContents.once('render-process-gone', (_e, details) => {
      record({ type: 'cage-gone', role: 'view', reason: details.reason, exitCode: details.exitCode })
    })
    // The new cage joins the app-level zoom: same factor, zoom keys watched.
    watchZoomKeys(m.view.webContents)
    applyVisibility()
    applyZoom()
    if (!draft) {
      library.markRead(envelopeHash)
      notifyFeedChanged()
    }
    // The verified primary name for the author — a chrome trust signal. Shown
    // ONLY when it forward+reverse-confirms against the thing's author key.
    // A draft is unsigned and authored by nobody yet: no name lookup, and the
    // header must say DRAFT rather than "signed".
    const nv = draft ? null : await naming.primaryName(m.header.authorScheme, m.header.authorKey)
    // What this thing CLAIMS to reply to, and whether we hold that target.
    // The claim is unauthenticated (anyone may claim to reply to anything);
    // the chrome says so and never dresses it as verification.
    const claimed = refTarget(stored.manifest.args)
    o.header = {
      ...m.header,
      name: nv?.status === 'verified' ? nv.name : null,
      nameStatus: nv?.status ?? null,
      draft: draft !== null,
      replyTo: claimed,
      replyToKnown: claimed ? library.get(claimed) !== null : false,
      replyCount: draft ? 0 : library.countRefsTo(envelopeHash)
    }
    if (draft) await setMode('edit') // unfinished work opens ready to edit
    notifyModeChanged(o.activeMode)
    return { ...o.header, mode: o.activeMode }
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
          zoomFactor: zoomFactor(),
          onBound: (wcId) => {
            o.wcIds.add(wcId)
            guardCageFocus(wcId)
            // Recorded BEFORE the program loads: an initial draft emitted
            // during the edit cage's own load must be accepted.
            o.editWcId = wcId
            probeCageConsole(wcId, 'edit')
          }
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
        m.view.webContents.once('render-process-gone', (_e, details) => {
          record({ type: 'cage-gone', role: 'edit', reason: details.reason, exitCode: details.exitCode })
        })
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

  // ── Known types, local drafts ──────────────────────────────────────────────
  // "New" offers the built-in starters plus every distinct program already in
  // the library, so a type a friend sent you is something you can make too.
  // Picking one creates an UNSIGNED local draft: it lives only here, autosaves
  // as you type, and is consumed when you publish it.

  interface KnownTypeEntry {
    key: string
    /** Identifier-safe key for chrome data-testids. */
    testKey: string
    source: 'starter' | 'library'
    type: string
    progHash: string
    label: string
    description: string
    count: number
  }

  /** Program hashes of the built-in starters (their bytes are compile-time
   *  constants, so this is computed once). */
  const starterHashes = new Map<string, string>()
  for (const st of STARTERS) starterHashes.set(st.key, toHex(hash(starterBytes(st))))

  function knownTypes(): KnownTypeEntry[] {
    const out: KnownTypeEntry[] = STARTERS.map((st) => ({
      key: st.key,
      testKey: `starter-${st.type}`,
      source: 'starter' as const,
      type: st.type,
      progHash: starterHashes.get(st.key)!,
      label: st.label,
      description: st.description,
      count: 0
    }))
    const seen = new Set(out.map((e) => `${e.type}\u0000${e.progHash}`))
    for (const k of library.distinctTypes()) {
      const id = `${k.type}\u0000${k.progHash}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        key: `library:${id}`,
        testKey: `library-${k.progHash.slice(0, 8)}`,
        source: 'library',
        type: k.type,
        progHash: k.progHash,
        label: k.type,
        description: `${k.count} in your library`,
        count: k.count
      })
    }
    return out
  }

  /** Synthesize the StoredThing a DRAFT is: its program from the CAS, the args
   *  typed so far, no attachments, nothing signed. Same precedent as
   *  previewStoredFrom — mountThing never verifies a signature. */
  function draftStoredFrom(d: DraftRow): StoredThing | null {
    const program = library.readProgram(d.progHash)
    if (!program) return null
    const row: ThingRow = {
      envelopeHash: d.id,
      authorScheme: keyring.signer.scheme,
      authorKey: hex(keyring.identity.address),
      type: d.type,
      progHash: d.progHash,
      manifestHash: '', // nothing was signed, so no manifest exists
      receivedAt: d.updated,
      created: d.created,
      path: null,
      seq: null,
      sealed: false,
      read: true,
      isFork: false
    }
    // The draft's attachments, rebuilt from the CAS. A hash the store no longer
    // holds degrades to "no image" rather than an unmountable draft.
    const att = new Map<string, Attachment>()
    for (const b of library.draftBlobs(d.id)) {
      if (!library.casStore.has(b.hash)) continue
      att.set(b.name, { h: fromHex(b.hash), m: b.mime, n: b.size })
    }
    return {
      row,
      program,
      manifest: { v: 1, prog: hash(program), type: d.type, args: jsToCbor(d.args ?? null), att },
      // The CAS, so getBlob/att-serving and {carry:true} all work on a draft.
      store: library.casStore
    }
  }

  // Autosave. Slower than the 600ms preview debounce so the sqlite write never
  // lands on a remount frame.
  const AUTOSAVE_DEBOUNCE_MS = 800

  function flushAutosave(o: OpenThing): boolean {
    const d = o.pendingSave
    o.pendingSave = null
    if (!d || !o.draftId) return false
    // Persist only args that can become canonical CBOR — publishing rejects the
    // rest anyway (floats, say), and a draft that cannot be re-encoded would
    // throw when reopened.
    try {
      jsToCbor(d.args)
    } catch {
      return false
    }
    if (!library.updateDraftArgs(o.draftId, d.args, d.type, Date.now())) return false
    // Persist the attachment SET as well, reusing the hashes validateDraft
    // already computed — autosave must never re-hash megabytes. Bytes are
    // lazy: only a hash the CAS lacks is actually read.
    const entries: DraftBlobInput[] = []
    for (const [name, a] of Object.entries(d.att)) {
      entries.push({ name, hash: a.h, mime: a.m, size: a.n, bytes: () => d.blobs[name]! })
    }
    for (const name of d.carry) {
      const a = o.stored.manifest.att.get(name)
      if (!a) continue // unresolvable carry: keep whatever is already stored
      const hashHex = toHex(a.h)
      entries.push({
        name,
        hash: hashHex,
        mime: a.m,
        size: a.n,
        bytes: () => o.stored.store.readAll(hashHex)!
      })
    }
    library.setDraftBlobs(o.draftId, entries)
    return true
  }

  function scheduleAutosave(o: OpenThing, draft: Draft): void {
    o.pendingSave = draft
    if (o.saveTimer) return
    o.saveTimer = setTimeout(() => {
      o.saveTimer = null
      flushAutosave(o)
    }, AUTOSAVE_DEBOUNCE_MS)
    o.saveTimer.unref?.()
  }

  /** Start a new local draft of a known type. Returns its id; the chrome then
   *  opens it (in edit mode). */
  function newDraft(key: unknown, argsSeed?: unknown): Record<string, unknown> {
    if (typeof key !== 'string') return { error: 'bad type key' }
    // A seed must survive the same trip the program's own args do: JSON for
    // the drafts table, canonical CBOR at signing time, within the args cap.
    let seed: unknown = undefined
    if (argsSeed !== undefined && argsSeed !== null) {
      try {
        const json = JSON.stringify(argsSeed)
        if (typeof json !== 'string' || Buffer.byteLength(json) > 256 * 1024) throw new Error('too large')
        jsToCbor(argsSeed)
        seed = argsSeed
      } catch {
        return { error: 'bad args seed' }
      }
    }
    const starter = starterByKey(key)
    let type: string
    let progHash: string
    if (starter) {
      type = starter.type
      progHash = library.putProgram(starterBytes(starter))
    } else {
      // Re-resolve library keys against the CURRENT known types — a renderer
      // must never be able to pin an arbitrary CAS blob as a program.
      const entry = knownTypes().find((k) => k.key === key && k.source === 'library')
      if (!entry) return { error: 'unknown type' }
      type = entry.type
      progHash = entry.progHash
    }
    const row = library.createDraft({ type, progHash, args: seed })
    notifyFeedChanged()
    return { id: row.id, type: row.type }
  }

  const HEX64 = /^[0-9a-f]{64}$/

  /** Start a comment on an existing thing. The program cannot learn a hash on
   *  its own (getArgs withholds the envelope, deliberately), so the SHELL puts
   *  the target in the draft's args — an ordinary arg the human chose, not a
   *  new bridge capability. */
  function newComment(targetHash: unknown): Record<string, unknown> {
    if (typeof targetHash !== 'string' || !HEX64.test(targetHash)) return { error: 'bad hash' }
    if (!library.get(targetHash)) return { error: 'that thing is not in your library' }
    return newDraft('starter:comment', { replyTo: targetHash })
  }

  function deleteDraft(id: string): Record<string, unknown> {
    if (!isDraftId(id)) return { deleted: false }
    // Discard (no flush) — a pending autosave would resurrect the row.
    if (current?.draftId === id) destroyCurrent({ flush: false })
    const deleted = library.deleteDraft(id)
    if (deleted) notifyFeedChanged()
    return { deleted }
  }

  /** Resolve a draft's full attachment set: inline blobs as sent (mime from
   *  the validated att table), carry-over names from the mounted instance's
   *  own manifest + store — "keep my current image", declared by name because
   *  a program can display its attachments but cannot read their bytes.
   *  Throws when a carried name does not exist on the instance. */
  function resolveDraftAttachments(stored: StoredThing, draft: Draft): Map<string, { bytes: Uint8Array; mime?: string }> {
    const out = new Map<string, { bytes: Uint8Array; mime?: string }>()
    for (const [name, bytes] of Object.entries(draft.blobs)) {
      out.set(name, { bytes, mime: draft.att[name]?.m })
    }
    for (const name of draft.carry) {
      const att = stored.manifest.att.get(name)
      const bytes = att ? stored.store.readAll(toHex(att.h)) : null
      if (!att || !bytes) throw new Error(`carry-over attachment is not on this instance: ${name}`)
      out.set(name, { bytes, mime: att.m })
    }
    return out
  }

  /** Synthesize the StoredThing a draft WOULD be if published: same program,
   *  the draft's type/args/attachments, blobs served from an ephemeral store
   *  (they exist nowhere on disk — nothing was signed or persisted). */
  function previewStoredFrom(stored: StoredThing, draft: Draft): StoredThing {
    const store = new EphemeralStore()
    const att = new Map<string, Attachment>()
    for (const [name, { bytes, mime }] of resolveDraftAttachments(stored, draft)) {
      store.put(bytes)
      att.set(name, { h: hash(bytes), m: mime ?? 'application/octet-stream', n: bytes.length })
    }
    return {
      row: stored.row,
      program: stored.program,
      manifest: { v: 1, prog: stored.manifest.prog, type: draft.type, args: jsToCbor(draft.args), att },
      store
    }
  }

  async function mountPreview(o: OpenThing): Promise<void> {
    if (o.previewMounting) {
      openLog('preview:busy', { hasPending: o.pendingDraft !== null })
      return // the running mount re-checks pendingDraft when done
    }
    const draft = o.pendingDraft
    if (!draft) {
      openLog('preview:nothing-pending', {})
      return
    }
    o.pendingDraft = null
    o.previewMounting = true
    openLog('preview:start', { hash: o.envelopeHash.slice(0, 12), key: draftKey(draft).slice(0, 60) })
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
        zoomFactor: zoomFactor(),
        onBound: (wcId) => {
          o.wcIds.add(wcId)
          guardCageFocus(wcId)
          probeCageConsole(wcId, 'preview')
        }
      })
      if (current !== o) {
        openLog('preview:superseded', { hash: o.envelopeHash.slice(0, 12) })
        m.destroy()
        return
      }
      openLog('preview:mounted', { hash: o.envelopeHash.slice(0, 12), wcId: m.view.webContents.id })
      const oldPreviewId = o.preview ? o.preview.view.webContents.id : null
      if (o.preview) {
        o.preview.destroy()
        if (oldPreviewId !== null) o.wcIds.delete(oldPreviewId)
      }
      o.preview = m
      o.lastPreviewKey = draftKey(draft)
      // A renderer can die under memory pressure (CI boxes especially). A dead
      // cage left installed shows as a frozen preview that never updates
      // again, with nothing said about it — so record it and rebuild from the
      // latest draft.
      m.view.webContents.once('render-process-gone', (_e, details) => {
        record({ type: 'cage-gone', role: 'preview', reason: details.reason, exitCode: details.exitCode })
        if (current !== o || o.preview !== m) return
        o.preview = null
        o.lastPreviewKey = null
        applyVisibility()
        notifyModeChanged(o.activeMode)
        if (o.latestDraft) {
          o.pendingDraft = o.latestDraft
          void mountPreview(o)
        }
      })
      watchZoomKeys(m.view.webContents)
      applyVisibility()
      applyZoom()
      notifyModeChanged(o.activeMode)
      // The user may be mid-typing in the edit cage while previews remount
      // under them — losing focus per keystroke is unusable. The per-cage
      // focus guard (guardCageFocus, attached at bind) bounces event-driven
      // steals; these settle-point checks catch platforms where the steal
      // emits no focus event or lands late after the swap.
      enforceCageFocus()
      const settle = setTimeout(enforceCageFocus, 250)
      settle.unref?.()
    } catch (e) {
      // Previously swallowed whole. An invalid draft (float args, say) is an
      // expected miss and the last good preview stays -- but a FAILED MOUNT
      // lands here too, and then the preview simply never appears, with
      // nothing said and no retry: pendingDraft was cleared above, so the
      // finally below has nothing to re-run. Silence made the two
      // indistinguishable from outside.
      openLog('preview:failed', { hash: o.envelopeHash.slice(0, 12), why: (e as Error).message?.slice(0, 120) })
      record({ type: 'preview-failed', reason: (e as Error).message ?? 'unknown' })
    } finally {
      o.previewMounting = false
      if (o.pendingDraft && current === o) void mountPreview(o)
    }
  }

  /** Identity of a draft for preview dedupe: type + args + the attachment
   *  TABLE (name → hash/mime/size covers the blob bytes) + carry-over names. */
  function draftKey(draft: Draft): string {
    return JSON.stringify([draft.type, draft.args, draft.att, draft.carry])
  }

  // Coalesce keystroke-rate drafts into one remount per quiet period.
  const PREVIEW_DEBOUNCE_MS = 600
  setDraftObserver((req) => {
    const o = current
    // Drafts drive the editing session: accept them only from the edit cage
    // (recorded at bind time, so a program's initial draft during its own
    // load counts). The preview cage runs the same program in view mode —
    // accepting drafts from any cage would let a program remount its own
    // preview in a loop.
    if (!o || o.editWcId === null || req.senderId !== o.editWcId) {
      // The one draft path with no record of itself. A program whose drafts
      // are all rejected looks exactly like a program that stopped emitting.
      openLog('draft:rejected', {
        why: !o ? 'nothing open' : o.editWcId === null ? 'no edit cage' : 'sender is not the edit cage',
        senderId: req.senderId,
        editWcId: o ? o.editWcId : null
      })
      return
    }
    const publishableBefore = o.latestDraft != null
    // The latest draft is what the chrome Publish button signs.
    o.latestDraft = req.draft
    o.latestDraftMeta = { argsBytes: req.argsBytes, blobBytes: req.blobBytes }
    // Autosave BEFORE the preview dedupe below: a draft identical to the last
    // PREVIEWED one still has to be persisted (type-then-undo, or the first
    // draft after reopening). No notifyFeedChanged — that would rebuild the
    // feed DOM on every keystroke.
    if (o.draftId) scheduleAutosave(o, req.draft)
    if (!publishableBefore) notifyModeChanged(o.activeMode) // enable Publish
    // Identical draft → identical preview: skip the remount (visible flicker).
    if (o.lastPreviewKey !== null && draftKey(req.draft) === o.lastPreviewKey) {
      openLog('draft:dedupe-skip', { key: draftKey(req.draft).slice(0, 50) })
      o.pendingDraft = null
      return
    }
    openLog('draft:accepted', { key: draftKey(req.draft).slice(0, 50), timerPending: o.draftTimer !== null })
    o.pendingDraft = req.draft
    if (o.draftTimer) return
    o.draftTimer = setTimeout(() => {
      o.draftTimer = null
      openLog('draft:timer-fired', { hasPending: o.pendingDraft !== null, mounting: o.previewMounting })
      if (current === o) void mountPreview(o)
    }, PREVIEW_DEBOUNCE_MS)
    o.draftTimer.unref?.()
  })

  /** Drop the draft state (approved publish: the draft is now a real, signed
   *  instance in the feed — the preview badge would be lying, and Publish
   *  disables until the program streams a new draft). */
  function clearPreview(): void {
    const o = current
    if (!o) return
    if (o.draftTimer) {
      clearTimeout(o.draftTimer)
      o.draftTimer = null
    }
    o.pendingDraft = null
    o.latestDraft = null
    o.latestDraftMeta = null
    o.lastPreviewKey = null
    if (o.preview) {
      const oldId = o.preview.view.webContents.id
      o.preview.destroy()
      o.wcIds.delete(oldId)
      o.preview = null
      applyVisibility()
    }
    notifyModeChanged(o.activeMode)
  }

  /** Copy: a NEW instance signed by THIS identity carrying the exact same
   *  program, type, args (the byte-faithful CBOR value — no JS round trip),
   *  and attachments. This is the shell-level "edit the selected object"
   *  primitive: things are immutable, so editing starts by making your own
   *  copy — including of things authored by someone else. Sealed things are
   *  refused: silently republishing private content as public is a footgun. */
  async function copyThing(envelopeHash: string): Promise<Record<string, unknown>> {
    if (isDraftId(envelopeHash)) {
      return { status: 'invalid', reason: 'this is an unpublished draft — publish it first' }
    }
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
   *  parse to find the tar hash(es) whose envelope matches. Seeds are few.
   *  If this ever gets expensive the answer is an envelope->tar index TABLE
   *  (the library has no schema versioning, so never a new column). */
  function seedTarHashesFor(envelopeHashHex: string): string[] {
    const found: string[] = []
    for (const tarHash of seedStore.list()) {
      const bytes = seedStore.readAll(tarHash)
      if (!bytes) continue
      try {
        if (toHex(hash(parseBundle(bytes).envelope)) === envelopeHashHex) found.push(tarHash)
      } catch {
        /* unparseable seed — leave it */
      }
    }
    return found
  }

  function removeSeedsFor(envelopeHashHex: string): void {
    // Every match, not just the first: the same envelope can arrive in more
    // than one tar, and deleting a thing must stop seeding all of them.
    for (const tarHash of seedTarHashesFor(envelopeHashHex)) seedStore.delete(tarHash)
  }

  /** The bytes of a thing, ready to leave this machine as a .thing file.
   *
   *  These are the ORIGINAL admitted tar bytes, straight from the seed store —
   *  never a rebuild. buildBundle signs with the local keyring (that is what
   *  copyThing wants), so rebuilding here would re-author the thing: a thing
   *  received from someone else would leave over YOUR signature, and your own
   *  would arrive elsewhere under a different envelope hash. Copying the bytes
   *  keeps the signature, the hash, and the author intact, which is the whole
   *  point of a bundle being a flyer.
   *
   *  A sealed thing therefore exports its original ENCRYPTED tar — decrypted
   *  plaintext never reaches the disk (§7.1). The recipient can open it only if
   *  it was sealed to them, which is the format working, not a failure. */
  function exportThing(envelopeHash: string): { tar: Uint8Array; filename: string } | { error: string } {
    if (isDraftId(envelopeHash)) return { error: 'this is an unpublished draft — publish it first' }
    const row = library.get(envelopeHash)
    if (!row) return { error: 'not found' }
    const tarHash = seedTarHashesFor(envelopeHash)[0]
    const tar = tarHash ? seedStore.readAll(tarHash) : null
    // Seeds are retained for every admitted bundle and pruned only on delete,
    // so this is unreachable in practice — say something true if it happens.
    if (!tar) return { error: 'the original bundle bytes are no longer held' }
    const safeType = (row.type.trim() || 'thing').replace(/[^a-z0-9-]/gi, '-')
    return { tar, filename: `${safeType}-${envelopeHash.slice(0, 8)}.thing` }
  }

  /** Delete a thing everywhere the shell holds it: close it if open, drop the
   *  library row (+ GC of now-unreferenced content blobs), and stop seeding
   *  its bundle. Copies held by others are of course unaffected — a signed
   *  thing is public and permanent once shared. */
  function deleteThing(envelopeHash: string): Record<string, unknown> {
    if (isDraftId(envelopeHash)) return deleteDraft(envelopeHash)
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
    /** Set when the open thing was a local draft: publishing CONSUMES it. */
    draftId: string | null
    /** The full attachment set, resolved (carry-overs included) at CONFIRM
     *  time — approval must publish what the dialog described, even if the
     *  open thing changes before the human decides. */
    attachments: Map<string, { bytes: Uint8Array; mime?: string }>
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
    const tar = await buildBundle(keyring.signer, {
      program: p.program,
      type: p.draft.type,
      args,
      attachments: p.attachments
    })
    return ingestBytes(tar)
  }

  /** The chrome Publish button: raise a confirm for the LATEST DRAFT — the
   *  exact payload the preview is rendering (publish-what-you-preview).
   *  Programs cannot initiate this (emit("publish") is retired); the human
   *  clicks, the human confirms, the shell signs. */
  function publishLatestDraft(): Record<string, unknown> {
    const o = current
    if (!o || !o.latestDraft || !o.latestDraftMeta) {
      return { status: 'invalid', reason: 'nothing to publish — the program has not streamed a draft yet' }
    }
    // Resolve carry-over attachments NOW, against the instance the human is
    // looking at — a failed carry is a failed publish, before any dialog.
    let attachments: Map<string, { bytes: Uint8Array; mime?: string }>
    try {
      attachments = resolveDraftAttachments(o.stored, o.latestDraft)
    } catch (e) {
      return { status: 'invalid', reason: `publish: ${(e as Error).message}` }
    }
    while (pendingConfirms.size >= MAX_PENDING_PUBLISH) {
      const oldest = pendingConfirms.keys().next().value as number
      clearTimeout(pendingConfirms.get(oldest)!.timer)
      pendingConfirms.delete(oldest)
    }
    const id = nextConfirmId++
    // What the human decides on: type + args + attachment table — args is
    // JSON-serializable and ≤256 KB by validateDraft.
    // blobBytes from the draft counts INLINE bytes only; with carry working on
    // drafts, a fully-carried article would otherwise report 0.
    let resolvedBytes = 0
    for (const { bytes } of attachments.values()) resolvedBytes += bytes.length
    const summary: Record<string, unknown> = {
      type: o.latestDraft.type,
      args: o.latestDraft.args,
      att: o.latestDraft.att,
      carry: o.latestDraft.carry,
      argsBytes: o.latestDraftMeta.argsBytes,
      blobBytes: resolvedBytes
    }
    const timer = setTimeout(() => {
      pendingConfirms.delete(id)
      applyVisibility()
    }, PUBLISH_CONFIRM_TTL_MS)
    timer.unref?.()
    pendingConfirms.set(id, { draft: o.latestDraft, draftId: o.draftId, attachments, program: o.stored.program, timer })
    applyVisibility() // cages hide while the human decides in chrome
    const confirmReq = { id, kind: 'publish', summary }
    shell.lastConfirm = confirmReq
    chrome.webContents.send('shell:confirm-request', confirmReq)
    return { status: 'pending', id }
  }
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
    void persistApprovedDraft(p)
      .then((outcome) => {
        // Ingest FIRST, then drop the draft: library.store has already inserted
        // the row referencing the shared program blob, so the draft's GC scan
        // cannot collect it.
        if (p.draftId && outcome.status === 'valid') {
          if (current?.draftId === p.draftId) destroyCurrent({ flush: false })
          library.deleteDraft(p.draftId)
          outcome.draftConsumed = true
          notifyFeedChanged()
        }
        return outcome
      })
      // buildBundle (signing, tar) and ingestBytes both throw. Without this the
      // rejection is silent: the human approved a publish and would get NO
      // outcome at all — no error, no result, a Publish button that just stops
      // responding — and the draft is left intact, which is the right side to
      // fail on. Report the failure instead.
      .catch((e: unknown) => ({ status: 'invalid', reason: `publish: ${(e as Error).message}` }))
      .then((outcome) => {
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

  // ── Account & Keys ─────────────────────────────────────────────────────────
  // The identity is ONE secp256k1 secret; the nostr key derives from it, so
  // importing an eth key fully determines both. Mnemonics are used in-memory
  // to derive the chosen account and then discarded — a (possibly funds-
  // bearing) seed never rests on disk under our at-rest encryption. Private
  // keys never cross IPC except the explicit, human-confirmed export.

  /** Write the new identity (atomic, with a .bak of the old file) and restart
   *  so every keyring-holding closure rebinds cleanly. Tests set
   *  SHELL_NO_RELAUNCH=1 and relaunch themselves. */
  function applyNewIdentity(privkey: Uint8Array): Record<string, unknown> {
    Keyring.writeIdentity(userDataDir, privkey)
    const willRestart = process.env.SHELL_NO_RELAUNCH !== '1'
    if (willRestart) {
      // Deferred so this invoke's reply reaches the chrome before quit.
      setImmediate(() => {
        noteQuit('identity-relaunch')
        app.relaunch()
        app.quit()
      })
    }
    return { ok: true, address: ethAddressHex(privkey), willRestart }
  }

  const ImportInput = z.union([
    z.object({ mnemonic: z.string().max(1024), index: z.number().int().min(0).max(99) }),
    z.object({ privkeyHex: z.string().max(70) })
  ])

  ipcMain.handle('shell:account-accounts', (_e, mnemonic: unknown, count: unknown) => {
    if (typeof mnemonic !== 'string' || mnemonic.length > 1024) return { ok: false, error: 'bad input' }
    const n = Math.min(30, Math.max(1, typeof count === 'number' ? Math.floor(count) : 5))
    try {
      // Addresses only — the derived private keys never cross IPC.
      const accounts = mnemonicToAccounts(mnemonic, n).map((a) => ({ index: a.index, address: a.address }))
      return { ok: true, accounts }
    } catch {
      return { ok: false, error: 'Not a valid BIP-39 phrase (check the words and word count).' }
    }
  })

  ipcMain.handle('shell:account-import', (_e, input: unknown) => {
    const parsed = ImportInput.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'bad input' }
    try {
      if ('privkeyHex' in parsed.data) {
        const r = validatePrivkeyHex(parsed.data.privkeyHex)
        if (!r.ok) return { ok: false, error: r.error }
        return applyNewIdentity(r.privkey)
      }
      const accounts = mnemonicToAccounts(parsed.data.mnemonic, parsed.data.index + 1)
      return applyNewIdentity(accounts[parsed.data.index]!.privkey)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle('shell:account-generate', () => {
    // Nothing is retained here: the chrome shows the phrase for writing down
    // and hands it back through shell:account-import when the human commits.
    const mnemonic = generateMnemonic12()
    return { mnemonic, address: mnemonicToAccounts(mnemonic, 1)[0]!.address }
  })

  ipcMain.handle('shell:account-export', () => ({ privkeyHex: keyring.exportSecretHex() }))
  ipcMain.handle('shell:publish', () => publishLatestDraft())
  ipcMain.handle('shell:known-types', () => knownTypes())
  ipcMain.handle('shell:drafts', () => library.listDrafts())
  ipcMain.handle('shell:new-draft', (_e, key: unknown, args: unknown) => newDraft(key, args))
  ipcMain.handle('shell:new-comment', (_e, h: unknown) => newComment(h))
  ipcMain.handle('shell:replies', (_e, h: unknown) =>
    typeof h === 'string' && HEX64.test(h)
      ? { count: library.countRefsTo(h), rows: library.feed({ replyTo: h, limit: 200 }) }
      : { count: 0, rows: [] }
  )
  ipcMain.handle('shell:delete-draft', (_e, id: unknown) =>
    typeof id === 'string' ? deleteDraft(id) : { deleted: false }
  )
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
  ipcMain.handle('shell:export', async (_e, h: unknown) => {
    if (typeof h !== 'string') return { path: null, error: 'bad hash' }
    const r = exportThing(h)
    if ('error' in r) return { path: null, error: r.error }
    const res = await dialog.showSaveDialog(win, {
      title: 'Save thing to share',
      defaultPath: r.filename,
      filters: [{ name: 'thing bundle', extensions: ['thing'] }]
    })
    if (res.canceled || !res.filePath) return { path: null }
    await writeFile(res.filePath, r.tar)
    return { path: res.filePath }
  })
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
  shell.exportThing = (h) => {
    const r = exportThing(h)
    return 'error' in r ? { error: r.error } : { tarBase64: bytesToBase64(r.tar), filename: r.filename }
  }
  shell.seedHas = (hashHex) => seedStore.has(hashHex)
  shell.feed = (query) => getFeed(query)
  shell.open = (envelopeHash) => openThing(envelopeHash)
  shell.setMode = (m) => setMode(m)
  shell.publishDraft = () => publishLatestDraft()
  shell.knownTypes = () => knownTypes()
  shell.drafts = () => library.listDrafts()
  shell.newDraft = (key, args) => newDraft(key, args)
  shell.newComment = (h) => newComment(h)
  shell.draftBlobs = (id) => library.draftBlobs(id)
  shell.replies = (h) => ({ count: library.countRefsTo(h), rows: library.feed({ replyTo: h, limit: 200 }) })
  shell.deleteDraft = (id) => deleteDraft(id)
  shell.copyThing = (h) => copyThing(h)
  shell.deleteThing = (h) => deleteThing(h)
  // If `current` ever reads null without a destroyCurrent immediately before
  // it in the trace, something impossible happened (those are the only two
  // assignments) -- so record the transition, not every poll.
  let lastModeStateWasNull = false
  shell.modeState = () => {
    const isNull = current === null
    if (isNull && !lastModeStateWasNull) openLog('modeState:became-null', { pid: process.pid })
    lastModeStateWasNull = isNull
    return current
      ? {
          activeMode: current.activeMode,
          viewWcId: current.view ? current.view.view.webContents.id : null,
          editWcId: current.edit ? current.edit.view.webContents.id : null,
          previewWcId: current.preview ? current.preview.view.webContents.id : null,
          // Preview state machine, for diagnosing "the preview stopped
          // updating": a stuck previewMounting or a pendingDraft that never
          // drains are the two ways a remount can be silently lost.
          previewMounting: current.previewMounting,
          hasPendingDraft: current.pendingDraft !== null,
          draftTimerPending: current.draftTimer !== null,
          lastPreviewKey: current.lastPreviewKey,
          previewDestroyed: current.preview ? current.preview.view.webContents.isDestroyed() : null
        }
      : null
  }
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

  // ── Desktop file opens ─────────────────────────────────────────────────────
  // A .thing handed to us by the OS goes through the SAME admission gate as
  // anything else — a file on disk is not more trusted for having been
  // double-clicked — and then opens, so the user sees what they just opened.
  focusMainWindow = () => {
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  let draining = false
  async function openFilesNow(): Promise<void> {
    if (draining) return
    draining = true
    try {
      for (let path = pendingOpenFiles.shift(); path !== undefined; path = pendingOpenFiles.shift()) {
        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(readFileSync(path))
        } catch (e) {
          chrome.webContents.send('shell:file-opened', { path, status: 'invalid', reason: (e as Error).message })
          continue
        }
        const outcome = await ingestBytes(bytes)
        shell.lastFileOpen = { path, ...outcome }
        chrome.webContents.send('shell:file-opened', { path, ...outcome })
        // Land on it when it admitted; a rejected bundle just reports why.
        if (outcome.status === 'valid' && typeof outcome.envelopeHash === 'string') {
          await openThing(outcome.envelopeHash)
          chrome.webContents.send('shell:opened-thing', { envelopeHash: outcome.envelopeHash })
        }
      }
    } finally {
      draining = false
    }
  }
  drainOpenFiles = () => void openFilesNow()
  drainOpenFiles() // anything the OS handed us before we were ready

  shell.ready = true
  dbg('ready-done')
}).catch((e) => dbg(`whenReady FAILED ${String(e)}\n${(e as Error).stack}`))

app.on('window-all-closed', () => {
  noteQuit('window-all-closed')
  app.quit()
})

function base64ToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, 'base64')
  return new Uint8Array(bin)
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
