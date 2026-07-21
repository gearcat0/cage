import { test as base, _electron, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  encodeManifest,
  encodeEnvelope,
  hash,
  seal,
  parseBundle,
  type BundleSource,
  type Manifest,
  type Signer
} from '@yourproject/format'

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

/** Build a sealed bundle to recipient x-only pubkeys. */
export async function buildSealedBundle(signer: Signer, recipients: Uint8Array[]): Promise<Uint8Array> {
  const program = new Uint8Array([1, 2, 3])
  const manifest: Manifest = { v: 1, prog: hash(program), type: 'invite', args: null, att: new Map() }
  const inner = await encodeEnvelope({ man: hash(encodeManifest(manifest)), created: 5 }, signer)
  const sealed = seal(inner, recipients)
  return buildTar({ 'envelope.cbor': sealed })
}

/** Re-tar a BundleSource (for precise tampering: parse → corrupt a part → tar). */
export function tarFromSource(src: BundleSource): Uint8Array {
  const files: Record<string, Uint8Array> = { 'envelope.cbor': src.envelope }
  if (src.manifest) files['manifest.cbor'] = src.manifest
  if (src.program) files['program'] = src.program
  for (const [hex, bytes] of src.blobs) files[`blobs/${hex}`] = bytes
  return buildTar(files)
}

export { seal, secp256k1, schnorr, hash, parseBundle }

// ── Shell launcher ───────────────────────────────────────────────────────────

export interface ShellHandle {
  app: ElectronApplication
  userDataDir: string
  identity(): Promise<{ address: string; nostrPubkey: string }>
  admit(bytes: Uint8Array): Promise<Record<string, unknown>>
  /** Files under userData whose bytes contain `needle`. */
  scanUserData(needle: Uint8Array): string[]
  close(): Promise<void>
}

export interface ShellLaunchOptions {
  extraEnv?: Record<string, string>
}

async function waitReady(app: ElectronApplication, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await app.evaluate(async (electron) => {
      const s = (electron.app as unknown as { __shell?: { ready?: boolean } }).__shell
      return Boolean(s?.ready)
    })
    if (ready) return
    if (Date.now() > deadline) throw new Error('shell did not become ready')
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function launchShell(opts: ShellLaunchOptions = {}): Promise<ShellHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'shell-userdata-'))
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  delete env.ELECTRON_DISABLE_SANDBOX
  env.SHELL_PASSWORD_STORE_BASIC = '1'
  // Headless CI has no OS keyring backend, so use the gated insecure at-rest
  // fallback (still never writes the plaintext key). Production requires
  // safeStorage.
  env.SHELL_KEYRING_INSECURE_FALLBACK = '1'
  env.SHELL_USER_DATA_DIR = userDataDir
  Object.assign(env, opts.extraEnv ?? {})

  const app = await _electron.launch({ args: [SHELL_MAIN], env })
  await waitReady(app)

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
    scanUserData(needle: Uint8Array) {
      return scanTree(userDataDir, needle)
    },
    close: async () => {
      await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
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
