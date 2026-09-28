import { app, BaseWindow, Menu, WebContentsView, ipcMain, protocol, session, dialog, webContents, shell as electronShell } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { AdmissionService } from './admission/index.js'
import { Keyring, KeyringLoadError } from './keyring/index.js'
import { ethAddressHex, generateMnemonic12, mnemonicToAccounts, validatePrivkeyHex } from './keyring/hd.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  Library,
  isDraftId,
  refTarget,
  vouchSubject,
  type DraftBlobInput,
  type DraftRow,
  type StoredThing,
  type ThingRow
} from './library/index.js'
import { STARTERS, starterByKey, starterBytes } from './starters/index.js'
import { WELCOME_FLAG, welcomeBundle } from './welcome/index.js'
import { suggestedRelay, welcomeForumBundle } from './welcome/community.js'
import { applyPins, pinsOf, type Pins } from './library/pins.js'
import { mountThing, type MountedThing } from './mount/index.js'
import { TransportService, FileTransport, HttpTransport, SeedTransport } from './transport/index.js'
import { TorrentService, displayNameOf, infoHashOf } from './torrent/index.js'
import { NostrService, buildThingEvent, MAX_INLINE_BUNDLE, TAG, type ParsedThingEvent } from './nostr/index.js'
import { NOSTR_ENC_SCHEME } from './nostr/event.js'
import { NamingService, DirectResolver, EnsResolver, NostrResolver, type EnsClient } from './naming/index.js'
import { createMockEnsClient } from './naming/mock-ens.js'
import { createViemEnsClient } from './naming/ens-viem.js'
import { UpdateService, type Updater, type UpdatePref } from './update/index.js'
import { CasStore, EphemeralStore } from '../main/store.js'
import { installBridge, setDraftObserver, type ThingMode } from '../main/bridge.js'
import { cage as cageGlobals, record } from '../main/events.js'
import type { Draft } from '../main/draft.js'
import {
  admitBundle,
  buildBundle,
  cborToJs,
  cosignBundle,
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
/** Mirrors .sh-topbar's height in shell.css -- it is two rows now, so the
 *  Ingest box can be long enough to read its own hint. This is what decides
 *  where the cage begins, so the two must move together. */
const TOP_BAR = 84
const FEED_WIDTH = 300
/** Mirrors .sh-thing-header in shell.css: 44px of content PLUS its 1px
 *  border-bottom, which is the line that draws the trust boundary itself.
 *
 *  It said 44 for a long time. The header is content-box (there is no global
 *  box-sizing reset), so it renders 45, and the cage began one pixel high --
 *  covering that border with content the thing controls. Measured, not
 *  guessed: the chrome occupies 0..129 and the cage started at 128. */
const THING_HEADER = 45

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

// One name on every OS. Without this Electron resolves it per platform —
// package.json `name` on Windows/Linux, the bundle name on macOS — so userData
// would land in differently-named directories depending on where it runs.
app.setName('Souspli')

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
let quitRecorded = false
const recordQuit = (why: string): void => {
  if (quitRecorded || !process.env.SHELL_EXIT_LOG) return
  quitRecorded = true
  try {
    appendFileSync(process.env.SHELL_EXIT_LOG, JSON.stringify({ quitReason: why, pid: process.pid, at: Date.now() }) + '\n')
  } catch {
    /* diagnostics must never break a shutdown */
  }
}
/** Name the exit path, and record it NOW.
 *
 *  Writing this from an `app.on('quit')` handler was not enough: `app.exit()`
 *  terminates the process without emitting before-quit, will-quit OR quit, so
 *  the two exit() paths below -- including the single-instance lock loss --
 *  produced no record at all. Which is precisely the case a mysterious
 *  "the app went away" most needs explained. */
const noteQuit = (why: string): void => {
  quitReason = why
  recordQuit(why)
}
if (process.env.SHELL_EXIT_LOG) {
  // Anything that reaches a real quit WITHOUT naming itself is still worth a
  // line -- it says the exit was orderly and unattributed.
  app.on('quit', () => recordQuit(quitReason))
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
      // The encryption key the author BOUND to this thing, if any (§5.2). It is
      // covered by the signature, so it is the author saying which other key
      // speaks for them -- which is what makes "did this person really post
      // this to the relay?" a question with an answer.
      encScheme: r.envelope.author.e ?? null,
      encKey: r.envelope.author.ek ? hex(r.envelope.author.ek) : null,
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
  exportBase64?: (envelopeHash: string) => { base64: string; bytes: number } | { error: string }
  seedStart?: (envelopeHash: string) => Promise<Record<string, unknown>>
  seedStop?: (envelopeHash: string) => Record<string, unknown>
  seedStatus?: () => Record<string, unknown>[]
  /** Cast a vote on a thing (+1 / -1), replacing your previous one. */
  vote?: (envelopeHash: string, dir: 1 | -1) => Promise<Record<string, unknown>>
  /** What the votes on a thing are worth: raw counts, and the tribe split. */
  votes?: (envelopeHash: string) => Record<string, unknown>
  /** The whole conversation under a thing, with depth and parent. */
  thread?: (envelopeHash: string) => Record<string, unknown>
  /** Forums: every group whose current version you hold, and one forum's
   *  facts, ranked listing, posting, joining, and moderation. */
  forums?: () => Record<string, unknown>[]
  forum?: (rootHash: string) => Record<string, unknown>
  forumListing?: (rootHash: string) => Record<string, unknown>
  newForumPost?: (rootHash: string, starterKey?: string) => Record<string, unknown>
  requestJoin?: (rootHash: string) => Record<string, unknown>
  newVerdict?: (targetHash: string, rootHash: string, verdict: string) => Record<string, unknown>
  /** Things a relay says exist that this library does not hold. */
  offers?: (inGroup?: string) => Record<string, unknown>[]
  /** Follow one. The press — nothing else in the shell calls this. */
  fetchOffer?: (envelopeHash: string) => Promise<Record<string, unknown>>
  /** Relay connections and how far the subscription has read. */
  relays?: () => Record<string, unknown>
  addRelay?: (url: string) => Record<string, unknown>
  removeRelay?: (url: string) => Record<string, unknown>
  /** Post a thing to every connected relay — the explicit act, never implicit. */
  postToRelays?: (envelopeHash: string) => Promise<Record<string, unknown>>
  /** Who OFFERED us a thing on a relay, which is not who authored it. */
  relayArrivals?: (
    envelopeHash: string
  ) => { relayUrl: string; poster: string; selfPosted: boolean; at: number }[]
  /** Types the user can create something of (starters + library programs). */
  knownTypes?: () => { key: string; testKey: string; source: string; type: string; progHash: string }[]
  /** Local unsigned drafts, newest edit first. */
  drafts?: () => DraftRow[]
  newDraft?: (key: string, args?: unknown) => Record<string, unknown>
  /** Start a comment draft seeded with the target's hash. */
  newComment?: (targetHash: string) => Record<string, unknown>
  newAttestation?: (targetHash: string) => Record<string, unknown>
  people?: () => unknown[]
  setPetname?: (scheme: string, key: string, name: string, note?: string) => void
  attestations?: (targetHash: string) => { count: number; rows: unknown[] }
  amend?: (envelopeHash: string) => Record<string, unknown>
  history?: (authorKey: string, path: string) => ThingRow[]
  groupsListing?: (scheme: string, key: string) => Record<string, unknown>[]
  transfers?: () => Record<string, unknown>
  cancelTransfer?: (id: string) => Record<string, unknown>
  cosign?: (envelopeHash: string) => Promise<Record<string, unknown>>
  document?: (manifestHash: string) => Record<string, unknown>
  newVouch?: (scheme: string, key: string) => Record<string, unknown>
  vouchesFor?: (scheme: string, key: string) => Record<string, unknown>
  tribe?: () => { id: string; hops: number; via: string[] }[]
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
/** Set once the seeder exists, so before-quit can shut it down (the service
 *  lives inside whenReady's closure, this handler does not). */
let stopAllSeeding: (() => Promise<void>) | null = null
/** Set once the relay service exists, so before-quit can close the sockets. */
let stopRelays: (() => void) | null = null
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
      `Souspli will NOT overwrite it — it may still be recoverable. ` +
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
    noteQuit('identity-unreadable')
    app.exit(1)
    return
  }
  dbg('library')
  const library = new Library(join(userDataDir, 'library'), {
    // How many unfetched offers to keep. A relay can advertise pointers
    // forever and this is the one table that becomes disk.
    maxOffers: numEnv('SHELL_MAX_OFFERS', 500)
  })
  dbg('admission')
  const admission = new AdmissionService({ limits: limitsFromEnv() })
  // Seed store: retains every admitted bundle's raw tar bytes (content-addressed
  // by tar-hash) so the shell can re-serve it. `bundle:<hash>` fetches from here.
  const seedStore = new CasStore(join(userDataDir, 'seeds'))
  // Serving bundles to peers. Nothing is announced until a human asks for it.
  const seeder = new TorrentService()
  seeder.setDownloadRoot(join(userDataDir, 'downloads'))
  stopAllSeeding = () => seeder.destroy()
  const fetchLimits = {
    maxBytes: numEnv('SHELL_MAX_FETCH_BYTES', 256 * 1024 * 1024),
    timeoutMs: numEnv('SHELL_FETCH_TIMEOUT_MS', 30_000)
  }
  const transport = new TransportService(fetchLimits)
    .register(new FileTransport())
    .register(new HttpTransport())
    .register(new SeedTransport(seedStore))

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
  // 1280: the narrowest common laptop is 1366 wide, and at 1200 the per-letter
  // header -- 900px once the feed has its 300 -- overflowed for most letters.
  const win = new BaseWindow({ width: 1280, height: 820, backgroundColor: '#08080a', title: 'Souspli' })
  const chrome = new WebContentsView({
    webPreferences: { preload: CHROME_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.contentView.addChildView(chrome)

  // ── Updates ────────────────────────────────────────────────────────────────
  // Nothing is checked until the human agrees (see src/shell/update). The
  // answer is kept in the library, beside the data it governs.
  const readUpdatePref = (): UpdatePref => {
    const v = library.getSetting('update-check')
    return v === 'on' || v === 'off' ? v : 'ask'
  }
  const updates = new UpdateService({
    createUpdater: async () => {
      const feed = process.env.SHELL_UPDATE_FEED
      if (feed && !app.isPackaged) {
        // Test hook, unpackaged runs only. Electron reports its own version
        // (or "0.0" under Playwright) when not packaged, and electron-updater
        // compares against it. setVersion is what Electron's default app uses
        // to apply a package.json version; it is undocumented, and this is
        // the only place it is used.
        ;(app as unknown as { setVersion(v: string): void }).setVersion(appVersion())
      }
      // Imported on first use, so the updater is not even loaded before
      // someone asks for a check. It is CommonJS with `autoUpdater` behind a
      // getter (which constructs it), which Node's named-export detection
      // misses, so it is read off the module object.
      const mod = await import('electron-updater')
      const { autoUpdater } = (mod as unknown as { default?: typeof mod }).default ?? mod
      if (feed) {
        // A local feed in place of GitHub Releases, and permission for an
        // unpackaged build to check at all.
        autoUpdater.forceDevUpdateConfig = true
        autoUpdater.setFeedURL({ provider: 'generic', url: feed })
      }
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      // Set explicitly: electron-updater turns prereleases on by itself when
      // the running version has a prerelease tag.
      autoUpdater.allowPrerelease = false
      autoUpdater.allowDowngrade = false
      return autoUpdater as unknown as Updater
    },
    getPref: readUpdatePref,
    setPref: (p) => library.setSetting('update-check', p),
    // A .deb could only be installed unauthenticated via pkexec/sudo; those
    // users get the release page instead. An AppImage replaces itself.
    canInstall: process.platform !== 'linux' || Boolean(process.env.APPIMAGE),
    onState: () => {
      if (!chrome.webContents.isDestroyed()) chrome.webContents.send('shell:update-state', updateStatus())
    },
    firstCheckMs: numEnv('SHELL_UPDATE_FIRST_CHECK_MS', 30_000)
  })
  /** What the chrome needs: the pref, the state, and whether to ask. The first-
   *  run question is suppressed under test (SHELL_NO_UPDATE_PROMPT), like the
   *  welcome letter, so specs don't start behind a modal. */
  const updateStatus = (): Record<string, unknown> => {
    const s = updates.status()
    return { ...s, current: appVersion(), prompt: s.pref === 'ask' && process.env.SHELL_NO_UPDATE_PROMPT !== '1' }
  }
  updates.start()

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
          { label: 'Transfers…', click: () => chrome.webContents.send('shell:open-sharing') },
          { label: 'Forums…', click: () => chrome.webContents.send('shell:open-forums') },
          { label: 'Relays…', click: () => chrome.webContents.send('shell:open-relays') },
          { label: 'People…', click: () => chrome.webContents.send('shell:open-people') },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' as const } : { role: 'quit' as const }
        ]
      },
      { role: 'editMenu' },
      {
        role: 'help',
        submenu: [
          { label: 'Check for updates…', click: () => chrome.webContents.send('shell:open-updates') },
          { type: 'separator' },
          {
            label: 'About',
            click: () => {
              void dialog.showMessageBox(win, {
                type: 'info',
                title: 'About',
                message: 'Souspli',
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
    /** The in-flight preview mount, so teardown can WAIT for it rather than
     *  race it -- destroying cages while a preview is being attached to the
     *  window is the trigger this crash needs. See the barrier in openThing. */
    previewMount: Promise<void> | null
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
    /** Pointers the shell owns (library/pins.ts), laid over every draft the
     *  program emits. For a draft: what the shell seeded it with. For a signed
     *  thing opened for editing: the pointers it already carries, so that
     *  republishing a forum post keeps it in its forum. */
    pins: Pins
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
    // Never touch a cage whose webContents has gone. This runs from events
    // (overlay counts, confirm resolution, render-process-gone) that can land
    // after a teardown has started, and setVisible on a freed native view is
    // not a catchable error -- it is a crash.
    const show = (m: MountedThing | null | undefined, visible: boolean): void => {
      if (!m || m.view.webContents.isDestroyed()) return
      m.view.setVisible(visible)
    }
    show(current.view, !occluded && current.activeMode === 'view' && !showPreview)
    show(current.preview, !occluded && showPreview)
    show(current.edit, !occluded && current.activeMode === 'edit')
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

  /** Where the cage goes: below the chrome, right of the feed.
   *
   *  CEIL, not round. These are the edges of a TRUST BOUNDARY, and at most
   *  zoom factors the product is fractional -- 129 x 1.2^-1 is 107.45, which
   *  rounds to 107 and puts the cage back over the chrome by half a pixel.
   *  Rounding a boundary must always break toward giving the cage LESS area,
   *  never more: a sub-pixel gap shows chrome's own background, while a
   *  sub-pixel overlap shows content the thing controls on top of the line
   *  that says where the thing begins. */
  function cageRect(): Electron.Rectangle {
    const { width, height } = win.getContentBounds()
    const z = zoomFactor()
    const x = Math.ceil(FEED_WIDTH * z)
    const y = Math.ceil((TOP_BAR + THING_HEADER) * z)
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
  /** Admit bytes and put them in the library.
   *
   *  `expect` is the hash the bytes were supposed to be. It exists for the
   *  fetch-a-pointer path: a relay advertised hash X, and what came back must
   *  BE X. A validly signed other thing is still a refusal -- the human asked
   *  for one thing, and quietly keeping a different one because it happened to
   *  verify is not what they asked for. So the check runs before the store,
   *  and on a mismatch nothing is kept at all. */
  async function ingestBytes(raw: Uint8Array, expect?: string): Promise<Record<string, unknown>> {
    const result = await admission.admit(raw, keyring.unsealer)
    if (result.status === 'valid' && expect !== undefined && hex(result.envelopeHash) !== expect) {
      return {
        status: 'invalid',
        reason: `this is a different letter: asked for ${expect.slice(0, 12)}…, got ${hex(result.envelopeHash).slice(0, 12)}…`,
        expected: expect,
        got: hex(result.envelopeHash)
      }
    }
    if (result.status === 'valid') {
      // Whether the envelope was NEW matters to the caller: a bundle you
      // already hold is admitted and valid, but nothing was added, and a
      // caller that reports "done" regardless would be asserting something
      // untrue. Envelope hashes are content-derived, so re-ingesting the same
      // bytes -- or authoring something byte-identical to what you already
      // have -- lands here legitimately.
      const stored = library.store(result, Date.now())
      // Seed the raw admitted bundle so it can be re-served by bundle:<hash>.
      seedStore.put(raw)
      // Whatever route it took, holding it settles any offer of it. A pointer
      // fetched, a file dropped in, a bundle pasted -- all the same once the
      // thing is here.
      library.dropOffer(hex(result.envelopeHash))
      notifyFeedChanged()
      return { ...summarize(result), duplicate: !stored.inserted }
    }
    return summarize(result)
  }

  /** Fetch by a locator OR a name, then run it through admission. A locator is
   *  fetched directly; a name is resolved to a locator (discovery) first, and
   *  the admitted author is forward-verified against the name. The transport and
   *  resolver are content-untrusted; admission is the gate. */
  async function fetchNameOrLocator(input: string): Promise<Record<string, unknown>> {
    // A magnet is not a fetch. It is a TRANSFER: it can take hours, it wants
    // progress and a cancel, and it must survive both this call returning and
    // the app restarting. So it never reaches the transport dispatch below,
    // which can only express Promise<bytes>.
    if (/^magnet:/i.test(input.trim())) return startTransfer(input.trim())
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
      attachments: attachmentsMap(attachments),
      // Bind this author's nostr key, covered by the signature. It is what
      // lets a message on another network be checked against the thing it
      // carries -- without it a relay event and a thing are two unrelated
      // signatures that happen to arrive together.
      enc: { e: NOSTR_ENC_SCHEME, ek: keyring.identity.nostrPubkey }
    })
    const outcome = await ingestBytes(tar)
    return { tar, outcome }
  }

  function getFeed(query: unknown): ThingRow[] {
    const q = (query ?? {}) as {
      type?: string
      author?: string
      replyTo?: string
      attests?: string
      votesOn?: string
      inGroup?: string
      rollUp?: boolean
      limit?: number
    }
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

  /** The pointers a signed thing already carries, as pins for an edit of it. */
  function pinsOfStored(args: unknown): Pins {
    try {
      return pinsOf(cborToJs(args as never))
    } catch {
      return {}
    }
  }

  let pendingOpen: string | null = null
  function announceOpened(envelopeHash: string): void {
    pendingOpen = envelopeHash
    chrome.webContents.send('shell:opened-thing', { envelopeHash })
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
      const attestedNow = refTarget(current.stored.manifest.args, 'attests')
      current.header = {
        ...current.header,
        replyTo: claimedNow,
        replyToKnown: claimedNow ? library.get(claimedNow) !== null : false,
        replyCount: draft ? 0 : library.countRefsTo(envelopeHash),
        attests: attestedNow,
        attestsKnown: attestedNow ? library.get(attestedNow) !== null : false,
        attestCount: draft ? 0 : library.countRefsTo(envelopeHash, 'attests'),
        ...trustFacts(current.stored, draft !== null),
        ...(draft ? {} : documentFacts(current.stored.row.manifestHash)),
        ...(draft ? {} : versionFacts(current.stored.row)),
        mine: draft ? true : hex(keyring.identity.address).toLowerCase() === current.stored.row.authorKey
      }
      return { ...current.header, mode: current.activeMode }
    }
    const stored = draft ? draftStoredFrom(draft) : library.load(envelopeHash)
    if (!stored) {
      openLog('refused', { hash: envelopeHash.slice(0, 12), why: draft ? 'draft program missing' : 'not loadable' })
      return { error: draft ? 'draft program missing from the store' : 'not found or not mountable (sealed)' }
    }
    // BARRIER: never tear cages down while a preview is mid-mount.
    //
    // A preview mount attaches a native view to the window and then loads it.
    // Destroying the other cages in that window while that is in flight
    // crashes the process outright -- SIGSEGV on Linux, 0xC0000005 on Windows
    // -- which is what the poster.spec.ts:201 flake actually was. Reordering
    // the teardown does not help; the two operations simply must not overlap.
    // Waiting costs one debounce at worst, and only when the human switches
    // things mid-preview.
    if (current?.previewMount) {
      openLog('open:awaiting-preview', { hash: envelopeHash.slice(0, 12) })
      await current.previewMount.catch(() => {})
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
      previewMount: null,
      pendingDraft: null,
      draftTimer: null,
      editWcId: null,
      latestDraft: null,
      latestDraftMeta: null,
      lastPreviewKey: null,
      draftId: draft ? draft.id : null,
      pins: draft ? library.draftPins(draft.id) : pinsOfStored(stored.manifest.args),
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
    const attested = refTarget(stored.manifest.args, 'attests')
    const inGroup = draft ? null : refTarget(stored.manifest.args, 'inGroup')
    // ONE tribe walk per open, shared by everything below that needs it. It is
    // a graph walk over several queries, and the open path is latency the
    // human feels -- two of them because two callers each asked for their own
    // is the kind of cost that never shows up in a test and always shows up on
    // a slow machine.
    const tribe = myTribe()
    o.header = {
      ...m.header,
      name: nv?.status === 'verified' ? nv.name : null,
      nameStatus: nv?.status ?? null,
      // Your own label for this author, kept SEPARATE from the verified name:
      // one is proof, the other is what you decided to call them.
      petname: library.petname(m.header.authorScheme as string, m.header.authorKey as string)?.name ?? null,
      draft: draft !== null,
      replyTo: claimed,
      replyToKnown: claimed ? library.get(claimed) !== null : false,
      replyCount: draft ? 0 : library.countRefsTo(envelopeHash),
      // What this thing attests to, and how many things attest to IT. Both are
      // claims, exactly like replyTo, and are labelled as such in the chrome.
      attests: attested,
      attestsKnown: attested ? library.get(attested) !== null : false,
      attestCount: draft ? 0 : library.countRefsTo(envelopeHash, 'attests'),
      ...trustFacts(stored, draft !== null, tribe),
      // Which forum this claims to be in, and what the votes on it are worth.
      // Both are claims about a thing, so both live here beside replyTo and
      // attests rather than anywhere that reads as verified.
      inGroup,
      inGroupKnown: inGroup !== null && library.groupCurrent(inGroup) !== null,
      votes: draft ? null : voteFacts(envelopeHash, tribe),
      // A draft is signed by nobody, so it is not a document with signatures.
      ...(draft ? {} : documentFacts(stored.row.manifestHash)),
      ...(draft ? {} : versionFacts(stored.row)),
      // Whether amending would continue YOUR line or start one rooted on
      // somebody else's thing. The chrome must not call the second "version 2".
      mine: draft ? true : hex(keyring.identity.address).toLowerCase() === stored.row.authorKey
    }
    if (draft) await setMode('edit') // unfinished work opens ready to edit
    notifyModeChanged(o.activeMode)
    return { ...o.header, mode: o.activeMode }
  }

  /** Switch the open thing's mode. The edit cage mounts lazily on first use
   *  and then stays alive (hidden) so its state survives further toggles. */
  /** DIAGNOSTIC: numbers each edit mount, so two for one open are visible. */
  let editMountSeq = 0
  async function setMode(mode: ThingMode): Promise<ThingMode> {
    const o = current
    if (!o || !o.view) return 'view'
    if (mode === 'edit') {
      // DIAGNOSTIC: who asked, and what state the edit cage was in. A CI run
      // (PR #80, run 36232357567) showed TWO edit cages for one draft after a
      // same-id reopen: main accepted drafts from one and modeState reported
      // the other. The editMounting guard below should make that impossible,
      // so these lines are here to show which caller got past it.
      openLog('edit:setMode', {
        hash: o.envelopeHash.slice(0, 12),
        hasEdit: o.edit !== null,
        mounting: o.editMounting !== null,
        editWcId: o.editWcId,
        from: new Error().stack?.split('\n')[2]?.trim().slice(0, 90)
      })
    }
    if (mode === 'edit' && !o.edit) {
      if (!o.editMounting) {
        const mountSeq = ++editMountSeq
        openLog('edit:mount-start', { hash: o.envelopeHash.slice(0, 12), mountSeq })
        o.editMounting = mountThing({
          win,
          preloadPath: CAGE_PRELOAD,
          stored: o.stored,
          bounds: cageRect(),
          mode: 'edit',
          zoomFactor: zoomFactor(),
          onBound: (wcId) => {
            openLog('edit:bound', {
              hash: o.envelopeHash.slice(0, 12),
              mountSeq,
              wcId,
              prevEditWcId: o.editWcId,
              stillCurrent: current === o
            })
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
      openLog('edit:resolved', {
        hash: o.envelopeHash.slice(0, 12),
        wcId: m.view.webContents.id,
        adopting: current === o && !o.edit,
        editWcId: o.editWcId,
        stillCurrent: current === o
      })
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
      // The invariant the CI failure broke: drafts are accepted from
      // editWcId, and everything else (modeState, focus, tests) uses o.edit.
      if (o.edit && o.edit.view.webContents.id !== o.editWcId) {
        openLog('edit:MISMATCH', {
          hash: o.envelopeHash.slice(0, 12),
          editWcId: o.editWcId,
          adoptedWcId: o.edit.view.webContents.id
        })
      }
    }
    o.activeMode = mode
    // Entering view: build the preview the human is about to look at, if the
    // latest draft is not already what it shows. While editing, drafts are
    // recorded but NOT mounted (see the observer), so this is where the wait
    // is paid -- once, when it buys something.
    if (mode === 'view' && o.latestDraft && o.lastPreviewKey !== draftKey(o.latestDraft)) {
      o.pendingDraft = o.latestDraft
      void mountPreview(o)
    }
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
  /** An author key: an eth address today, wider once other schemes land. */
  const HEXKEY = /^[0-9a-f]{40,64}$/

  /** Start a comment on an existing thing. The program cannot learn a hash on
   *  its own (getArgs withholds the envelope, deliberately), so the SHELL puts
   *  the target in the draft's args — an ordinary arg the human chose, not a
   *  new bridge capability. */
  function newComment(targetHash: unknown): Record<string, unknown> {
    if (typeof targetHash !== 'string' || !HEX64.test(targetHash)) return { error: 'bad hash' }
    if (!library.get(targetHash)) return { error: 'that letter is not in your library' }
    // A reply inside a forum stays in that forum. Carried from the thing being
    // answered rather than asked for: a reader pressing Comment on a post is
    // not separately deciding to post to the forum, and a reply that silently
    // left it would vanish from the only place anyone is reading.
    const group = inGroupOf(targetHash)
    return newDraft('starter:comment', { replyTo: targetHash, ...(group ? { inGroup: group } : {}) })
  }

  /** Start an attestation about `targetHash`. Same shape as newComment: a
   *  program can never learn a hash by itself, so the SHELL seeds it. */
  function newAttestation(targetHash: unknown): Record<string, unknown> {
    if (typeof targetHash !== 'string' || !HEX64.test(targetHash)) return { error: 'bad hash' }
    if (!library.get(targetHash)) return { error: 'that letter is not in your library' }
    return newDraft('starter:attestation', { attests: targetHash })
  }

  /** Start a vouch for an author KEY. Unlike newComment/newAttestation the
   *  seed is a key rather than a hash -- but for the same reason: a program
   *  cannot learn who authored anything, so the shell puts the subject in.
   *
   *  Vouching for yourself is refused. It would be the one vouch that is
   *  always available and never worth anything, and it would put your own key
   *  in the graph twice. */
  function newVouch(scheme: unknown, key: unknown): Record<string, unknown> {
    const k = typeof key === 'string' ? key.toLowerCase() : ''
    if (!HEXKEY.test(k)) return { error: 'bad key' }
    const s = typeof scheme === 'string' && scheme ? scheme : keyring.signer.scheme
    if (s === keyring.signer.scheme && k === hex(keyring.identity.address).toLowerCase()) {
      return { error: 'that is your own key' }
    }
    return newDraft('starter:vouch', { about: k, aboutScheme: s })
  }

  /** Keys reachable from YOUR key by vouches. Recomputed per call: the graph
   *  is small, and a stale tribe is worse than a cheap walk. */
  function myTribe(): Map<string, { hops: number; via: string[] }> {
    return library.tribe(keyring.signer.scheme, myKeyHex())
  }

  /** Your own author key, as the library stores it. */
  const myKeyHex = (): string => hex(keyring.identity.address).toLowerCase()

  /** Who vouches for a key, with your name for each voucher and how far from
   *  you they sit. `hops` is null for a voucher outside your tribe -- which is
   *  most of them, and is the honest answer rather than a hidden zero. */
  function vouchesFor(scheme: unknown, key: unknown): Record<string, unknown> {
    const k = typeof key === 'string' ? key.toLowerCase() : ''
    if (!HEXKEY.test(k)) return { rows: [], count: 0, fromTribe: 0, hops: null }
    const s = typeof scheme === 'string' && scheme ? scheme : keyring.signer.scheme
    const tribe = myTribe()
    const rows = library.vouchesAbout(s, k).map((v) => {
      const seat = tribe.get(`${v.voucherScheme}:${v.voucherKey}`)
      return {
        ...v,
        petname: library.petname(v.voucherScheme, v.voucherKey)?.name ?? null,
        hops: seat ? seat.hops : null
      }
    })
    return {
      rows,
      count: rows.length,
      fromTribe: rows.filter((r) => r.hops !== null).length,
      // Where the SUBJECT sits, which is the question actually being asked.
      hops: tribe.get(`${s}:${k}`)?.hops ?? null
    }
  }

  /** Groups whose current version lists this key, with the group's own name.
   *
   *  Descriptive only. This never reaches tribe(): a roster is free to write,
   *  so if membership counted as trust anyone could add themselves to your
   *  graph by publishing a group that names them -- the precise hole vouches
   *  were designed to avoid. */
  function groupsListing(scheme: string, key: string): Record<string, unknown>[] {
    return library.groupsListing(scheme, key).map((g) => {
      const stored = library.load(g.envelopeHash)
      const args = stored ? (cborToJs(stored.manifest.args) as { name?: unknown }) : {}
      return {
        envelopeHash: g.envelopeHash,
        authorKey: g.authorKey,
        name: typeof args.name === 'string' ? args.name : '',
        petname: library.petname('eth-eip191', g.authorKey)?.name ?? null
      }
    })
  }

  /** Where a thing sits in its author's version chain, and whether the link
   *  backwards holds up.
   *
   *  `prev` has never been verified by anything -- it is an author claim like
   *  `created`. Where the predecessor is in the library it is checked; where it
   *  is not, that is said rather than assumed, exactly as replyTo and attests
   *  are treated. */
  function versionFacts(row: ThingRow): Record<string, unknown> {
    if (!row.path) {
      // Not in a chain. It may still be the ROOT of one somebody started.
      const versions = library.chainHistory(row.authorKey, row.envelopeHash)
      return {
        chainPath: null,
        version: versions.length > 0 ? 0 : null,
        versionCount: versions.length > 0 ? versions.length : null,
        supersededBy: versions.length > 0 ? versions[versions.length - 1]!.envelopeHash : null,
        prevKnown: false,
        prevMatches: null
      }
    }
    const history = library.chainHistory(row.authorKey, row.path)
    const idx = history.findIndex((h) => h.envelopeHash === row.envelopeHash)
    const latest = history[history.length - 1] ?? null
    // The predecessor as the CHAIN orders it, against the one this envelope
    // CLAIMS. They agree on an honest chain; when they do not, the version is
    // pointing at something other than the version before it, and saying so is
    // the only reason to record prev at all.
    const expected = idx > 0 ? history[idx - 1]!.envelopeHash : row.path
    const claimed = library.claimedPrev(row.envelopeHash)
    return {
      chainPath: row.path,
      version: row.seq,
      versionCount: history.length,
      supersededBy: latest && latest.envelopeHash !== row.envelopeHash ? latest.envelopeHash : null,
      prevClaimed: claimed,
      // Known = we hold what it points at, so the claim is checkable at all.
      prevKnown: claimed !== null && library.get(claimed) !== null,
      prevMatches: claimed === null ? null : claimed === expected
    }
  }

  /** Who attests to a thing, and how much of that reaches YOU.
   *
   *  "5 attestations, 3 from your tribe": the count alone says nothing, since
   *  anyone may attest to anything and keys are free to mint. The second half
   *  is the part that carries. */
  function attestationsFor(h: unknown): Record<string, unknown> {
    if (typeof h !== 'string' || !HEX64.test(h)) return { count: 0, rows: [], fromTribe: 0 }
    const tribe = myTribe()
    const rows = library.feed({ attests: h, limit: 200 }).map((r) => ({
      ...r,
      hops: tribe.get(`${r.authorScheme}:${r.authorKey}`)?.hops ?? null
    }))
    return { count: library.countRefsTo(h, 'attests'), rows, fromTribe: rows.filter((r) => r.hops !== null).length }
  }

  // ── The forum ──────────────────────────────────────────────────────────────
  // A forum is a GROUP: a roster with roles, kept by whoever founded it and
  // amended through its version chain. It needed no new thing type, which is
  // the point -- a forum that required new primitives would have meant the
  // primitives were wrong.
  //
  //   a place            a group, named by its chain's ROOT hash
  //   a post in it       any thing carrying `inGroup: <root>`
  //   a reply            `replyTo`, walked as deep as it goes
  //   a moderator        a roster entry whose role says so
  //   a verdict          an attestation by one of those keys
  //   a vote             the one genuinely new type
  //
  // Every one of those is a CLAIM. What stops the claims from being worth
  // anything on their own is that ranking runs through your tribe and
  // moderation runs through a roster you chose to hold.

  /** Which forum a thing says it belongs to, or null. */
  function inGroupOf(envelopeHash: string): string | null {
    const stored = library.load(envelopeHash)
    return stored ? refTarget(stored.manifest.args, 'inGroup') : null
  }

  /** Vote counts for a thing, split by whether the voter is someone you
   *  reached through your own vouches.
   *
   *  BOTH numbers, always, because they answer different questions. The raw
   *  count is what everyone sees and is free to manufacture -- a thousand
   *  keys cost nothing. The tribe count is what it is worth TO YOU, and
   *  cannot be manufactured without first getting inside your vouches. */
  function voteFacts(targetHash: string, tribe = myTribe()): Record<string, unknown> {
    const rows = library.votesOn(targetHash)
    let up = 0
    let down = 0
    let tribeUp = 0
    let tribeDown = 0
    for (const v of rows) {
      const inTribe = tribe.has(`${v.voterScheme}:${v.voterKey}`)
      if (v.dir > 0) {
        up++
        if (inTribe) tribeUp++
      } else {
        down++
        if (inTribe) tribeDown++
      }
    }
    const mine = library.myVote(keyring.signer.scheme, myKeyHex(), targetHash)
    return {
      up,
      down,
      score: up - down,
      tribeUp,
      tribeDown,
      tribeScore: tribeUp - tribeDown,
      // Whether YOUR key has voted, and which way -- so the control can show
      // its state rather than inviting you to vote twice.
      mine: mine ? mine.dir : 0
    }
  }

  /** Cast a vote, replacing whatever you said before.
   *
   *  Signed HERE with no confirm dialog, exactly as Copy is: the confirm
   *  exists because a PROGRAM asked to publish something in your name and you
   *  must see what that is. A vote comes from a control in trusted chrome, on
   *  a thing already on your screen -- the intent was the click. Showing a
   *  dialog that says {votesOn, dir} back to you would be friction, not
   *  consent.
   *
   *  A signed thing cannot be unsaid, so changing your mind publishes a LATER
   *  vote; the library counts only each key's latest. Voting the same way
   *  twice is refused rather than making a second identical thing. */
  async function castVote(targetHash: unknown, direction: unknown): Promise<Record<string, unknown>> {
    if (typeof targetHash !== 'string' || !HEX64.test(targetHash)) return { error: 'bad hash' }
    if (direction !== 1 && direction !== -1) return { error: 'a vote is +1 or -1' }
    if (!library.get(targetHash)) return { error: 'that letter is not in your library' }
    const current = library.myVote(keyring.signer.scheme, myKeyHex(), targetHash)
    if (current && current.dir === direction) return { error: 'you have already voted that way' }
    const starter = starterByKey('starter:vote')
    if (!starter) return { error: 'the vote program is missing' }
    const tar = await buildBundle(keyring.signer, {
      program: starterBytes(starter),
      type: 'vote',
      args: jsToCbor({ votesOn: targetHash, dir: direction }),
      attachments: new Map(),
      enc: { e: NOSTR_ENC_SCHEME, ek: keyring.identity.nostrPubkey }
    })
    const outcome = await ingestBytes(tar)
    if (outcome.status !== 'valid') return { error: String(outcome.reason ?? outcome.status) }
    return { ...voteFacts(targetHash), envelopeHash: outcome.envelopeHash }
  }

  /** The whole conversation under a thing, each entry with its parent, its
   *  depth, and what the votes on it are worth to you. */
  function threadFor(rootHash: unknown): Record<string, unknown> {
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { rows: [] }
    const tribe = myTribe()
    const rows = library.thread(rootHash).map((n) => ({
      ...n.row,
      parent: n.parent,
      depth: n.depth,
      authorHops: tribe.get(`${n.row.authorScheme}:${n.row.authorKey}`)?.hops ?? null,
      votes: voteFacts(n.row.envelopeHash, tribe)
    }))
    return { rows, count: rows.length }
  }

  /** The moderators a forum's CURRENT roster names, lowercased for comparison.
   *
   *  Read from the roster you hold, which is the whole of a moderator's
   *  authority here: hold no group and nobody moderates anything for you, and
   *  a later revision that drops someone ends their reach the moment you have
   *  it. Being named is the keeper's claim, not the moderator's consent. */
  function moderatorsOf(rootHash: string): Map<string, string> {
    const out = new Map<string, string>()
    const current = library.groupCurrent(rootHash)
    if (!current) return out
    for (const m of library.groupMembers(current.envelopeHash)) {
      if (/^mod(erator)?$/i.test(m.role.trim())) out.set(`${m.scheme}:${m.key.toLowerCase()}`, m.name)
    }
    return out
  }

  /** A moderator's verdict on a thing, if one of this forum's moderators has
   *  published an attestation about it.
   *
   *  Nothing is ever deleted or hidden from you: a verdict is one signed
   *  opinion by a named key, and the shell folds the post behind a line that
   *  says WHO and WHY, with the post still one click away. Disagreeing has to
   *  stay possible -- that is the difference between a forum and a memory
   *  hole. */
  function verdictOn(targetHash: string, rootHash: string, mods = moderatorsOf(rootHash)): Record<string, unknown> | null {
    if (mods.size === 0) return null
    for (const row of library.attestationsOn(targetHash)) {
      const id = `${row.authorScheme}:${row.authorKey.toLowerCase()}`
      if (!mods.has(id)) continue
      const stored = library.load(row.envelopeHash)
      if (!stored) continue
      const args = cborToJs(stored.manifest.args) as Record<string, unknown>
      // The verdict must name the same forum, or a moderator of one group
      // would be moderating every group they touch.
      if (refTarget(stored.manifest.args, 'inGroup') !== rootHash) continue
      const verdict = typeof args.verdict === 'string' ? args.verdict.trim().toLowerCase() : ''
      if (verdict !== 'hide' && verdict !== 'endorse') continue
      return {
        verdict,
        by: row.authorKey,
        byName: mods.get(id) || library.petname(row.authorScheme, row.authorKey)?.name || '',
        why: typeof args.statement === 'string' ? args.statement : '',
        envelopeHash: row.envelopeHash
      }
    }
    return null
  }

  /** Everything about a forum: what it calls itself, who keeps it, who
   *  moderates, and who has asked to get in. */
  function forumFacts(rootHash: unknown): Record<string, unknown> {
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { error: 'bad hash' }
    const current = library.groupCurrent(rootHash)
    if (!current) return { error: 'no group by that hash in your library' }
    const stored = library.load(current.envelopeHash)
    const args = stored ? (cborToJs(stored.manifest.args) as { name?: unknown; purpose?: unknown }) : {}
    const members = library.groupMembers(current.envelopeHash)
    const roster = new Set(members.map((m) => `${m.scheme}:${m.key.toLowerCase()}`))
    const me = `${keyring.signer.scheme}:${myKeyHex()}`
    // A request is pending while its author is not on the roster. Once the
    // keeper writes them in, the request stops being pending without anyone
    // having to mark it -- the roster IS the answer.
    const pending = library
      .feed({ type: 'join-request', inGroup: rootHash, limit: 200 })
      .filter((r) => !roster.has(`${r.authorScheme}:${r.authorKey.toLowerCase()}`))
      .map((r) => ({
        envelopeHash: r.envelopeHash,
        authorKey: r.authorKey,
        authorScheme: r.authorScheme,
        petname: library.petname(r.authorScheme, r.authorKey)?.name ?? null
      }))
    const mods = moderatorsOf(rootHash)
    return {
      root: rootHash,
      current: current.envelopeHash,
      keeper: current.authorKey,
      keeperIsMe: current.authorKey === myKeyHex(),
      name: typeof args.name === 'string' ? args.name : '',
      purpose: typeof args.purpose === 'string' ? args.purpose : '',
      members: members.length,
      moderators: [...mods.entries()].map(([id, name]) => ({ key: id.split(':')[1] ?? '', name })),
      iAmModerator: mods.has(me),
      iAmMember: roster.has(me),
      pending
    }
  }

  /** Things that live in a forum without being posts in it.
   *
   *  All three carry `inGroup` because they have to travel with the forum, and
   *  none of them is something anyone came to read: a vote is activity, a join
   *  request is addressed to the keeper, and a verdict is the moderation
   *  machinery itself. Listing them would let a busy thread's own bookkeeping
   *  outrank the thread.
   *
   *  A verdict counts here whoever signed it. A stranger's "hide this" is not
   *  a forum post either -- it is a moderation attempt that no reader honours,
   *  and it belongs in the same bin as the ones that work. */
  function isForumMachinery(row: ThingRow): boolean {
    if (row.type === 'vote' || row.type === 'join-request') return true
    if (row.type !== 'attestation') return false
    const stored = library.load(row.envelopeHash)
    if (!stored) return false
    const args = cborToJs(stored.manifest.args) as Record<string, unknown>
    return typeof args.verdict === 'string' && refTarget(stored.manifest.args, 'inGroup') !== null
  }

  /** A forum's posts, ranked.
   *
   *  Ordered by TRIBE score first, then the raw score, then recency -- and
   *  both numbers travel with every row, because an ordering nobody can
   *  explain is worse than no ordering at all. When your tribe is empty every
   *  tribe score is 0 and this silently degrades to raw popularity, which is
   *  exactly the manufacturable ranking, so `tribeEmpty` says so and the
   *  chrome must repeat it rather than let a new reader assume otherwise. */
  function forumListing(rootHash: unknown): Record<string, unknown> {
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { error: 'bad hash' }
    const tribe = myTribe()
    const mods = moderatorsOf(rootHash)
    const rows = library
      .forumPosts(rootHash)
      .filter((r) => !isForumMachinery(r))
      // A reply belongs under the post it answers, not on the front page.
      // Replies carry `inGroup` so they stay with their forum when they
      // travel -- which is right, and is also why they have to be folded
      // here rather than left to arrive as posts of their own.
      //
      // Scoped to targets actually HELD, exactly as the feed's roll-up is: a
      // reply to something you do not have is the only copy you have of that
      // conversation, and dropping it would hide it completely.
      .filter((r) => {
        const answers = refTarget(library.load(r.envelopeHash)?.manifest.args ?? null)
        return answers === null || library.get(answers) === null
      })
      .map((r) => {
        const votes = voteFacts(r.envelopeHash, tribe) as Record<string, number>
        return {
          ...r,
          authorHops: tribe.get(`${r.authorScheme}:${r.authorKey}`)?.hops ?? null,
          votes,
          replies: library.countRefsTo(r.envelopeHash),
          verdict: verdictOn(r.envelopeHash, rootHash, mods)
        }
      })
    // Offers rank beside posts. A vote points at a HASH, so it counts whether
    // or not you hold the thing -- which means a large post with votes from
    // your tribe rises to the top and asks to be fetched, instead of sitting
    // invisible at the bottom because nobody has pulled it yet.
    //
    // Everything on an offer row except the votes is the poster's claim: the
    // type, the forum, and that it exists at all. There is no author until it
    // is fetched, and the chrome must not invent one.
    for (const o of library.offers({ inGroup: rootHash })) {
      rows.push({
        envelopeHash: o.envelopeHash,
        authorScheme: '',
        authorKey: '',
        type: o.type || 'thing',
        progHash: '',
        manifestHash: '',
        receivedAt: o.seenAt,
        created: 0,
        path: null,
        seq: null,
        sealed: false,
        read: false,
        isFork: false,
        offered: true,
        offerState: o.state,
        offerReason: o.reason,
        locator: o.locator,
        poster: o.poster,
        relayUrl: o.relayUrl,
        authorHops: null,
        votes: voteFacts(o.envelopeHash, tribe) as Record<string, number>,
        replies: library.countRefsTo(o.envelopeHash),
        verdict: verdictOn(o.envelopeHash, rootHash, mods)
      } as unknown as (typeof rows)[number])
    }
    rows.sort((a, b) => {
      const at = (a.votes as Record<string, number>).tribeScore ?? 0
      const bt = (b.votes as Record<string, number>).tribeScore ?? 0
      if (at !== bt) return bt - at
      const ar = (a.votes as Record<string, number>).score ?? 0
      const br = (b.votes as Record<string, number>).score ?? 0
      if (ar !== br) return br - ar
      return b.receivedAt - a.receivedAt
    })
    return { rows, tribeEmpty: tribe.size === 0 }
  }

  /** Groups in this library that could be read as forums: every group whose
   *  current version you hold. */
  function forums(): Record<string, unknown>[] {
    const seen = new Set<string>()
    const out: Record<string, unknown>[] = []
    for (const row of library.feed({ type: 'group', limit: 200 })) {
      // The feed already collapses a chain to its current version, so `path`
      // is the root for a later version and the row IS the root otherwise.
      const root = row.path ?? row.envelopeHash
      if (seen.has(root)) continue
      seen.add(root)
      const facts = forumFacts(root)
      if (!facts.error) out.push({ ...facts, posts: library.forumPosts(root, 1000).length })
    }
    return out
  }

  /** Start a post in a forum: an ordinary thing that says which forum it is
   *  in. Nothing about the forum changes -- being tagged into one is a claim,
   *  and the roster never agreed to it. */
  function newForumPost(rootHash: unknown, starterKey: unknown): Record<string, unknown> {
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { error: 'bad hash' }
    if (!library.groupCurrent(rootHash)) return { error: 'no group by that hash in your library' }
    return newDraft(typeof starterKey === 'string' && starterKey ? starterKey : 'starter:article', {
      inGroup: rootHash
    })
  }

  /** Ask to be put on a group's roster. Asking is not joining: only the
   *  keeper can publish a roster that names you. */
  function requestJoin(rootHash: unknown): Record<string, unknown> {
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { error: 'bad hash' }
    if (!library.groupCurrent(rootHash)) return { error: 'no group by that hash in your library' }
    return newDraft('starter:join-request', { inGroup: rootHash })
  }

  /** Start a moderator's verdict on a post: an attestation naming the forum.
   *  Refused unless the roster you hold names you a moderator of it -- not as
   *  security (nobody can stop you signing anything) but because publishing a
   *  verdict nobody will honour helps no one. */
  function newVerdict(targetHash: unknown, rootHash: unknown, verdict: unknown): Record<string, unknown> {
    if (typeof targetHash !== 'string' || !HEX64.test(targetHash)) return { error: 'bad hash' }
    if (typeof rootHash !== 'string' || !HEX64.test(rootHash)) return { error: 'bad group hash' }
    const v = typeof verdict === 'string' ? verdict.trim().toLowerCase() : ''
    if (v !== 'hide' && v !== 'endorse') return { error: 'a verdict is hide or endorse' }
    if (!moderatorsOf(rootHash).has(`${keyring.signer.scheme}:${myKeyHex()}`)) {
      return { error: 'this forum’s roster does not name you a moderator' }
    }
    return newDraft('starter:attestation', { attests: targetHash, inGroup: rootHash, verdict: v })
  }

  /** The vouch-shaped header facts for one thing: where its author sits in
   *  your tribe, and -- when it IS a vouch -- whose key it speaks about.
   *
   *  Recomputed on every open rather than cached with the mount, for the same
   *  reason the reply counts are: a vouch published since is real news. */
  function trustFacts(stored: StoredThing, draft: boolean, tribe = myTribe()): Record<string, unknown> {
    const subject = draft ? null : vouchSubject(stored.manifest.args)
    return {
      // Never for a draft: nothing is signed, so there is no author yet.
      authorHops: draft ? null : tribe.get(`${stored.row.authorScheme}:${stored.row.authorKey}`)?.hops ?? null,
      vouchAbout: subject?.key ?? null,
      vouchAboutScheme: subject?.scheme ?? null,
      // Whether you hold anything by the key this vouch names. Not knowing
      // them is the common case and is stated rather than hidden.
      vouchAboutKnown: subject ? library.people().some((pp) => pp.authorScheme === subject.scheme && pp.authorKey === subject.key) : false,
      vouchAboutName: subject ? library.petname(subject.scheme, subject.key)?.name ?? null : null
    }
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
    const running = mountPreviewInner(o)
    o.previewMount = running
    try {
      await running
    } finally {
      if (o.previewMount === running) o.previewMount = null
    }
  }

  async function mountPreviewInner(o: OpenThing): Promise<void> {
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
  // Quiet period before pre-warming a preview nobody is looking at yet. Long
  // enough that ordinary typing never triggers it, short enough that a pause
  // leaves View ready before the human gets there.
  const PREVIEW_IDLE_MS = 1200
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
    // The shell's pointers go back over whatever the program sent BEFORE
    // anything reads the draft, so the preview, the autosave and the signature
    // all see the same args. (Mutating req.draft is deliberate: every use
    // below reads it.)
    if (Object.keys(o.pins).length > 0) req.draft = { ...req.draft, args: applyPins(req.draft.args, o.pins) }
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
    // How soon to rebuild depends on whether anyone is LOOKING at the preview.
    //
    // Visible (view mode, the preview is on screen): coalesce at 600ms and
    // fire repeatedly, so what is on screen keeps up.
    //
    // Hidden (edit mode): the preview cannot be seen -- applyVisibility shows
    // it in view mode only -- so rebuilding per keystroke burst was an entire
    // cage (new renderer, program load, swap, destroy) for nobody. Measured at
    // SEVEN mounts in four seconds of ordinary typing: that is the lag, and
    // the focus flicker as views swap under the typist. So while editing this
    // is a TRAILING debounce that resets on every keystroke: nothing rebuilds
    // while keys are flowing, and one rebuild happens once typing settles, so
    // switching to View is still instant.
    const visible = o.activeMode === 'view'
    const fire = (): void => {
      o.draftTimer = null
      openLog('draft:timer-fired', { hasPending: o.pendingDraft !== null, mounting: o.previewMounting })
      if (current === o) void mountPreview(o)
    }
    if (visible) {
      if (o.draftTimer) return // already coalescing; keep the cadence steady
      o.draftTimer = setTimeout(fire, PREVIEW_DEBOUNCE_MS)
    } else {
      if (o.draftTimer) clearTimeout(o.draftTimer)
      o.draftTimer = setTimeout(fire, PREVIEW_IDLE_MS)
    }
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
    if (stored.row.sealed) return { status: 'invalid', reason: 'refusing to copy a sealed letter into a public one' }
    // Copy rebuilds the same program/type/args, and a manifest has no author
    // and no nonce -- so on a document that names signatories, Copy IS a
    // co-signature, and would silently put your key on a contract. Refuse and
    // send the human to the path that shows them what they are signing.
    if (library.namedSigners(stored.row.manifestHash).length > 0) {
      return {
        status: 'invalid',
        reason: 'this document names signatories — copying it would add your signature to it. Use Co-sign, which shows you what you are signing.'
      }
    }
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
      attachments,
      // Bind this author's nostr key, covered by the signature. It is what
      // lets a message on another network be checked against the thing it
      // carries -- without it a relay event and a thing are two unrelated
      // signatures that happen to arrive together.
      enc: { e: NOSTR_ENC_SCHEME, ek: keyring.identity.nostrPubkey }
    })
    return ingestBytes(tar)
  }

  /** Everything about a document's signatures: who has signed, who is merely
   *  NAMED, and whether you are among either.
   *
   *  "2 of 4 signed" is not a validity score and the chrome must never render
   *  it as one -- a half-signed contract is not half-valid, it is unsigned by
   *  two people. And a signature from someone the document never named is
   *  still a real signature: it is reported separately rather than dropped,
   *  because hiding it would be the dishonest half of the count. */
  function documentFacts(manifestHash: string): Record<string, unknown> {
    const named = library.namedSigners(manifestHash)
    const signatures = library.signaturesOf(manifestHash).map((sig) => ({
      ...sig,
      petname: library.petname(sig.authorScheme, sig.authorKey)?.name ?? null,
      // Was this signer one of the parties the document names?
      named: named.some((n) => n.scheme === sig.authorScheme && n.key === sig.authorKey)
    }))
    const signedKeys = new Set(signatures.map((sg) => `${sg.authorScheme}:${sg.authorKey}`))
    const me = `${keyring.signer.scheme}:${hex(keyring.identity.address).toLowerCase()}`
    return {
      // The DOCUMENT's identity: what signatures are grouped by, as distinct
      // from the envelope hash, which identifies one signature.
      manifestHash,
      cosignable: named.length > 0,
      namedSigners: named.map((n) => ({ ...n, signed: signedKeys.has(`${n.scheme}:${n.key}`) })),
      signatures,
      signedCount: signatures.length,
      namedCount: named.length,
      namedSignedCount: named.filter((n) => signedKeys.has(`${n.scheme}:${n.key}`)).length,
      unnamedSignedCount: signatures.filter((sg) => !sg.named).length,
      signedByMe: signedKeys.has(me),
      // Being named is not consent: it only tells you the document expects you.
      iAmNamed: named.some((n) => `${n.scheme}:${n.key}` === me)
    }
  }

  /** Add YOUR signature to a document somebody else already signed.
   *
   *  Never rebuilds the manifest: the stored bytes are re-signed verbatim, so
   *  what you sign is exactly what the earlier signers signed. Goes through
   *  the same human confirm as publishing, because it is the same act -- your
   *  key going onto something. */
  async function cosignThing(envelopeHash: unknown): Promise<Record<string, unknown>> {
    if (typeof envelopeHash !== 'string' || isDraftId(envelopeHash)) {
      return { status: 'invalid', reason: 'a draft has nothing signed to co-sign' }
    }
    const stored = library.load(envelopeHash)
    if (!stored) return { status: 'invalid', reason: 'not found or not mountable (sealed, undecrypted)' }
    if (stored.row.sealed) {
      // The plaintext manifest lives only in the ephemeral store; re-signing it
      // would write decrypted bytes into a public bundle.
      return { status: 'invalid', reason: 'refusing to co-sign a sealed letter into a public one' }
    }
    const manifestHash = stored.row.manifestHash
    const facts = documentFacts(manifestHash)
    if (facts.signedByMe) return { status: 'invalid', reason: 'you have already signed this document' }
    const manifestBytes = stored.store.readAll(manifestHash)
    if (!manifestBytes) return { status: 'invalid', reason: 'the manifest bytes are missing from the store' }
    const blobs = new Map<string, Uint8Array>()
    for (const [name, att] of stored.manifest.att) {
      const bytes = stored.store.readAll(toHex(att.h))
      if (!bytes) return { status: 'invalid', reason: `attachment missing from store: ${name}` }
      blobs.set(toHex(att.h), bytes)
    }
    while (pendingConfirms.size >= MAX_PENDING_PUBLISH) {
      const oldest = pendingConfirms.keys().next().value as number
      clearTimeout(pendingConfirms.get(oldest)!.timer)
      pendingConfirms.delete(oldest)
    }
    const id = nextConfirmId++
    const timer = setTimeout(() => {
      pendingConfirms.delete(id)
      applyVisibility()
    }, PUBLISH_CONFIRM_TTL_MS)
    timer.unref?.()
    pendingConfirms.set(id, { kind: 'cosign', manifestBytes, manifestHash, program: stored.program, blobs, timer })
    applyVisibility()
    const confirmReq = {
      id,
      kind: 'cosign',
      summary: {
        type: stored.manifest.type,
        args: cborToJs(stored.manifest.args),
        manifestHash,
        ...facts
      }
    }
    shell.lastConfirm = confirmReq
    chrome.webContents.send('shell:confirm-request', confirmReq)
    return { status: 'pending', id }
  }

  async function persistApprovedCosign(p: PendingCosign): Promise<Record<string, unknown>> {
    const tar = await cosignBundle(keyring.signer, {
      manifestBytes: p.manifestBytes,
      program: p.program,
      blobs: p.blobs
    })
    return ingestBytes(tar)
  }

  // ── Transfers ──────────────────────────────────────────────────────────────
  // A download runs in the background, reports progress, and is remembered
  // across restarts. What it does NOT do is decide anything: when the bytes
  // arrive they go through the same admission gate as every other transport,
  // which is why a transfer can be left running without being trusted.

  let transfersTimer: ReturnType<typeof setInterval> | null = null

  function pushTransfers(): void {
    if (chrome.webContents.isDestroyed()) return
    chrome.webContents.send('shell:transfers', transferState())
    // Tick only while something is live; an idle shell should be silent.
    const live = seeder.downloadStatus().length > 0
    if (live && !transfersTimer) {
      transfersTimer = setInterval(pushTransfers, 500)
      transfersTimer.unref?.()
    } else if (!live && transfersTimer) {
      clearInterval(transfersTimer)
      transfersTimer = null
    }
  }

  function transferState(): Record<string, unknown> {
    return { downloads: seeder.downloadStatus(), sharing: seedingStatus() }
  }

  /** Begin a download, or join one already running for the same infohash. */
  async function startTransfer(magnet: string): Promise<Record<string, unknown>> {
    const infoHash = infoHashOf(magnet)
    if (!infoHash) return { status: 'invalid', reason: 'that magnet names no infohash' }
    const id = library.rememberTransfer(randomUUID(), magnet, infoHash, displayNameOf(magnet), Date.now())
    const started = await seeder.startDownload(id, magnet, displayNameOf(magnet))
    if (started?.error) {
      pushTransfers()
      return { status: 'invalid', reason: `transport: ${started.error}`, transferId: id }
    }
    // Refuse an oversize torrent the moment its metadata names a size, rather
    // than downloading a gigabyte and rejecting it at the gate. The cap is the
    // bundle cap: a thing larger than admission will take cannot become one
    // however patiently it is fetched.
    const t = seeder.torrentFor(id)
    t?.on('metadata', () => {
      const size = typeof t.length === 'number' ? t.length : 0
      if (size > fetchLimits.maxBytes) {
        seeder.setDownloadState(
          id,
          'failed',
          `this is ${Math.round(size / 1048576)} MB, over the ${Math.round(fetchLimits.maxBytes / 1048576)} MB limit a letter may be`
        )
        library.forgetTransfer(id)
        seeder.cancelDownload(id)
        pushTransfers()
      }
    })
    void watchTransfer(id)
    pushTransfers()
    return { status: 'started', transferId: id, infoHash }
  }

  /** Wait for a download to finish, then put its bytes through admission.
   *  Deliberately not awaited by the caller -- that is what makes it a
   *  background transfer rather than a long fetch. */
  async function watchTransfer(id: string): Promise<void> {
    const torrent = seeder.torrentFor(id)
    if (!torrent) return
    const done = await new Promise<boolean>((resolve) => {
      torrent.on('done', () => resolve(true))
      torrent.on('error', () => resolve(false))
    }).catch(() => false)
    if (!done) return // the state and reason are already on the status row
    try {
      // Size is checked when metadata lands (below); by here it is known good.
      seeder.setDownloadState(id, 'verifying')
      pushTransfers()
      const file = torrent.files[0]
      if (!file) throw new Error('the torrent contained no file')
      const bytes = new Uint8Array(await file.arrayBuffer())
      seeder.setDownloadState(id, 'admitting')
      pushTransfers()
      // Started to discharge an offer? Then it owes THAT thing. The expectation
      // lives in the offers table rather than in this closure, so a transfer
      // resumed on the next launch still has to deliver what it was started
      // for -- a magnet is a locator a stranger chose, and the swarm behind it
      // can serve whatever it likes.
      const owed = library.offerForTransfer(id)
      const outcome = await ingestBytes(bytes, owed?.envelopeHash)
      if (outcome.status !== 'valid') {
        seeder.setDownloadState(id, 'failed', `admission refused it: ${String(outcome.reason ?? outcome.status)}`)
        if (owed) {
          library.setOfferState(owed.envelopeHash, 'failed', String(outcome.reason ?? outcome.status))
          notifyFeedChanged()
        }
        pushTransfers()
        return
      }
      // It arrived and it admitted: the intent is discharged, and the partial
      // file is redundant now the bytes are in the CAS and the seed store.
      library.forgetTransfer(id)
      seeder.finishDownload(id)
      notifyFeedChanged()
      pushTransfers()
    } catch (e) {
      seeder.setDownloadState(id, 'failed', (e as Error).message)
      pushTransfers()
    }
  }

  function cancelTransfer(id: unknown): Record<string, unknown> {
    if (typeof id !== 'string') return { cancelled: false }
    const forgotten = library.forgetTransfer(id)
    const stopped = seeder.cancelDownload(id)
    pushTransfers()
    return { cancelled: forgotten || stopped }
  }

  /** Start a NEW VERSION of a thing.
   *
   *  A chain begins the first time something is amended: the new version takes
   *  `path` = the original's envelope hash, so chain identity is collision-free
   *  and names where the line began. Amending a version already in a chain
   *  continues it at seq + 1.
   *
   *  A chain is (author_key, path). Amending SOMEBODY ELSE'S thing therefore
   *  produces your own chain rooted at theirs -- not a new version of theirs,
   *  which you could not publish even if you wanted to, because you cannot
   *  sign as them. The chrome has to say which of the two it is showing. */
  function amendThing(envelopeHash: unknown): Record<string, unknown> {
    if (typeof envelopeHash !== 'string' || isDraftId(envelopeHash)) {
      return { error: 'a draft has no published version to amend — publish it first' }
    }
    const row = library.get(envelopeHash)
    if (!row) return { error: 'not found' }
    const stored = library.load(envelopeHash)
    if (!stored) return { error: 'not loadable (sealed, undecrypted)' }
    if (row.sealed) return { error: 'refusing to amend a sealed letter into a public one' }

    // Continue the chain this thing is in, or root a new one on it.
    const path = row.path ?? envelopeHash
    const seq = (row.seq ?? 0) + 1
    // Start from the thing's OWN program and args -- not from a type key. A key
    // would have to be reverse-engineered (library keys are type + NUL + program
    // hash) and could resolve to a different program that merely shares a type
    // name, which would silently amend a thing into something else.
    let seed: unknown
    try {
      seed = cborToJs(stored.manifest.args)
    } catch {
      return { error: 'that letter has args Souspli cannot re-edit' }
    }
    const draft = library.createDraft({ type: row.type, progHash: row.progHash, args: seed })
    library.setDraftChain(draft.id, path, seq, envelopeHash)
    notifyFeedChanged()
    return { id: draft.id, type: draft.type, path, seq, prev: envelopeHash }
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

  /** Start serving a thing to peers, and remember that we are.
   *
   *  Seeds the ORIGINAL admitted tar -- the same bytes Share hands out -- so
   *  the magnet resolves to exactly what was signed. */
  async function startSeeding(envelopeHash: string): Promise<Record<string, unknown>> {
    const r = exportThing(envelopeHash)
    if ('error' in r) return { error: r.error }
    const started = await seeder.start(envelopeHash, r.tar, r.filename)
    if ('error' in started) return { error: started.error }
    library.rememberSeeding(envelopeHash, started.magnet, Date.now())
    notifyFeedChanged()
    return { magnet: started.magnet }
  }

  function stopSeeding(envelopeHash: string): Record<string, unknown> {
    const was = seeder.stop(envelopeHash)
    library.forgetSeeding(envelopeHash)
    notifyFeedChanged()
    return { stopped: was }
  }

  /** What is being announced right now. Live peer counts from the torrents,
   *  joined to the library so the view can name what it is exposing. */
  function seedingStatus(): Record<string, unknown>[] {
    return seeder.status().map((s) => {
      const row = library.get(s.envelopeHash)
      return { ...s, type: row?.type ?? 'unknown', missing: row === null }
    })
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

  // ── Relays ─────────────────────────────────────────────────────────────────
  // Until now every thing arrived because a human handed over its bytes. A
  // relay is how one arrives that nobody handed you -- and that is ALL it is:
  // reach, never authority. The bytes go through admission like any other
  // stranger's, and nothing the relay says decides anything.
  //
  // Nothing is connected to and nothing is published by default. The relay
  // list starts empty, and posting is a separate explicit act.
  const nostr = new NostrService()
  nostr.setMaxBundleBytes(MAX_INLINE_BUNDLE)

  /** The one subscription for now: every thing, from the cursor forward. Once
   *  forums exist this becomes one subscription per group. */
  const SUB_ALL = 'things'
  const subAll = (): { id: string; tags: Record<string, string[]>; since: number } => ({
    id: SUB_ALL,
    tags: { [TAG.topic]: ['thing'] },
    since: library.cursor(SUB_ALL)
  })

  /** A thing off a relay. Untrusted exactly like a file or a URL: the bytes go
   *  through admission and nothing the relay said decides anything. */
  async function onRelayThing(ev: ParsedThingEvent, url: string): Promise<void> {
    await handleRelayThing(ev, url)
    // The cursor moves only once the event has been fully DEALT WITH -- kept,
    // refused, or deliberately skipped. Moving it up front (when the event
    // merely parsed) loses a thing whose ingest is still in flight when the
    // app quits: the write never lands, the cursor is already past it, and no
    // reconnect ever asks for it again. An exception leaves the cursor where
    // it was, so the event is re-read rather than silently dropped.
    //
    // created_at is the POSTER's claim, so it is clamped. An event dated in the
    // year 3000 would otherwise push the cursor past everything real and make
    // the subscription silently deaf -- a one-line denial of service.
    const notFuture = Math.floor(Date.now() / 1000) + 3600
    if (ev.event.created_at > library.cursor(SUB_ALL) && ev.event.created_at <= notFuture) {
      library.setCursor(SUB_ALL, ev.event.created_at)
    }
  }

  /** One event, from parsed to stored. Separate from the cursor above so that
   *  every way of being done with an event -- including the early returns --
   *  advances it exactly once, and only after the work is actually done. */
  async function handleRelayThing(ev: ParsedThingEvent, url: string): Promise<void> {
    // A pointer rather than an inline bundle. Recorded as an OFFER and
    // deliberately not followed: this is the first thing in the shell that
    // could make the machine download because a stranger said to, and it does
    // not. Nothing is contacted until a human presses Fetch.
    if (!ev.bundle) {
      if (!ev.fetchLocator) return
      if (!followable(ev.fetchLocator)) {
        record({ type: 'offer-refused', hash: ev.envelopeHash, reason: 'locator scheme not followable from a relay' })
        return
      }
      const noted = library.recordOffer({
        envelopeHash: ev.envelopeHash,
        locator: ev.fetchLocator,
        relayUrl: url,
        poster: ev.event.pubkey,
        type: ev.type,
        inGroup: ev.group,
        replyTo: ev.replyTo,
        now: Date.now()
      })
      if (noted) notifyFeedChanged()
      return
    }
    const held = library.get(ev.envelopeHash) !== null
    if (!held) {
      const outcome = await ingestBytes(ev.bundle)
      if (outcome.status !== 'valid') {
        record({
          type: 'relay-refused',
          relay: url,
          hash: ev.envelopeHash,
          reason: String(outcome.reason ?? outcome.status)
        })
        return
      }
      // The hash the event ADVERTISED must be the thing that arrived, or the
      // event pointed at one thing and carried another.
      if (outcome.envelopeHash !== ev.envelopeHash) {
        record({ type: 'relay-mismatch', advertised: ev.envelopeHash, got: String(outcome.envelopeHash) })
        return
      }
    }
    // Posting is not authoring. Anyone may rebroadcast anyone's thing, so who
    // handed it to us is recorded BESIDE the author the signature names --
    // equal only when the author bound this nostr key to the thing themselves.
    //
    // The bound key is read from the LIBRARY rather than from the ingest that
    // may not have happened: a thing arriving a second time, from a different
    // poster, must be attributed as accurately as the first time.
    const bound = library.boundEncKey(ev.envelopeHash)
    library.noteRelayArrival(
      ev.envelopeHash,
      url,
      ev.event.pubkey,
      bound !== null && bound.scheme === NOSTR_ENC_SCHEME && bound.key === ev.event.pubkey,
      Date.now()
    )
    if (!held) notifyFeedChanged()
  }

  nostr.setHandler((ev, url) => {
    void onRelayThing(ev, url).catch(() => undefined)
  })
  stopRelays = () => nostr.destroy()

  /** Talk to a relay, and ask it for things. Persisted, so it comes back on
   *  the next launch; the human added it, the shell never adds one itself. */
  function addRelay(input: unknown): Record<string, unknown> {
    const url = typeof input === 'string' ? input.trim() : ''
    if (!/^wss?:\/\/[^\s]+$/i.test(url)) return { error: 'a relay address looks like wss://relay.example' }
    library.addRelay(url, Date.now())
    nostr.connect(url)
    nostr.subscribe(subAll())
    return { added: url, relays: nostr.status() }
  }

  // ── The suggested community ────────────────────────────────────────────────
  // What the chrome needs in order to OFFER the project's relay and welcome
  // forum, and the one call that acts on a yes. Nothing in here runs on its
  // own: the relay list starts empty and stays empty until a person, having
  // read what it costs, asks for this.

  /** Whether there is anything left to offer, and what. */
  function communityState(): Record<string, unknown> {
    const relay = suggestedRelay()
    const forum = welcomeForumBundle()
    let forumHash: string | null = null
    if (forum) {
      try {
        const r = admitBundle(parseBundle(forum))
        if (r.status === 'valid') forumHash = hex(r.envelopeHash)
      } catch {
        /* a broken bundled forum is simply not offered */
      }
    }
    return {
      relay,
      relayAdded: library.relays().includes(relay),
      forumAvailable: forumHash !== null,
      forumHeld: forumHash !== null && library.get(forumHash) !== null,
      forumHash
    }
  }

  /** The human said yes. Adds the relay exactly as typing it into the Relays
   *  window would, and admits the forum letter through the ordinary gate. */
  async function joinCommunity(): Promise<Record<string, unknown>> {
    const added = addRelay(suggestedRelay())
    if (added.error) return added
    let forumHash: string | null = null
    const forum = welcomeForumBundle()
    if (forum) {
      const outcome = await ingestBytes(forum)
      if (outcome.status === 'valid' && typeof outcome.envelopeHash === 'string') forumHash = outcome.envelopeHash
      else record({ type: 'welcome-rejected', reason: `forum: ${String(outcome.reason ?? outcome.status)}` })
    }
    return { ...communityState(), joined: true, forumHash }
  }

  function removeRelay(input: unknown): Record<string, unknown> {
    const url = typeof input === 'string' ? input.trim() : ''
    const removed = library.removeRelay(url)
    nostr.disconnect(url)
    return { removed, relays: nostr.status() }
  }

  // ── Offers: following a pointer ────────────────────────────────────────────
  // An event over the inline cap carries a hash and a locator instead of bytes.
  // Following one is the only fetch in the shell that a STRANGER can propose,
  // so it is the only one gated on a press: an offer sits in the feed, naming
  // what it is and where it would come from, until somebody asks for it.

  /** Locators a relay is allowed to name.
   *
   *  `file:` is excluded deliberately. A relay advertising `file:/etc/passwd`
   *  would make the shell read a path a stranger chose. Admission would refuse
   *  whatever came back, so nothing could be ingested -- but the read itself
   *  happened, and whether it succeeded is observable. A remote advertiser has
   *  no business naming local paths, and this is cheap now and impossible to
   *  retrofit once something relies on it. */
  function followable(locator: string): boolean {
    const l = locator.trim()
    // A magnet is NOT a transport locator -- it is a background transfer, and
    // the transport service has never known about it (see fetchNameOrLocator,
    // which routes magnets away before dispatching). Asking `supports` about
    // one therefore answers no, which would quietly make every pointer over
    // the inline cap unfollowable: exactly the case pointers exist for.
    if (/^magnet:/i.test(l)) return infoHashOf(l) !== null
    return /^(https?:|bundle:)/i.test(l) && transport.supports(l)
  }

  /** Everything a relay has offered that this library does not hold. */
  function offerList(inGroup?: unknown): Record<string, unknown>[] {
    const q = typeof inGroup === 'string' && HEX64.test(inGroup) ? { inGroup } : {}
    return library.offers(q).map((o) => ({ ...o }))
  }

  /** Fetch an offered thing. THE PRESS: nothing calls this on its own.
   *
   *  Whatever comes back must admit to the hash that was advertised. A magnet
   *  becomes a background transfer that verifies when it lands; everything
   *  else is fetched and checked here. */
  async function fetchOffer(envelopeHash: unknown): Promise<Record<string, unknown>> {
    if (typeof envelopeHash !== 'string' || !HEX64.test(envelopeHash)) return { error: 'bad hash' }
    if (library.get(envelopeHash)) {
      library.dropOffer(envelopeHash)
      return { status: 'valid', duplicate: true }
    }
    const offer = library.offer(envelopeHash)
    if (!offer) return { error: 'nothing is offering that' }
    // Re-checked at the press, not only when it was recorded: the row could
    // have come from an older version, or a database somebody edited.
    if (!followable(offer.locator)) {
      library.setOfferState(envelopeHash, 'failed', 'that locator cannot be followed from a relay')
      notifyFeedChanged()
      return { error: 'that locator cannot be followed from a relay' }
    }

    if (/^magnet:/i.test(offer.locator.trim())) {
      const started = await startTransfer(offer.locator.trim())
      if (started.status !== 'started') {
        library.setOfferState(envelopeHash, 'failed', String(started.reason ?? 'could not start'))
        notifyFeedChanged()
        return started
      }
      // The transfer holds the expectation, so a resume after a restart still
      // knows which thing it was started to get.
      library.setOfferState(envelopeHash, 'fetching', '', String(started.transferId))
      notifyFeedChanged()
      return started
    }

    library.setOfferState(envelopeHash, 'fetching')
    notifyFeedChanged()
    let bytes: Uint8Array
    try {
      bytes = await transport.fetch(offer.locator.trim())
    } catch (e) {
      library.setOfferState(envelopeHash, 'failed', `transport: ${(e as Error).message}`)
      notifyFeedChanged()
      return { status: 'invalid', reason: `transport: ${(e as Error).message}` }
    }
    const outcome = await ingestBytes(bytes, envelopeHash)
    if (outcome.status !== 'valid') {
      library.setOfferState(envelopeHash, 'failed', String(outcome.reason ?? outcome.status))
      notifyFeedChanged()
      return outcome
    }
    // ingestBytes drops the offer once the thing is held.
    return outcome
  }

  /** Send a thing to every connected relay. Deliberately an explicit act:
   *  nothing reaches a relay because it was merely published. */
  async function postToRelays(envelopeHash: unknown): Promise<Record<string, unknown>> {
    if (typeof envelopeHash !== 'string' || isDraftId(envelopeHash)) {
      return { error: 'a draft has nothing signed to post' }
    }
    const row = library.get(envelopeHash)
    if (!row) return { error: 'not found' }
    // A sealed thing is addressed to named readers. Handing it to a relay
    // would not reveal its contents, but it would publish the fact of it to
    // everyone -- so this refuses rather than deciding that for the human.
    if (row.sealed) return { error: 'refusing to post a sealed letter to a relay' }
    if (nostr.status().length === 0) return { error: 'no relays — add one first' }
    const exported = exportThing(envelopeHash)
    if ('error' in exported) return { error: exported.error }
    const inline = exported.tar.length <= MAX_INLINE_BUNDLE
    // Too big to carry: the event names the thing and says where to get it.
    // A locator is only honest if we are actually serving it, so the magnet
    // comes from the seeder and a thing that is not seeded says so.
    const locator = inline ? null : seeder.magnetFor(envelopeHash)
    if (!inline && !locator) {
      return { error: 'too large to post inline — start seeding it first, so the event can point at it' }
    }
    const replyTo = refTarget(library.load(envelopeHash)?.manifest.args ?? null)
    const forumOfPost = inGroupOf(envelopeHash)
    const event = await buildThingEvent(
      {
        envelopeHash,
        type: row.type,
        ...(inline ? { bundle: exported.tar } : { fetchLocator: locator! }),
        // `thing-group` is which FORUM this belongs to. A thing's own chain
        // path is a different fact entirely -- it says which line of versions
        // this is -- and tagging an event with it would put every amended
        // thing in a "group" named after itself.
        ...(forumOfPost ? { group: forumOfPost } : {}),
        ...(replyTo ? { replyTo } : {}),
        createdAt: Math.floor(Date.now() / 1000)
      },
      keyring.nostrSecret
    )
    const sent = nostr.publish(event)
    return { posted: sent, inline, relays: nostr.status().length, eventId: event.id }
  }

  function relayState(): Record<string, unknown> {
    return { relays: nostr.status(), since: library.cursor(SUB_ALL) }
  }

  // Reconnect to the relays the human added, and resume each subscription from
  // where it left off.
  for (const url of library.relays()) nostr.connect(url)
  if (library.relays().length > 0) nostr.subscribe(subAll())

  /** Delete a thing everywhere the shell holds it: close it if open, drop the
   *  library row (+ GC of now-unreferenced content blobs), and stop seeding
   *  its bundle. Copies held by others are of course unaffected — a signed
   *  thing is public and permanent once shared. */
  function deleteThing(envelopeHash: string): Record<string, unknown> {
    if (isDraftId(envelopeHash)) return deleteDraft(envelopeHash)
    if (current?.envelopeHash === envelopeHash) destroyCurrent()
    // Stop announcing BEFORE the row goes: the library's delete drops the
    // seeding record, and a live torrent left running would keep serving a
    // thing the human just deleted.
    seeder.stop(envelopeHash)
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
  /** A co-signature awaiting approval: the manifest bytes VERBATIM (never a
   *  re-encode -- see cosignBundle) plus the program and blobs they commit to,
   *  captured when the dialog was raised so approval signs exactly what the
   *  human was shown, even if the open thing changes meanwhile. */
  interface PendingCosign {
    manifestBytes: Uint8Array
    manifestHash: string
    program: Uint8Array
    blobs: Map<string, Uint8Array>
    timer: ReturnType<typeof setTimeout>
  }
  type PendingAction = ({ kind: 'publish' } & PendingPublish) | ({ kind: 'cosign' } & PendingCosign)
  let nextConfirmId = 1
  const pendingConfirms = new Map<number, PendingAction>()
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
    // If this draft is amending something, the chain goes on the ENVELOPE --
    // path/seq/prev are envelope fields (§5.3), not args, so a program cannot
    // put itself into someone's version history.
    const chain = p.draftId ? library.draftChain(p.draftId) : null
    const tar = await buildBundle(keyring.signer, {
      program: p.program,
      type: p.draft.type,
      args,
      attachments: p.attachments,
      // Bind this author's nostr key, covered by the signature. It is what
      // lets a message on another network be checked against the thing it
      // carries -- without it a relay event and a thing are two unrelated
      // signatures that happen to arrive together.
      enc: { e: NOSTR_ENC_SCHEME, ek: keyring.identity.nostrPubkey },
      ...(chain ? { path: chain.path, seq: chain.seq, prev: fromHex(chain.prev) } : {})
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
    pendingConfirms.set(id, {
      kind: 'publish',
      draft: o.latestDraft,
      draftId: o.draftId,
      attachments,
      program: o.stored.program,
      timer
    })
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
    if (p.kind === 'cosign') {
      void persistApprovedCosign(p)
        // Same reason publish has one: a throw here would leave the human who
        // approved a signature with no outcome at all.
        .catch((e: unknown) => ({ status: 'invalid', reason: `co-sign: ${(e as Error).message}` }))
        .then((outcome) => {
          shell.lastPublish = outcome
          chrome.webContents.send('shell:publish-result', outcome)
        })
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
          // WHICH draft, so the chrome can tell whether it is still looking at
          // it. "Land on the signed instance" is only right for someone who
          // was watching that draft; the result arrives asynchronously, and by
          // then the view may have moved on.
          outcome.consumedDraftId = p.draftId
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
  ipcMain.handle('shell:update-status', () => updateStatus())
  ipcMain.handle('shell:update-check', async () => {
    await updates.check({ manual: true })
    return updateStatus()
  })
  ipcMain.handle('shell:update-set-pref', (_e, p: unknown) => {
    // `ask` is the absence of an answer, not something the chrome can choose.
    if (p === 'on' || p === 'off') updates.setPref(p)
    return updateStatus()
  })
  ipcMain.handle('shell:update-download', async () => {
    await updates.download()
    return updateStatus()
  })
  ipcMain.handle('shell:update-install', () => updates.install())
  ipcMain.handle('shell:update-open-release', async () => {
    // The URL is built here from the version the updater found, never taken
    // from the chrome.
    const s = updates.status().state
    if (s.phase !== 'available' || !/^\d+\.\d+\.\d+$/.test(s.version)) return false
    await electronShell.openExternal(`https://github.com/souspli/souspli/releases/tag/v${s.version}`)
    return true
  })
  ipcMain.handle('shell:feed', (_e, query) => getFeed(query))
  ipcMain.handle('shell:ingest', (_e, base64: string) => ingestBytes(base64ToBytes(base64)))
  ipcMain.handle('shell:fetch', (_e, locator: string) => fetchNameOrLocator(locator))
  ipcMain.handle('shell:open', (_e, envelopeHash: string) => openThing(envelopeHash))
  // Main sometimes opens a thing itself -- a .thing double-clicked in the file
  // manager, the first-run welcome -- and the chrome has to follow, or its
  // header goes on saying "Select a letter" over a mounted one. The event alone
  // is not enough: at boot it can fire before the chrome has a listener. So the
  // hash is also held here until the chrome collects it.
  ipcMain.handle('shell:pending-open', () => {
    const hash = pendingOpen
    pendingOpen = null
    return hash
  })
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
  ipcMain.handle('shell:new-attestation', (_e, h: unknown) => newAttestation(h))
  ipcMain.handle('shell:people', () => library.people())
  ipcMain.handle('shell:set-petname', (_e, p: unknown) => {
    const v = p as { scheme?: unknown; key?: unknown; name?: unknown; note?: unknown }
    if (typeof v?.scheme !== 'string' || typeof v?.key !== 'string') return { ok: false }
    library.setPetname(v.scheme, v.key, typeof v.name === 'string' ? v.name : '', typeof v.note === 'string' ? v.note : '', Date.now())
    notifyFeedChanged() // every row showing this author is now stale
    return { ok: true }
  })
  ipcMain.handle('shell:amend', (_e, h: unknown) => amendThing(h))
  ipcMain.handle('shell:history', (_e, author: unknown, path: unknown) =>
    typeof author === 'string' && typeof path === 'string' ? library.chainHistory(author, path) : []
  )
  ipcMain.handle('shell:groups-listing', (_e, scheme: unknown, key: unknown) =>
    typeof scheme === 'string' && typeof key === 'string' ? groupsListing(scheme, key) : []
  )
  ipcMain.handle('shell:transfers', () => transferState())
  ipcMain.handle('shell:transfer-cancel', (_e, id: unknown) => cancelTransfer(id))
  ipcMain.handle('shell:cosign', (_e, h: unknown) => cosignThing(h))
  ipcMain.handle('shell:document', (_e, h: unknown) =>
    typeof h === 'string' && HEX64.test(h) ? documentFacts(h) : { cosignable: false, signatures: [], namedSigners: [] }
  )
  ipcMain.handle('shell:new-vouch', (_e, s: unknown, k: unknown) => newVouch(s, k))
  ipcMain.handle('shell:vouches-for', (_e, s: unknown, k: unknown) => vouchesFor(s, k))
  ipcMain.handle('shell:attestations', (_e, h: unknown) => attestationsFor(h))
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
        title: 'Save letter to share',
        defaultPath: `${safeType}-${envHash.slice(0, 8)}.thing`,
        filters: [{ name: 'Souspli letter', extensions: ['thing'] }]
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
      title: 'Save letter to share',
      defaultPath: r.filename,
      filters: [{ name: 'Souspli letter', extensions: ['thing'] }]
    })
    if (res.canceled || !res.filePath) return { path: null }
    await writeFile(res.filePath, r.tar)
    return { path: res.filePath }
  })
  /** The same bytes Export writes to a file, as base64 for the clipboard --
   *  which is exactly what the Ingest box's paste path takes. Sized in the tens
   *  of KB for a thing with a picture: fine to paste, and it needs no network,
   *  which makes it the way to test a transfer before torrents work. */
  ipcMain.handle('shell:export-base64', (_e, h: unknown) => {
    if (typeof h !== 'string') return { error: 'bad hash' }
    const r = exportThing(h)
    if ('error' in r) return { error: r.error }
    return { base64: bytesToBase64(r.tar), bytes: r.tar.length, filename: r.filename }
  })
  ipcMain.handle('shell:seed-start', async (_e, h: unknown) =>
    typeof h === 'string' ? await startSeeding(h) : { error: 'bad hash' }
  )
  ipcMain.handle('shell:seed-stop', (_e, h: unknown) =>
    typeof h === 'string' ? stopSeeding(h) : { stopped: false }
  )
  ipcMain.handle('shell:seed-status', () => seedingStatus())
  ipcMain.handle('shell:vote', async (_e, h: unknown, dir: unknown) => await castVote(h, dir))
  ipcMain.handle('shell:votes', (_e, h: unknown) =>
    typeof h === 'string' && HEX64.test(h) ? voteFacts(h) : { error: 'bad hash' }
  )
  ipcMain.handle('shell:thread', (_e, h: unknown) => threadFor(h))
  ipcMain.handle('shell:forums', () => forums())
  ipcMain.handle('shell:forum', (_e, h: unknown) => forumFacts(h))
  ipcMain.handle('shell:forum-listing', (_e, h: unknown) => forumListing(h))
  ipcMain.handle('shell:forum-post', (_e, h: unknown, key: unknown) => newForumPost(h, key))
  ipcMain.handle('shell:request-join', (_e, h: unknown) => requestJoin(h))
  ipcMain.handle('shell:new-verdict', (_e, h: unknown, g: unknown, v: unknown) => newVerdict(h, g, v))
  ipcMain.handle('shell:in-group', (_e, h: unknown) =>
    typeof h === 'string' && HEX64.test(h) ? inGroupOf(h) : null
  )
  ipcMain.handle('shell:offers', (_e, g: unknown) => offerList(g))
  ipcMain.handle('shell:fetch-offer', async (_e, h: unknown) => await fetchOffer(h))
  ipcMain.handle('shell:relays', () => relayState())
  ipcMain.handle('shell:community', () => communityState())
  ipcMain.handle('shell:community-join', () => joinCommunity())
  ipcMain.handle('shell:relay-add', (_e, url: unknown) => addRelay(url))
  ipcMain.handle('shell:relay-remove', (_e, url: unknown) => removeRelay(url))
  ipcMain.handle('shell:relay-post', async (_e, h: unknown) => await postToRelays(h))
  ipcMain.handle('shell:relay-arrivals', (_e, h: unknown) =>
    typeof h === 'string' ? library.relayArrivals(h) : []
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
  shell.seedStart = (h) => startSeeding(h)
  shell.seedStop = (h) => stopSeeding(h)
  shell.seedStatus = () => seedingStatus()
  shell.vote = (h, dir) => castVote(h, dir)
  shell.votes = (h) => voteFacts(h)
  shell.thread = (h) => threadFor(h)
  shell.forums = () => forums()
  shell.forum = (h) => forumFacts(h)
  shell.forumListing = (h) => forumListing(h)
  shell.newForumPost = (h, key) => newForumPost(h, key)
  shell.requestJoin = (h) => requestJoin(h)
  shell.newVerdict = (h, g, v) => newVerdict(h, g, v)
  shell.offers = (g) => offerList(g)
  shell.fetchOffer = (h) => fetchOffer(h)
  shell.relays = () => relayState()
  shell.addRelay = (url) => addRelay(url)
  shell.removeRelay = (url) => removeRelay(url)
  shell.postToRelays = (h) => postToRelays(h)
  shell.relayArrivals = (h) => library.relayArrivals(h)
  shell.exportBase64 = (h) => {
    const r = exportThing(h)
    return 'error' in r ? { error: r.error } : { base64: bytesToBase64(r.tar), bytes: r.tar.length }
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
  shell.newAttestation = (h) => newAttestation(h)
  shell.people = () => library.people()
  shell.setPetname = (scheme, key, name, note) => {
    library.setPetname(scheme, key, name, note ?? '', Date.now())
    notifyFeedChanged()
  }
  shell.amend = (h) => amendThing(h)
  shell.history = (author, path) => library.chainHistory(author, path)
  shell.groupsListing = (scheme, key) => groupsListing(scheme, key)
  shell.transfers = () => transferState()
  shell.cancelTransfer = (id) => cancelTransfer(id)
  shell.cosign = (h) => cosignThing(h)
  shell.document = (h) => documentFacts(h)
  shell.newVouch = (s, k) => newVouch(s, k)
  shell.vouchesFor = (s, k) => vouchesFor(s, k)
  shell.tribe = () => [...myTribe()].map(([id, v]) => ({ id, hops: v.hops, via: v.via }))
  shell.attestations = (h) => attestationsFor(h) as { count: number; rows: unknown[] }
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
          announceOpened(outcome.envelopeHash)
        }
      }
    } finally {
      draining = false
    }
  }
  // Read BEFORE the drain below starts admitting things: both answers are about
  // how this launch began, and the drain is what changes them.
  const emptyAtBoot = library.count() === 0
  const launchedWithFile = pendingOpenFiles.length > 0
  drainOpenFiles = () => void openFilesNow()
  drainOpenFiles() // anything the OS handed us before we were ready

  // First run: open onto a letter rather than an empty window. Offered exactly
  // once per library, and only to an empty one -- an existing library has
  // something better to show, and someone who deleted the welcome meant it.
  // It goes through ingestBytes like anything else; bundled is not trusted.
  // Launched WITH a file, the welcome still joins the feed but does not take
  // the screen: the file is what they came for.
  void (async () => {
    if (process.env.SHELL_NO_WELCOME === '1' || library.hasFlag(WELCOME_FLAG)) return
    library.setFlag(WELCOME_FLAG)
    if (!emptyAtBoot) return
    const outcome = await ingestBytes(welcomeBundle())
    if (outcome.status !== 'valid' || typeof outcome.envelopeHash !== 'string') {
      record({ type: 'welcome-rejected', reason: String(outcome.reason ?? outcome.status) })
      return
    }
    if (launchedWithFile) return
    await openThing(outcome.envelopeHash)
    announceOpened(outcome.envelopeHash)
  })()

  // Resume whatever this shell was serving when it last ran. Deliberately
  // AFTER ready and not awaited: loading webtorrent takes a moment, a peer
  // that cannot be reached must not delay startup, and a shell that opens
  // slowly because of a torrent is a worse shell.
  // Resume the downloads the human asked for. webtorrent re-verifies whatever
  // partial data is already in the profile's download directory, so a quit
  // costs the verify pass rather than the transfer.
  void (async () => {
    for (const t of library.transfers()) {
      const started = await seeder.startDownload(t.id, t.magnet, t.name)
      if (started?.error) {
        record({ type: 'transfer-resume-failed', id: t.id, reason: started.error })
        continue
      }
      void watchTransfer(t.id)
    }
    pushTransfers()
  })()

  void (async () => {
    for (const row of library.seeding()) {
      const r = await startSeeding(row.envelopeHash)
      if (r.error) {
        // The row stays: the human asked for this to be shared, and a failure
        // to resume is not a decision to stop. It shows in the sharing view.
        record({ type: 'seed-failed', envelopeHash: row.envelopeHash, reason: String(r.error) })
      }
    }
  })()

  shell.ready = true
  dbg('ready-done')
}).catch((e) => dbg(`whenReady FAILED ${String(e)}\n${(e as Error).stack}`))

// Stop announcing before the process goes. Not strictly required -- the OS
// closes the sockets -- but leaving the DHT with stale peer records for a shell
// that is gone is rude to the swarm.
app.on('before-quit', () => {
  void stopAllSeeding?.()
  stopRelays?.()
})

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
