import { app, BaseWindow } from 'electron'
import { AdmissionService } from './admission/index.js'
import { Keyring } from './keyring/index.js'
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

// ── The shell — trusted client bootstrap ─────────────────────────────────────
// Phase 3: admission (isolated) + keyring (software key custody for now) are
// wired here. The library, mount, and full chrome UI land next. A
// test-observable surface is exposed on `app.__shell` so the suite can drive
// admission and inspect the keyring from OUTSIDE the process, mirroring the
// cage's `app.__cage` pattern.

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** JSON-safe projection of an AdmissionResult for the test surface. */
function summarize(r: AdmissionResult): Record<string, unknown> {
  if (r.status === 'valid') {
    return {
      status: 'valid',
      sealed: r.sealed,
      type: r.manifest.type,
      envelopeHash: hex(r.envelopeHash),
      author: { scheme: r.envelope.author.s, k: hex(r.envelope.author.k) },
      attachments: [...r.attachments.keys()],
      created: r.envelope.created,
      path: r.envelope.path ?? null,
      seq: r.envelope.seq ?? null
    }
  }
  if (r.status === 'invalid') return { status: 'invalid', reason: r.reason }
  if (r.status === 'unverifiable') return { status: 'unverifiable', scheme: r.scheme }
  return { status: 'not-for-me' }
}

interface ShellSurface {
  ready: boolean
  identity?: { address: string; nostrPubkey: string }
  userDataDir?: string
  admit?: (raw: number[]) => Promise<Record<string, unknown>>
  signAndAdmit?: (type: string) => Promise<Record<string, unknown>>
}

const shell: ShellSurface = { ready: false }
;(app as unknown as { __shell: ShellSurface }).__shell = shell

/** Optional limit overrides so the hostile-input battery can exercise the caps
 *  with small payloads. Production uses the format defaults. */
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

app.whenReady().then(async () => {
  const userDataDir = process.env.SHELL_USER_DATA_DIR ?? app.getPath('userData')
  const keyring = Keyring.loadOrCreate(userDataDir)
  const admission = new AdmissionService({ limits: limitsFromEnv() })

  shell.identity = {
    address: hex(keyring.identity.address),
    nostrPubkey: hex(keyring.identity.nostrPubkey)
  }
  shell.userDataDir = userDataDir
  shell.admit = async (raw: number[]) => {
    const result = await admission.admit(Uint8Array.from(raw), keyring.unsealer)
    return summarize(result)
  }
  // Prove the keyring's Signer produces signatures `format` accepts — and that
  // `format` receives the Signer INTERFACE, never key bytes (encodeEnvelope is
  // handed keyring.signer, whose sign() closes over the key internally).
  shell.signAndAdmit = async (type: string) => {
    const program = new TextEncoder().encode('<!doctype html><h1>self-signed</h1>')
    const manifest: Manifest = { v: 1, prog: hash(program), type, args: null, att: new Map() }
    const manifestBytes = encodeManifest(manifest)
    const envelope = await encodeEnvelope({ man: hash(manifestBytes), created: 1 }, keyring.signer)
    return summarize(admitBundle({ envelope, manifest: manifestBytes, program, blobs: new Map() }))
  }
  shell.ready = true

  // A window so the app stays alive; the real 3-pane chrome lands next stage.
  // LATER: omnibar + feed + per-thing header + confirms; mount cages beneath.
  new BaseWindow({ width: 1000, height: 760, title: 'shell', backgroundColor: '#111214' })
})

app.on('window-all-closed', () => app.quit())
