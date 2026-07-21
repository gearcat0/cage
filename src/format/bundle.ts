import { decodeManifest, type Manifest } from './manifest.js'
import { verifyEnvelope, type VerifyResult } from './verify.js'
import { decodeEnvelope, type Envelope } from './envelope.js'
import { isSealed, unsealFull, unsealMember, type Unsealer } from './sealed.js'
import { hash, toHex, type Hash } from './hash.js'
import { bytesEqual } from './cbor.js'
import { DEFAULT_LIMITS, type DecodeLimits } from './limits.js'

// ── Bundle + admission — format spec §8 ──────────────────────────────────────
//
// A bundle is an uncompressed tar:
//   envelope.cbor    Envelope, or Sealed
//   manifest.cbor    canonical CBOR (absent if sealed — inside ct)
//   program          the program blob (raw bytes)
//   blobs/<hex-hash> one file per attachment, named by sha256
//
// This module parses the tar (with hard caps — the structural half the shell
// runs in an isolated utilityProcess) and runs the §8.1 admission algorithm.

export interface BundleLimits extends DecodeLimits {
  /** Cap on the raw tar size (bytes). */
  maxBundleBytes: number
  /** Cap on a single tar entry's size (bytes). */
  maxEntryBytes: number
  /** Cap on total extracted bytes across all entries (tar-bomb guard). */
  maxTotalBytes: number
  /** Cap on the number of tar entries. */
  maxEntries: number
}

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  ...DEFAULT_LIMITS,
  maxBundleBytes: 256 * 1024 * 1024, // 256 MiB raw
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntries: 1024
}

export class BundleError extends Error {
  override name = 'BundleError'
}

export interface BundleSource {
  envelope: Uint8Array
  /** Public bundle: manifest.cbor plaintext. */
  manifest?: Uint8Array
  /** Public bundle: program plaintext. */
  program?: Uint8Array
  /** Sealed bundle: manifest.enc (nonce||ct, §7.1). */
  manifestEnc?: Uint8Array
  /** Sealed bundle: program.enc. */
  programEnc?: Uint8Array
  /** hex-sha256(plaintext) -> blob bytes. Plaintext for public bundles;
   *  ciphertext (nonce||ct) for sealed bundles. */
  blobs: Map<string, Uint8Array>
}

// ── Tar parsing (uncompressed, ustar) ────────────────────────────────────────

function readOctal(bytes: Uint8Array): number {
  // Trailing NUL/space terminated octal.
  let s = ''
  for (const b of bytes) {
    if (b === 0 || b === 0x20) break
    s += String.fromCharCode(b)
  }
  return s.length ? parseInt(s, 8) : 0
}

function cstr(bytes: Uint8Array): string {
  let end = bytes.indexOf(0)
  if (end === -1) end = bytes.length
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end))
}

/** Parse an uncompressed tar into name -> bytes, enforcing entry/total/count
 *  caps so a small archive that expands hugely (tar-bomb) is refused. */
export function parseTar(bytes: Uint8Array, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): Map<string, Uint8Array> {
  if (bytes.length > limits.maxBundleBytes) throw new BundleError('bundle exceeds max size')
  const out = new Map<string, Uint8Array>()
  let offset = 0
  let total = 0
  let count = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    // Two consecutive zero blocks mark the end.
    if (header.every((b) => b === 0)) break
    const name = cstr(header.subarray(0, 100))
    const size = readOctal(header.subarray(124, 136))
    const typeflag = header[156]
    offset += 512
    if (size < 0) throw new BundleError('negative tar entry size')
    if (size > limits.maxEntryBytes) throw new BundleError(`tar entry "${name}" exceeds per-entry cap`)
    total += size
    if (total > limits.maxTotalBytes) throw new BundleError('tar exceeds total-size cap (tar-bomb?)')
    const data = bytes.subarray(offset, offset + size)
    if (data.length !== size) throw new BundleError('truncated tar entry')
    offset += Math.ceil(size / 512) * 512
    // typeflag '0'/'\0' = regular file; skip directories and others.
    if (typeflag === 0x30 || typeflag === 0 || typeflag === undefined) {
      count++
      if (count > limits.maxEntries) throw new BundleError('too many tar entries')
      out.set(name.replace(/^\.\//, ''), Uint8Array.from(data))
    }
  }
  return out
}

/** Split a parsed tar into the named bundle parts. */
export function parseBundle(tarBytes: Uint8Array, limits: BundleLimits = DEFAULT_BUNDLE_LIMITS): BundleSource {
  const entries = parseTar(tarBytes, limits)
  const envelope = entries.get('envelope.cbor')
  if (!envelope) throw new BundleError('bundle missing envelope.cbor')
  const blobs = new Map<string, Uint8Array>()
  for (const [name, data] of entries) {
    const m = /^blobs\/([0-9a-f]{64})$/.exec(name)
    if (m) blobs.set(m[1]!, data)
  }
  const source: BundleSource = { envelope, blobs }
  const manifest = entries.get('manifest.cbor')
  if (manifest) source.manifest = manifest
  const program = entries.get('program')
  if (program) source.program = program
  const manifestEnc = entries.get('manifest.enc')
  if (manifestEnc) source.manifestEnc = manifestEnc
  const programEnc = entries.get('program.enc')
  if (programEnc) source.programEnc = programEnc
  return source
}

// ── Admission (§8.1) ─────────────────────────────────────────────────────────

export type AdmissionResult =
  | {
      status: 'valid'
      envelope: Envelope
      envelopeHash: Hash
      manifest: Manifest
      manifestBytes: Uint8Array
      program: Uint8Array
      /** name -> plaintext blob bytes, verified against the manifest hashes. */
      attachments: Map<string, Uint8Array>
      /** true if the admitted envelope came from inside a Sealed wrapper. */
      sealed: boolean
    }
  | { status: 'invalid'; reason: string }
  | { status: 'unverifiable'; scheme: string }
  | { status: 'not-for-me' }

export interface AdmitOptions {
  limits?: BundleLimits
  /** Injected Unsealer used when the envelope is Sealed. `format` never receives
   *  the raw key — the keyring implements this. */
  unsealer?: Unsealer
}

/**
 * Run §8.1 in order, fail-closed, and return one of four distinct outcomes.
 * Any hash or signature failure rejects the WHOLE bundle — there is no partial
 * admission. Hashes are computed over the bytes AS RECEIVED, never re-encoded.
 */
export function admitBundle(source: BundleSource, opts: AdmitOptions = {}): AdmissionResult {
  const limits = opts.limits ?? DEFAULT_BUNDLE_LIMITS

  // Step 1-2: decode envelope; if Sealed, trial-decrypt to the inner envelope
  // and recover the content key CK for the sealed members (§7.1).
  let envelopeBytes = source.envelope
  let sealed = false
  let ck: Uint8Array | null = null
  if (isSealed(envelopeBytes, limits)) {
    sealed = true
    if (!opts.unsealer) return { status: 'not-for-me' }
    let inner: ReturnType<typeof unsealFull>
    try {
      inner = unsealFull(envelopeBytes, opts.unsealer, limits)
    } catch (e) {
      return { status: 'invalid', reason: `sealed: ${(e as Error).message}` }
    }
    if (inner === 'not-for-me') return { status: 'not-for-me' }
    envelopeBytes = inner.envelope
    ck = inner.ck
  }

  // Step 3-4: scheme lookup + signature over the received bytes.
  const verified: VerifyResult = verifyEnvelope(envelopeBytes, limits)
  if (verified.status === 'unverifiable') return { status: 'unverifiable', scheme: verified.scheme }
  if (verified.status === 'invalid') return { status: 'invalid', reason: verified.reason }
  const envelope = verified.envelope
  const envelopeHash = hash(envelopeBytes)

  // Resolve the manifest, program, and attachment bytes to their PLAINTEXT —
  // directly for a public bundle, or by decrypting the sealed members under CK
  // (§7.1) for a sealed one. Steps 5-8 then run identically on plaintext.
  let manifestBytes: Uint8Array
  let programBytes: Uint8Array
  const attBytes = (hex: string): Uint8Array | undefined => {
    const member = source.blobs.get(hex)
    if (!member) return undefined
    return sealed ? unsealMember(member, ck!) : member
  }
  try {
    if (sealed) {
      if (!source.manifestEnc) return { status: 'invalid', reason: 'sealed bundle missing manifest.enc' }
      if (!source.programEnc) return { status: 'invalid', reason: 'sealed bundle missing program.enc' }
      manifestBytes = unsealMember(source.manifestEnc, ck!)
      programBytes = unsealMember(source.programEnc, ck!)
    } else {
      if (!source.manifest) return { status: 'invalid', reason: 'bundle missing manifest.cbor' }
      if (!source.program) return { status: 'invalid', reason: 'bundle missing program' }
      manifestBytes = source.manifest
      programBytes = source.program
    }
  } catch (e) {
    // A member that fails to decrypt is tampering — reject the whole bundle.
    return { status: 'invalid', reason: `sealed member decrypt: ${(e as Error).message}` }
  }

  // Step 5: sha256(manifest plaintext) MUST equal envelope.man.
  if (!bytesEqual(hash(manifestBytes), envelope.man)) {
    return { status: 'invalid', reason: 'manifest hash does not match envelope.man' }
  }

  // Step 6: decode the manifest.
  let manifest: Manifest
  try {
    manifest = decodeManifest(manifestBytes, limits)
  } catch (e) {
    return { status: 'invalid', reason: `manifest decode: ${(e as Error).message}` }
  }

  // Step 7: sha256(program plaintext) MUST equal manifest.prog.
  if (!bytesEqual(hash(programBytes), manifest.prog)) {
    return { status: 'invalid', reason: 'program hash does not match manifest.prog' }
  }

  // Step 8: every attachment present and its PLAINTEXT sha256 equals h. Missing
  // or mismatched fails the WHOLE bundle — no partial admission.
  const attachments = new Map<string, Uint8Array>()
  for (const [name, att] of manifest.att) {
    const hex = toHex(att.h)
    let blob: Uint8Array | undefined
    try {
      blob = attBytes(hex)
    } catch (e) {
      return { status: 'invalid', reason: `attachment "${name}" decrypt: ${(e as Error).message}` }
    }
    if (!blob) return { status: 'invalid', reason: `attachment "${name}" missing from bundle` }
    if (!bytesEqual(hash(blob), att.h)) {
      return { status: 'invalid', reason: `attachment "${name}" hash mismatch` }
    }
    attachments.set(name, blob)
  }

  // Step 9 (chain/fork) is done by the shell against its own index — this
  // function returns envelope.path/seq/prev for that check.
  return {
    status: 'valid',
    envelope,
    envelopeHash,
    manifest,
    manifestBytes,
    program: programBytes,
    attachments,
    sealed
  }
}

/** Decode a top-level envelope's chain fields for the shell's fork check. */
export function chainInfo(envelope: Envelope): { path?: string; seq?: number; prev?: Hash } {
  const info: { path?: string; seq?: number; prev?: Hash } = {}
  if (envelope.path !== undefined) info.path = envelope.path
  if (envelope.seq !== undefined) info.seq = envelope.seq
  if (envelope.prev !== undefined) info.prev = envelope.prev
  return info
}

export { decodeEnvelope }
