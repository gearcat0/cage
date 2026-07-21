import { decodeCanonical, encode, type CborMap, type CborValue, type CborKey } from './cbor.js'
import { DEFAULT_LIMITS, type DecodeLimits } from './limits.js'
import { asHash, hash, type Hash } from './hash.js'

// ── Envelope — format spec §5 ────────────────────────────────────────────────
//
// Envelope = {
//   1: uint v(=1), 2: Author, 3: bytes(32) man, 4: uint created,
//   5: tstr path?, 6: uint seq?, 7: bytes(32) prev?, 8: Sig
// }
// Author = { 1: tstr s, 2: bytes k, 3: tstr e?, 4: bytes ek? }
// Sig = { 1: bytes }

export const ENVELOPE_DOMAIN = 'thing-envelope-v1:'

export interface Author {
  /** signing scheme id (§6). */
  s: string
  /** signing public key / identifier, scheme-defined. */
  k: Uint8Array
  /** OPTIONAL encryption scheme id. */
  e?: string
  /** OPTIONAL encryption public key (requires e). */
  ek?: Uint8Array
}

export interface Envelope {
  v: 1
  author: Author
  /** sha256 of the manifest's canonical bytes. */
  man: Hash
  /** unix seconds, author CLAIM (§1 rule 4) — not a fact. */
  created: number
  path?: string
  seq?: number
  prev?: Hash
  /** raw signature bytes, scheme-defined. */
  sig: Uint8Array
}

export class EnvelopeError extends Error {
  override name = 'EnvelopeError'
}

function reqMap(v: CborValue | undefined, ctx: string): CborMap {
  if (!(v instanceof Map)) throw new EnvelopeError(`${ctx}: expected a map`)
  return v
}
function reqBytes(v: CborValue | undefined, ctx: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new EnvelopeError(`${ctx}: expected a byte string`)
  return v
}
function reqString(v: CborValue | undefined, ctx: string): string {
  if (typeof v !== 'string') throw new EnvelopeError(`${ctx}: expected a text string`)
  return v
}
function reqUint(v: CborValue | undefined, ctx: string): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v
  if (typeof v === 'bigint' && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v)
  throw new EnvelopeError(`${ctx}: expected a non-negative integer`)
}
function hashOr(bytes: Uint8Array, ctx: string): Hash {
  try {
    return asHash(bytes)
  } catch (e) {
    throw new EnvelopeError(`${ctx}: ${(e as Error).message}`)
  }
}

function decodeAuthor(v: CborValue | undefined): Author {
  const m = reqMap(v, 'author')
  const author: Author = {
    s: reqString(m.get(1), 'author.s'),
    k: reqBytes(m.get(2), 'author.k')
  }
  const e = m.get(3)
  const ek = m.get(4)
  if (e !== undefined) {
    author.e = reqString(e, 'author.e')
    author.ek = reqBytes(ek, 'author.ek')
  } else if (ek !== undefined) {
    throw new EnvelopeError('author.ek requires author.e')
  }
  for (const key of m.keys()) {
    if (typeof key !== 'number' || key < 1 || key > 4) {
      throw new EnvelopeError(`unknown author key: ${String(key)}`)
    }
  }
  return author
}

export interface DecodedEnvelope {
  envelope: Envelope
  /** The `signing_input` bytes the signature covers (§5.1), domain-separated.
   *  Verify the sig over THIS. */
  signingInput: Uint8Array
}

/**
 * Decode an envelope from canonical CBOR and compute its `signing_input`.
 * Because decoding requires canonical form, re-encoding the envelope minus the
 * signature reproduces exactly the bytes the signer signed — so the signing
 * input is derived deterministically from the received (canonical) bytes.
 */
export function decodeEnvelope(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): DecodedEnvelope {
  const top = reqMap(decodeCanonical(bytes, limits), 'envelope')

  const v = reqUint(top.get(1), 'envelope.v')
  if (v !== 1) throw new EnvelopeError(`envelope.v must be 1, got ${v}`)

  const author = decodeAuthor(top.get(2))
  const man = hashOr(reqBytes(top.get(3), 'envelope.man'), 'envelope.man')
  const created = reqUint(top.get(4), 'envelope.created')

  const envelope: Envelope = {
    v: 1,
    author,
    man,
    created,
    sig: reqBytes(reqMap(top.get(8), 'envelope.sig').get(1), 'sig.bytes')
  }

  // Chaining (§5.3): seq and prev MUST NOT appear without path.
  const path = top.get(5)
  const seq = top.get(6)
  const prev = top.get(7)
  if (path !== undefined) envelope.path = reqString(path, 'envelope.path')
  if (seq !== undefined) {
    if (path === undefined) throw new EnvelopeError('envelope.seq requires path')
    envelope.seq = reqUint(seq, 'envelope.seq')
  }
  if (prev !== undefined) {
    if (path === undefined) throw new EnvelopeError('envelope.prev requires path')
    envelope.prev = hashOr(reqBytes(prev, 'envelope.prev'), 'envelope.prev')
  }

  for (const key of top.keys()) {
    if (typeof key !== 'number' || key < 1 || key > 8) {
      throw new EnvelopeError(`unknown envelope key: ${String(key)}`)
    }
  }

  // sig_payload = canonical_cbor(Envelope without key 8). The received envelope
  // is canonical (decodeCanonical), so rebuilding it without the signature and
  // re-encoding yields the exact payload the signer produced.
  const withoutSig: CborMap = new Map()
  for (const [k, val] of top) if (k !== 8) withoutSig.set(k, val)
  const sigPayload = encode(withoutSig)
  const sigDigest = hash(sigPayload)
  const signingInput = new TextEncoder().encode(ENVELOPE_DOMAIN + base64urlNoPad(sigDigest))

  return { envelope, signingInput }
}

/** base64url without padding (RFC 4648 §5), for the signing input (§5.1). */
export function base64urlNoPad(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** signing_input from the sig_payload (canonical envelope minus sig). */
export function signingInputFor(sigPayload: Uint8Array): Uint8Array {
  return new TextEncoder().encode(ENVELOPE_DOMAIN + base64urlNoPad(hash(sigPayload)))
}

// ── Signing (§9) ─────────────────────────────────────────────────────────────
// The keyring implements Signer over a keyring/hardware wallet; `format` never
// holds key material. It calls signer.sign(signing_input) and gets a signature.

export interface Signer {
  scheme: string
  pubkey: Uint8Array
  sign(signingInput: Uint8Array): Promise<Uint8Array>
}

export interface UnsignedEnvelope {
  man: Hash
  created: number
  path?: string
  seq?: number
  prev?: Hash
  /** Optional encryption key binding (Author.e / Author.ek). */
  enc?: { e: string; ek: Uint8Array }
}

function envelopeMapWithoutSig(u: UnsignedEnvelope, signer: Signer): CborMap {
  const author: CborMap = new Map<CborKey, CborValue>([
    [1, signer.scheme],
    [2, signer.pubkey]
  ])
  if (u.enc) {
    author.set(3, u.enc.e)
    author.set(4, u.enc.ek)
  }
  const map: CborMap = new Map<CborKey, CborValue>()
  map.set(1, 1)
  map.set(2, author)
  map.set(3, u.man)
  map.set(4, u.created)
  if (u.path !== undefined) map.set(5, u.path)
  if (u.seq !== undefined) map.set(6, u.seq)
  if (u.prev !== undefined) map.set(7, u.prev)
  return map
}

/** Canonically encode and sign an envelope. The signature covers
 *  signing_input over the canonical envelope-minus-sig (§5.1). */
export async function encodeEnvelope(u: UnsignedEnvelope, signer: Signer): Promise<Uint8Array> {
  if (u.seq !== undefined && u.path === undefined) throw new EnvelopeError('seq requires path')
  if (u.prev !== undefined && u.path === undefined) throw new EnvelopeError('prev requires path')
  const map = envelopeMapWithoutSig(u, signer)
  const sigPayload = encode(map)
  const signingInput = signingInputFor(sigPayload)
  const sig = await signer.sign(signingInput)
  map.set(8, new Map<CborKey, CborValue>([[1, sig]]))
  return encode(map)
}
