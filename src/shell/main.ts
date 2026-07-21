import { app, BaseWindow, WebContentsView, ipcMain, protocol, session } from 'electron'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { AdmissionService } from './admission/index.js'
import { Keyring } from './keyring/index.js'
import { Library, type ThingRow } from './library/index.js'
import { mountThing, type MountedThing } from './mount/index.js'
import { installBridge, setPublishObserver } from '../main/bridge.js'
import {
  admitBundle,
  encodeEnvelope,
  encodeManifest,
  hash,
  DEFAULT_BUNDLE_LIMITS,
  type AdmissionResult,
  type BundleLimits,
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

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
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

interface ShellSurface {
  ready: boolean
  identity?: { address: string; nostrPubkey: string }
  userDataDir?: string
  admit?: (raw: number[]) => Promise<Record<string, unknown>>
  signAndAdmit?: (type: string) => Promise<Record<string, unknown>>
  ingest?: (raw: number[]) => Promise<Record<string, unknown>>
  feed?: (query?: unknown) => ThingRow[]
  open?: (envelopeHash: string) => Promise<Record<string, unknown>>
  lastConfirm?: { id: number; kind: string; summary: Record<string, unknown> } | null
}

const shell: ShellSurface = { ready: false, lastConfirm: null }
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
  dbg('window')

  // ── Window + chrome ────────────────────────────────────────────────────────
  const win = new BaseWindow({ width: 1200, height: 820, backgroundColor: '#08080a', title: 'the shell' })
  const chrome = new WebContentsView({
    webPreferences: { preload: CHROME_PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  win.contentView.addChildView(chrome)

  let mounted: MountedThing | null = null

  function cageRect(): Electron.Rectangle {
    const { width, height } = win.getContentBounds()
    return { x: FEED_WIDTH, y: TOP_BAR + THING_HEADER, width: width - FEED_WIDTH, height: height - TOP_BAR - THING_HEADER }
  }
  function layout(): void {
    const { width, height } = win.getContentBounds()
    chrome.setBounds({ x: 0, y: 0, width, height })
    if (mounted) mounted.view.setBounds(cageRect())
  }
  win.on('resize', layout)

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
      notifyFeedChanged()
    }
    return summarize(result)
  }

  function getFeed(query: unknown): ThingRow[] {
    const q = (query ?? {}) as { type?: string; author?: string; limit?: number }
    return library.feed(q)
  }

  async function openThing(envelopeHash: string): Promise<Record<string, unknown>> {
    const stored = library.load(envelopeHash)
    if (!stored) return { error: 'not found or not mountable (sealed)' }
    if (mounted) mounted.destroy()
    mounted = await mountThing({
      win,
      preloadPath: CAGE_PRELOAD,
      stored,
      bounds: cageRect()
    })
    library.markRead(envelopeHash)
    notifyFeedChanged()
    return { ...mounted.header }
  }

  // ── Confirm flow: a thing's publish request is decided HERE, in chrome ─────
  let nextConfirmId = 1
  const pendingConfirms = new Map<number, (approved: boolean) => void>()
  setPublishObserver((draft) => {
    const id = nextConfirmId++
    const req = { id, kind: 'publish', summary: draft as Record<string, unknown> }
    shell.lastConfirm = req
    chrome.webContents.send('shell:confirm-request', req)
    pendingConfirms.set(id, (approved) => {
      // Phase 3: approval is recorded, not yet acted on (signing/sealing LATER).
      // The point proven here is that the grant is a human decision in chrome.
      void approved
    })
  })
  ipcMain.on('shell:confirm-response', (_e, id: number, approved: boolean) => {
    pendingConfirms.get(id)?.(approved)
    pendingConfirms.delete(id)
  })

  // ── IPC surface for the chrome ─────────────────────────────────────────────
  ipcMain.handle('shell:identity', () => shell.identity)
  ipcMain.handle('shell:feed', (_e, query) => getFeed(query))
  ipcMain.handle('shell:ingest', (_e, base64: string) => ingestBytes(base64ToBytes(base64)))
  ipcMain.handle('shell:open', (_e, envelopeHash: string) => openThing(envelopeHash))
  ipcMain.handle('shell:close', () => {
    if (mounted) {
      mounted.destroy()
      mounted = null
    }
  })

  // ── Public + test surface ──────────────────────────────────────────────────
  shell.identity = { address: hex(keyring.identity.address), nostrPubkey: hex(keyring.identity.nostrPubkey) }
  shell.userDataDir = userDataDir
  shell.admit = async (raw) => summarize(await admission.admit(Uint8Array.from(raw), keyring.unsealer))
  shell.ingest = async (raw) => ingestBytes(Uint8Array.from(raw))
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
