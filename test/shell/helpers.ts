import { test as base, _electron, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { freemem, tmpdir } from 'node:os'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  encodeManifest,
  encodeEnvelope,
  hash,
  seal,
  sealEnvelope,
  sealMember,
  parseBundle,
  type BundleSource,
  type Manifest,
  type Signer
} from '../../src/format/index.js'

const SHELL_MAIN = join(__dirname, '..', '..', 'out', 'main', 'shell', 'main.js')

// ── Test signers (mirror the keyring) ────────────────────────────────────────

export function ethAddress(priv: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv, true)).toBytes(false)
  const addr = keccak_256(uncompressed.subarray(1))
  return addr.subarray(addr.length - 20)
}

export function ethSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'eth-eip191',
    pubkey: ethAddress(priv),
    async sign(signingInput) {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${signingInput.length}`)
      const buf = new Uint8Array(prefix.length + signingInput.length)
      buf.set(prefix, 0)
      buf.set(signingInput, prefix.length)
      const digest = keccak_256(buf)
      const recd = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0]! + 27
      return out
    }
  }
}

export function nostrSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'nostr-schnorr',
    pubkey: schnorr.getPublicKey(priv),
    async sign(signingInput) {
      return schnorr.sign(sha256(signingInput), priv)
    }
  }
}

// ── Tar builder ──────────────────────────────────────────────────────────────

export function buildTar(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  const enc = new TextEncoder()
  for (const [name, data] of Object.entries(files)) {
    const header = new Uint8Array(512)
    header.set(enc.encode(name).subarray(0, 100), 0)
    header.set(enc.encode('0000644\0'), 100)
    header.set(enc.encode('0000000\0'), 108)
    header.set(enc.encode('0000000\0'), 116)
    header.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124)
    header.set(enc.encode('00000000000\0'), 136)
    header[156] = 0x30
    header.set(enc.encode('ustar\0'), 257)
    header.set(enc.encode('00'), 263)
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (const b of header) sum += b
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data, 0)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.length
  }
  return out
}

const hexName = (h: Uint8Array): string => [...h].map((b) => b.toString(16).padStart(2, '0')).join('')

export interface BuildOpts {
  type?: string
  args?: unknown
  program?: Uint8Array
  attachments?: Record<string, Uint8Array>
  created?: number
  path?: string
  seq?: number
}

/** Build a valid public bundle signed by `signer`. */
export async function buildBundle(signer: Signer, opts: BuildOpts = {}): Promise<Uint8Array> {
  const program = opts.program ?? new TextEncoder().encode('<!doctype html><h1>thing</h1>')
  const att = new Map<string, { h: Uint8Array; m: string; n: number }>()
  const files: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(opts.attachments ?? {})) {
    att.set(name, { h: hash(bytes), m: 'application/octet-stream', n: bytes.length })
    files[`blobs/${hexName(hash(bytes))}`] = bytes
  }
  const manifest: Manifest = {
    v: 1,
    prog: hash(program),
    type: opts.type ?? 'note',
    args: (opts.args ?? null) as Manifest['args'],
    att
  }
  const manifestBytes = encodeManifest(manifest)
  const env: Parameters<typeof encodeEnvelope>[0] = { man: hash(manifestBytes), created: opts.created ?? 1_700_000_000 }
  if (opts.path !== undefined) env.path = opts.path
  if (opts.seq !== undefined) env.seq = opts.seq
  const envelope = await encodeEnvelope(env, signer)
  return buildTar({ 'envelope.cbor': envelope, 'manifest.cbor': manifestBytes, program, ...files })
}

/** Build a full §7.1 sealed bundle to recipient x-only pubkeys: envelope.cbor
 *  (Sealed) plus manifest.enc / program.enc / ciphertext blobs, all encrypted
 *  under one content key CK. */
export async function buildSealedBundle(
  signer: Signer,
  recipients: Uint8Array[],
  opts: BuildOpts = {}
): Promise<Uint8Array> {
  const program = opts.program ?? new TextEncoder().encode('<!doctype html><h1>sealed thing</h1>')
  const att = new Map<string, { h: Uint8Array; m: string; n: number }>()
  const blobPlain: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(opts.attachments ?? {})) {
    att.set(name, { h: hash(bytes), m: 'application/octet-stream', n: bytes.length })
    blobPlain[hexName(hash(bytes))] = bytes
  }
  const manifest: Manifest = {
    v: 1,
    prog: hash(program),
    type: opts.type ?? 'invite',
    args: (opts.args ?? null) as Manifest['args'],
    att
  }
  const manifestBytes = encodeManifest(manifest)
  const env: Parameters<typeof encodeEnvelope>[0] = { man: hash(manifestBytes), created: opts.created ?? 5 }
  if (opts.path !== undefined) env.path = opts.path
  if (opts.seq !== undefined) env.seq = opts.seq
  const inner = await encodeEnvelope(env, signer)

  const { sealed, ck } = sealEnvelope(inner, recipients)
  const files: Record<string, Uint8Array> = {
    'envelope.cbor': sealed,
    'manifest.enc': sealMember(manifestBytes, ck),
    'program.enc': sealMember(program, ck)
  }
  for (const [hex, bytes] of Object.entries(blobPlain)) files[`blobs/${hex}`] = sealMember(bytes, ck)
  return buildTar(files)
}

/** Re-tar a BundleSource (for precise tampering: parse → corrupt a part → tar). */
export function tarFromSource(src: BundleSource): Uint8Array {
  const files: Record<string, Uint8Array> = { 'envelope.cbor': src.envelope }
  if (src.manifest) files['manifest.cbor'] = src.manifest
  if (src.program) files['program'] = src.program
  for (const [hex, bytes] of src.blobs) files[`blobs/${hex}`] = bytes
  return buildTar(files)
}

export function bundleTarHash(tar: Uint8Array): string {
  return [...hash(tar)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export { seal, secp256k1, schnorr, hash, parseBundle }

// ── Shell launcher ───────────────────────────────────────────────────────────

export interface ShellHandle {
  app: ElectronApplication
  userDataDir: string
  identity(): Promise<{ address: string; nostrPubkey: string; keyStorage: 'os' | 'software' }>
  admit(bytes: Uint8Array): Promise<Record<string, unknown>>
  /** Author a thing from bytes (no native dialogs); returns the outcome + the
   *  `.thing` bytes (base64) for a flyer round-trip. */
  compose(
    programBase64: string,
    type: string,
    attachments?: { name: string; base64: string; mime?: string }[]
  ): Promise<{ outcome: Record<string, unknown>; tarBase64: string }>
  /** The bytes a thing would be saved as, WITHOUT the native save dialog (a
   *  real one cannot be driven) — the same split shell.compose uses. */
  exportThing(envelopeHash: string): Promise<{ tarBase64?: string; filename?: string; error?: string }>
  /** The bundle as base64 — what Share's "Copy bundle" puts on the clipboard. */
  exportBase64(envelopeHash: string): Promise<{ base64?: string; bytes?: number; error?: string }>
  /** Serving a thing to peers: start, stop, and what is being served now. */
  seedStart(envelopeHash: string): Promise<Record<string, unknown>>
  seedStop(envelopeHash: string): Promise<Record<string, unknown>>
  seedStatus(): Promise<Record<string, unknown>[]>
  /** Ingest raw bundle bytes (admit + store in the library). */
  ingest(bytes: Uint8Array): Promise<Record<string, unknown>>
  /** Fetch a locator (file:/bundle:/magnet:) then admit it. */
  fetchLocator(locator: string): Promise<Record<string, unknown>>
  /** Whether the seed store holds this bundle tar-hash. */
  seedHas(hashHex: string): Promise<boolean>
  /** The feed rows (newest received first). */
  feed(): Promise<Record<string, unknown>[]>
  /** Mount a thing via the shell's own hook (returns the header facts). */
  openThing(envelopeHash: string): Promise<Record<string, unknown>>
  /** Types the user can create something of (starters + library programs). */
  knownTypes(): Promise<{ key: string; testKey: string; source: string; type: string; progHash: string }[]>
  /** Local unsigned drafts. */
  drafts(): Promise<{ id: string; type: string; progHash: string; args: unknown; created: number; updated: number }[]>
  newDraft(key: string, args?: unknown): Promise<{ id?: string; error?: string }>
  newComment(targetHash: string): Promise<{ id?: string; error?: string }>
  /** Start an attestation about a thing, and read the ones pointing at it. */
  newAttestation(targetHash: string): Promise<{ id?: string; error?: string }>
  attestations(targetHash: string): Promise<{ count: number; rows: { envelopeHash: string; authorKey: string }[] }>
  draftBlobs(draftId: string): Promise<{ name: string; hash: string; mime: string; size: number }[]>
  replies(targetHash: string): Promise<{ count: number; rows: Record<string, unknown>[] }>
  deleteDraft(id: string): Promise<{ deleted: boolean }>
  /** Files under userData whose bytes contain `needle`. */
  scanUserData(needle: Uint8Array): string[]
  /** Files under the library CAS blobs dir (hex hashes). */
  casBlobs(): string[]
  close(): Promise<void>
}

export interface ShellLaunchOptions {
  extraEnv?: Record<string, string>
}

async function waitReady(app: ElectronApplication, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  for (;;) {
    try {
      const ready = await app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell?: { ready?: boolean } }).__shell
        return Boolean(s?.ready)
      })
      if (ready) return
      lastErr = null
    } catch (e) {
      // Transient inspector hiccups during startup are retried; if the app
      // actually died this keeps failing until the deadline and the caller's
      // relaunch takes over.
      lastErr = e
    }
    if (Date.now() > deadline) {
      throw lastErr instanceof Error ? lastErr : new Error('shell did not become ready')
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Dismiss the first-run safety notice like a real user. It is a REAL modal:
 *  while it is open the cage views are hidden beneath the chrome, so a spec
 *  that never acks it sees permanently invisible cages. With the hermetic
 *  profile (userData under SHELL_USER_DATA_DIR) the notice appears on every
 *  fresh launch; a relaunch against a persisted dir has it acked already. */
async function ackSafetyNotice(app: ElectronApplication, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await app.evaluate(async (electron) => {
      const wc = electron.webContents
        .getAllWebContents()
        .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
      if (!wc) return 'no-chrome'
      return wc.executeJavaScript(`(() => {
        const b = document.querySelector('[data-testid=safety-ack]')
        if (b) { b.click(); return 'clicked' }
        return localStorage.getItem('sh-safety-ack') === '1' ? 'acked' : 'pending'
      })()`) as Promise<string>
    })
    if (state === 'clicked' || state === 'acked') return
    if (Date.now() > deadline) throw new Error(`safety notice never appeared (state: ${state})`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function launchShell(opts: ShellLaunchOptions = {}): Promise<ShellHandle> {
  // When a spec supplies its own profile dir (restart tests), the handle's
  // accessors — casBlobs(), scanUserData() — must look at THAT dir, not at a
  // temp dir we made and the app never used. We also must not delete a dir we
  // did not create: specs relaunch against theirs.
  const suppliedDir = opts.extraEnv?.SHELL_USER_DATA_DIR
  const userDataDir = suppliedDir ?? mkdtempSync(join(tmpdir(), 'shell-userdata-'))
  const ownsDir = suppliedDir === undefined
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.ELECTRON_DISABLE_SANDBOX
  // Force software key storage so the test is deterministic regardless of host
  // safeStorage availability (still never writes the plaintext key).
  env.SHELL_FORCE_SOFTWARE_KEYS = '1'
  env.SHELL_USER_DATA_DIR = userDataDir
  // Identity changes normally restart the app; under Playwright that would
  // orphan the process, so specs relaunch explicitly instead.
  env.SHELL_NO_RELAUNCH = '1'
  Object.assign(env, opts.extraEnv ?? {})

  // Electron occasionally dies during startup on CI runners (macOS
  // especially). A launch flake is not a product failure — retry a fresh
  // launch (same userData dir; a partial boot leaves nothing that matters)
  // and make the retry visible in the log.
  let launched: ElectronApplication | null = null
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 3 && !launched; attempt++) {
    const candidate = await _electron.launch({ args: [SHELL_MAIN], env })
    try {
      await waitReady(candidate)
      launched = candidate
    } catch (e) {
      lastErr = e
      // eslint-disable-next-line no-console
      console.warn(`[helpers] shell launch attempt ${attempt} failed (${(e as Error).message}); retrying`)
      await candidate.close().catch(() => {})
    }
  }
  if (!launched) throw lastErr instanceof Error ? lastErr : new Error('shell failed to launch')
  const app = launched

  // DIAGNOSTIC (SHELL_EXIT_LOG): record HOW an app goes away. A shell that
  // dies mid-test surfaces only as "Target page, context or browser has been
  // closed", which says nothing about whether it crashed, was signalled, or
  // exited cleanly. Capture the exit code/signal, a tail of its stderr, and
  // the machine's free memory at that moment.
  if (process.env.SHELL_EXIT_LOG) {
    const proc = app.process()
    const tail: string[] = []
    proc.stderr?.on('data', (b: Buffer) => {
      tail.push(String(b))
      while (tail.length > 60) tail.shift()
    })
    proc.on('exit', (code: number | null, signal: string | null) => {
      let mem = ''
      try {
        const mi = readFileSync('/proc/meminfo', 'utf8')
        mem = (mi.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '?') + ' kB available'
      } catch {
        mem = `${Math.round(freemem() / 1024)} kB free`
      }
      appendFileSync(
        process.env.SHELL_EXIT_LOG!,
        JSON.stringify({ pid: proc.pid, code, signal, at: new Date().toISOString(), mem, tail: tail.slice(-25) }) + '\n'
      )
    })
  }

  await ackSafetyNotice(app)

  return {
    app,
    userDataDir,
    identity: () =>
      app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { identity: unknown } }).__shell
        return s.identity as never
      }),
    admit: (bytes: Uint8Array) =>
      app.evaluate(async (electron, arr) => {
        const s = (electron.app as unknown as { __shell: { admit: (a: number[]) => Promise<Record<string, unknown>> } }).__shell
        return s.admit(arr)
      }, Array.from(bytes)),
    ingest: (bytes: Uint8Array) =>
      app.evaluate(async (electron, arr) => {
        const s = (electron.app as unknown as { __shell: { ingest: (a: number[]) => Promise<Record<string, unknown>> } }).__shell
        return s.ingest(arr)
      }, Array.from(bytes)),
    compose: (programBase64: string, type: string, attachments?: { name: string; base64: string; mime?: string }[]) =>
      app.evaluate(
        async (electron, a) => {
          const s = (
            electron.app as unknown as {
              __shell: {
                compose: (
                  p: string,
                  t: string,
                  att?: { name: string; base64: string; mime?: string }[]
                ) => Promise<{ outcome: Record<string, unknown>; tarBase64: string }>
              }
            }
          ).__shell
          return s.compose(a.programBase64, a.type, a.attachments)
        },
        { programBase64, type, attachments }
      ),
    seedStart: (envelopeHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { seedStart: (h: string) => Promise<Record<string, unknown>> } })
          .__shell
        return s.seedStart(h)
      }, envelopeHash),
    seedStop: (envelopeHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { seedStop: (h: string) => Record<string, unknown> } }).__shell
        return s.seedStop(h)
      }, envelopeHash),
    seedStatus: () =>
      app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { seedStatus: () => Record<string, unknown>[] } }).__shell
        return s.seedStatus() as never
      }),
    exportBase64: (envelopeHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (
          electron.app as unknown as {
            __shell: { exportBase64: (h: string) => { base64?: string; bytes?: number; error?: string } }
          }
        ).__shell
        return s.exportBase64(h)
      }, envelopeHash),
    exportThing: (envelopeHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (
          electron.app as unknown as {
            __shell: {
              exportThing: (h: string) => { tarBase64?: string; filename?: string; error?: string }
            }
          }
        ).__shell
        return s.exportThing(h)
      }, envelopeHash),
    fetchLocator: (locator: string) =>
      app.evaluate(async (electron, loc) => {
        const s = (electron.app as unknown as { __shell: { fetch: (l: string) => Promise<Record<string, unknown>> } }).__shell
        return s.fetch(loc)
      }, locator),
    seedHas: (hashHex: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { seedHas: (x: string) => boolean } }).__shell
        return s.seedHas(h) as never
      }, hashHex),
    feed: () =>
      app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { feed: () => Record<string, unknown>[] } }).__shell
        return s.feed() as never
      }),
    openThing: (envelopeHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { open: (x: string) => Promise<Record<string, unknown>> } }).__shell
        return s.open(h)
      }, envelopeHash),
    knownTypes: () =>
      app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { knownTypes: () => unknown[] } }).__shell
        return s.knownTypes() as never
      }),
    drafts: () =>
      app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { drafts: () => unknown[] } }).__shell
        return s.drafts() as never
      }),
    newDraft: (key: string, args?: unknown) =>
      app.evaluate(
        async (electron, a) => {
          const s = (electron.app as unknown as { __shell: { newDraft: (k: string, g?: unknown) => unknown } }).__shell
          return s.newDraft(a.key, a.args) as never
        },
        { key, args }
      ),
    newAttestation: (targetHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (
          electron.app as unknown as { __shell: { newAttestation: (h: string) => Record<string, unknown> } }
        ).__shell
        return s.newAttestation(h)
      }, targetHash),
    attestations: (targetHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (
          electron.app as unknown as { __shell: { attestations: (h: string) => { count: number; rows: unknown[] } } }
        ).__shell
        return s.attestations(h) as never
      }, targetHash),
    newComment: (targetHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { newComment: (x: string) => unknown } }).__shell
        return s.newComment(h) as never
      }, targetHash),
    draftBlobs: (draftId: string) =>
      app.evaluate(async (electron, id) => {
        const s = (electron.app as unknown as { __shell: { draftBlobs: (x: string) => unknown } }).__shell
        return s.draftBlobs(id) as never
      }, draftId),
    replies: (targetHash: string) =>
      app.evaluate(async (electron, h) => {
        const s = (electron.app as unknown as { __shell: { replies: (x: string) => unknown } }).__shell
        return s.replies(h) as never
      }, targetHash),
    deleteDraft: (id: string) =>
      app.evaluate(async (electron, i) => {
        const s = (electron.app as unknown as { __shell: { deleteDraft: (x: string) => unknown } }).__shell
        return s.deleteDraft(i) as never
      }, id),
    scanUserData(needle: Uint8Array) {
      return scanTree(userDataDir, needle)
    },
    casBlobs() {
      try {
        return readdirSync(join(userDataDir, 'library', 'blobs'))
      } catch {
        return []
      }
    },
    close: async () => {
      await app.close()
      if (ownsDir) rmSync(userDataDir, { recursive: true, force: true })
    }
  }
}

function scanTree(dir: string, needle: Uint8Array, depth = 0, hits: string[] = []): string[] {
  if (depth > 8) return hits
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return hits
  }
  for (const name of entries) {
    const p = join(dir, name)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) scanTree(p, needle, depth + 1, hits)
    else if (s.isFile() && s.size < 16 * 1024 * 1024) {
      try {
        if (indexOfBytes(readFileSync(p), needle) !== -1) hits.push(p)
      } catch {
        /* skip */
      }
    }
  }
  return hits
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return -1
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

export const test = base
export { expect } from '@playwright/test'
