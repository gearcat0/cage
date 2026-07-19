import { WebContentsView, session as electronSession } from 'electron'
import type { Session, WebContentsView as View } from 'electron'
import { registerThingProtocol, THING_CSP, type ResourceMap } from './protocol.js'
import { record } from './events.js'

// ── The cage ────────────────────────────────────────────────────────────────
// A hardened `WebContentsView` (NOT a bare BrowserWindow webContents) that runs
// one untrusted thing. Every hardening flag is on, the session partition is
// ephemeral and unique, and multiple independent layers each enforce "no
// network". Any single layer failing is not a breach.
//
// The layers are labelled 1–4 to match the build brief. They are deliberately
// redundant: connect-src 'none' (Layer 4) and the request canceller (Layer 2)
// each kill fetch/XHR/WebSocket on their own; WebRTC (which webRequest cannot
// see) is closed separately in Layer 3.

export interface CageHandle {
  view: View
  session: Session
  partition: string
  preloadPath: string
}

export interface CageOptions {
  /** Random per-thing id; also used as the storage partition suffix. */
  id: string
  /** Absolute path to the compiled cage preload (out/preload/index.js). */
  preloadPath: string
  /** Everything the thing:// handler may serve for this cage: the program
   *  bytes plus the admitted attachment table and its store (CAS/ephemeral). */
  resources: ResourceMap
}

export function createCage(opts: CageOptions): CageHandle {
  // ── Layer 1 — process configuration ──────────────────────────────────────
  // A fresh, NON-persistent partition per thing (no `persist:` prefix => memory
  // only). This means a thing — or a reload of the same thing — can never read
  // storage breadcrumbs left by another. That would be a tracking channel, and
  // it must be impossible.
  const partition = `thing-${opts.id}`
  const ses = electronSession.fromPartition(partition, { cache: false })

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      preload: opts.preloadPath,
      sandbox: true, // Layer 1: OS-level renderer sandbox
      contextIsolation: true, // Layer 1: preload world is isolated from the page
      nodeIntegration: false, // Layer 1: no Node in the renderer
      nodeIntegrationInSubFrames: false, // Layer 1: ...nor in iframes
      webSecurity: true, // Layer 1: same-origin policy on
      allowRunningInsecureContent: false, // Layer 1
      experimentalFeatures: false, // Layer 1
      webviewTag: false, // no <webview> escape hatch
      navigateOnDragDrop: false, // dropping a file must not navigate the cage
      spellcheck: false, // spellcheck fetches dictionaries — no network, so off
      v8CacheOptions: 'none'
    }
  })

  const contents = view.webContents

  hardenSession(ses, opts.resources)
  hardenContents(contents)

  return { view, session: ses, partition, preloadPath: opts.preloadPath }
}

function hardenSession(ses: Session, resources: ResourceMap): void {
  // The thing:// handler is the only allowed read path (serves supplied bytes).
  registerThingProtocol(ses, resources)

  // ── Layer 2 — request interception ───────────────────────────────────────
  // Cancel EVERY request whose scheme is not `thing:`. Deny by default; allow
  // narrowly. This is the network-layer backstop to the CSP in Layer 4.
  ses.webRequest.onBeforeRequest((details, cb) => {
    let scheme = ''
    try {
      scheme = new URL(details.url).protocol
    } catch {
      /* malformed -> cancel below */
    }
    if (scheme === 'thing:') {
      cb({ cancel: false })
      return
    }
    // devtools:// and blob:/data: created in-page are allowed to *resolve*
    // (they never leave the process); everything with a real remote origin is
    // cancelled and recorded.
    if (scheme === 'devtools:' || scheme === 'blob:' || scheme === 'data:') {
      cb({ cancel: false })
      return
    }
    record({ type: 'blocked-request', url: details.url, resourceType: details.resourceType })
    cb({ cancel: true })
  })

  // Deny all permissions (geolocation, notifications, media, clipboard, …).
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    record({ type: 'permission-denied', permission, via: 'request' })
    callback(false)
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    record({ type: 'permission-denied', permission, via: 'check' })
    return false
  })

  // ── Layer 3 — non-webRequest egress paths ────────────────────────────────
  // webRequest does NOT see WebRTC. Route any escaping HTTP(S)/SOCKS to a dead
  // port so even a bypass of Layer 2 lands nowhere.
  void ses.setProxy({ proxyRules: 'http=127.0.0.1:1;https=127.0.0.1:1;socks=127.0.0.1:1' })

  // ── Layer 4 — Content-Security-Policy ────────────────────────────────────
  // Inject the strict CSP on every thing: response header. This is redundant
  // with the CSP the protocol handler already attaches to the bytes — both are
  // present on purpose. connect-src 'none' alone kills fetch/XHR/WebSocket/
  // EventSource; the request canceller (Layer 2) kills them again.
  ses.webRequest.onHeadersReceived((details, cb) => {
    const responseHeaders = { ...(details.responseHeaders ?? {}) }
    // Strip any CSP the response may already carry, then set ours as the single
    // authority so a thing cannot weaken it by shipping its own header.
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === 'content-security-policy') delete responseHeaders[key]
    }
    responseHeaders['content-security-policy'] = [THING_CSP]
    cb({ responseHeaders })
  })
}

function hardenContents(contents: Electron.WebContents): void {
  // ── Layer 2 (continued) — navigation & window openings ───────────────────
  contents.setWindowOpenHandler(({ url }) => {
    record({ type: 'window-open-denied', url })
    return { action: 'deny' }
  })
  contents.on('will-navigate', (e, url) => {
    e.preventDefault()
    record({ type: 'navigation-blocked', url, kind: 'navigate' })
  })
  contents.on('will-redirect', (e, url) => {
    e.preventDefault()
    record({ type: 'navigation-blocked', url, kind: 'redirect' })
  })
  // A thing must not attach a preload of its own to child frames, etc.
  contents.on('will-attach-webview', (e) => e.preventDefault())

  // ── Layer 3 (continued) — WebRTC ─────────────────────────────────────────
  // With all UDP forced through a non-existent proxy, WebRTC has no path out.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

  // Never allow devtools autolaunch for a thing; the shell may open it manually
  // during debugging, but the thing cannot request it.
}
