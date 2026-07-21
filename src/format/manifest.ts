import { decodeCanonical, encode, type CborMap, type CborValue, type CborKey } from './cbor.js'
import { DEFAULT_LIMITS, type DecodeLimits } from './limits.js'
import { asHash, type Hash } from './hash.js'

// ── Manifest — format spec §4 ────────────────────────────────────────────────
//
// Manifest = {
//   1: uint,          # v    — MUST be 1
//   2: bytes(32),     # prog — sha256 of the program blob
//   3: tstr,          # type — display hint, MUST NOT be trusted
//   4: any,           # args — program-defined, opaque
//   5: { tstr => Att } # att — attachment table, MAY be absent if empty
// }
// Att = { 1: bytes(32) h, 2: tstr m, 3: uint n }

export interface Attachment {
  /** sha256 of the attachment blob (plaintext bytes for sealed things). */
  h: Hash
  /** MIME type — a convenience, not authoritative (serve with nosniff). */
  m: string
  /** size in bytes — a convenience. */
  n: number
}

export interface Manifest {
  v: 1
  prog: Hash
  /** Display hint only. §4: MUST NOT be trusted. */
  type: string
  /** Program-defined; opaque to this package. */
  args: CborValue
  /** name -> attachment. Empty map if the manifest had no `att` key. */
  att: Map<string, Attachment>
}

export class ManifestError extends Error {
  override name = 'ManifestError'
}

function reqMap(v: CborValue, ctx: string): CborMap {
  if (!(v instanceof Map)) throw new ManifestError(`${ctx}: expected a map`)
  return v
}

function reqBytes(v: CborValue | undefined, ctx: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new ManifestError(`${ctx}: expected a byte string`)
  return v
}

function reqString(v: CborValue | undefined, ctx: string): string {
  if (typeof v !== 'string') throw new ManifestError(`${ctx}: expected a text string`)
  return v
}

function reqUint(v: CborValue | undefined, ctx: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'bigint' && v >= 0n) {
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ManifestError(`${ctx}: uint too large`)
    return Number(v)
  }
  throw new ManifestError(`${ctx}: expected a non-negative integer`)
}

/**
 * Decode a manifest from its canonical CBOR bytes. Strict: rejects
 * non-canonical input, wrong version, malformed fields, and over-limit
 * attachment counts. `args` is returned opaque.
 */
export function decodeManifest(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): Manifest {
  const top = reqMap(decodeCanonical(bytes, limits), 'manifest')

  const v = reqUint(top.get(1), 'manifest.v')
  if (v !== 1) throw new ManifestError(`manifest.v must be 1, got ${v}`)

  const prog = asHashOr(reqBytes(top.get(2), 'manifest.prog'), 'manifest.prog')
  const type = reqString(top.get(3), 'manifest.type')
  if (!top.has(4)) throw new ManifestError('manifest.args is required')
  const args = top.get(4) as CborValue

  const att = new Map<string, Attachment>()
  const rawAtt = top.get(5)
  if (rawAtt !== undefined) {
    const attMap = reqMap(rawAtt, 'manifest.att')
    if (attMap.size > limits.maxAttachments) {
      throw new ManifestError(`too many attachments (${attMap.size})`)
    }
    for (const [name, entry] of attMap) {
      if (typeof name !== 'string') throw new ManifestError('manifest.att key must be a text string')
      const e = reqMap(entry, `manifest.att[${name}]`)
      att.set(name, {
        h: asHashOr(reqBytes(e.get(1), `att[${name}].h`), `att[${name}].h`),
        m: reqString(e.get(2), `att[${name}].m`),
        n: reqUint(e.get(3), `att[${name}].n`)
      })
    }
  }

  // Reject unknown top-level keys: a manifest carrying extra keys is not one we
  // understand, and silently ignoring them invites confusion attacks.
  for (const key of top.keys()) {
    if (typeof key !== 'number' || key < 1 || key > 5) {
      throw new ManifestError(`unknown manifest key: ${String(key)}`)
    }
  }

  return { v: 1, prog, type, args, att }
}

function asHashOr(bytes: Uint8Array, ctx: string): Hash {
  try {
    return asHash(bytes)
  } catch (e) {
    throw new ManifestError(`${ctx}: ${(e as Error).message}`)
  }
}

/** Re-encode a manifest to canonical CBOR (for building/signing, not for
 *  hashing received bundles — those hash the bytes as received). */
export function encodeManifest(m: Manifest): Uint8Array {
  const map: CborMap = new Map<CborKey, CborValue>()
  map.set(1, m.v)
  map.set(2, m.prog)
  map.set(3, m.type)
  map.set(4, m.args)
  if (m.att.size > 0) {
    const attMap: CborMap = new Map<CborKey, CborValue>()
    for (const [name, a] of m.att) {
      attMap.set(name, new Map<CborKey, CborValue>([[1, a.h], [2, a.m], [3, a.n]]))
    }
    map.set(5, attMap)
  }
  return encode(map)
}
