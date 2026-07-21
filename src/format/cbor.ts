import { DEFAULT_LIMITS, type DecodeLimits } from './limits.js'

// ── Canonical CBOR — format spec §2.2 ────────────────────────────────────────
//
// "Canonical" here is RFC 8949 §4.2.1 core deterministic encoding PLUS the
// format's extra restrictions: no floats, no tags, no `undefined`, definite
// lengths only, shortest-form integers, map keys sorted by the BYTEWISE
// lexicographic order of their ENCODED form (the RFC 8949 rule, not RFC 7049's
// length-first rule), no duplicate keys, and NFC-normalized text.
//
// Strategy (see the shell brief §1.3): the decoder does the structural rejects
// that a re-encode cannot see — indefinite lengths, tags, floats, `undefined`,
// duplicate map keys, limit violations, trailing bytes. Canonicity of the
// *shape* (shortest ints, key ordering, NFC) is then enforced by re-encoding
// the decoded value and requiring it to byte-equal the input. Non-canonical
// input is REJECTED, never normalized — a decoder that silently normalized
// would hash differently from the sender and turn an encoder bug into a
// signature forgery.

export class CborError extends Error {
  override name = 'CborError'
}

/** A decoded CBOR value. Integers within the safe range decode to `number`,
 *  larger ones to `bigint`. Maps preserve key types. */
export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | CborMap
export type CborKey = number | bigint | string | Uint8Array
export type CborMap = Map<CborKey, CborValue>

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

// ── Encoder ──────────────────────────────────────────────────────────────────

class Writer {
  private chunks: number[] = []
  push(...b: number[]): void {
    for (const x of b) this.chunks.push(x)
  }
  pushBytes(b: Uint8Array): void {
    for (const x of b) this.chunks.push(x)
  }
  result(): Uint8Array {
    return Uint8Array.from(this.chunks)
  }
}

/** Write a major type (0-7, high 3 bits) with its argument in shortest form. */
function writeHead(w: Writer, major: number, arg: number | bigint): void {
  const mt = major << 5
  const n = typeof arg === 'bigint' ? arg : BigInt(arg)
  if (n < 0n) throw new CborError('internal: negative head argument')
  if (n < 24n) {
    w.push(mt | Number(n))
  } else if (n < 0x100n) {
    w.push(mt | 24, Number(n))
  } else if (n < 0x10000n) {
    w.push(mt | 25, Number(n >> 8n) & 0xff, Number(n) & 0xff)
  } else if (n < 0x100000000n) {
    w.push(mt | 26, Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn))
  } else if (n < 0x10000000000000000n) {
    const bytes: number[] = []
    let v = n
    for (let i = 0; i < 8; i++) {
      bytes.unshift(Number(v & 0xffn))
      v >>= 8n
    }
    w.push(mt | 27, ...bytes)
  } else {
    throw new CborError('integer out of 64-bit range')
  }
}

function encodeInto(w: Writer, value: CborValue): void {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new CborError('floats are forbidden')
    if (Object.is(value, -0)) throw new CborError('negative zero is forbidden')
    if (value >= 0) writeHead(w, 0, value)
    else writeHead(w, 1, -1 - value)
    return
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) writeHead(w, 0, value)
    else writeHead(w, 1, -1n - value)
    return
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value.normalize('NFC'))
    writeHead(w, 3, bytes.length)
    w.pushBytes(bytes)
    return
  }
  if (value instanceof Uint8Array) {
    writeHead(w, 2, value.length)
    w.pushBytes(value)
    return
  }
  if (typeof value === 'boolean') {
    w.push(0xe0 | (value ? 21 : 20))
    return
  }
  if (value === null) {
    w.push(0xf6)
    return
  }
  if (Array.isArray(value)) {
    writeHead(w, 4, value.length)
    for (const item of value) encodeInto(w, item)
    return
  }
  if (value instanceof Map) {
    // Canonical map: encode each key, sort pairs by encoded-key bytes
    // (bytewise lexicographic), then emit.
    const entries: { k: Uint8Array; v: CborValue }[] = []
    for (const [k, v] of value) {
      const kw = new Writer()
      encodeInto(kw, k)
      entries.push({ k: kw.result(), v })
    }
    entries.sort((a, b) => compareBytes(a.k, b.k))
    for (let i = 1; i < entries.length; i++) {
      if (compareBytes(entries[i - 1]!.k, entries[i]!.k) === 0) {
        throw new CborError('duplicate map key')
      }
    }
    writeHead(w, 5, entries.length)
    for (const e of entries) {
      w.pushBytes(e.k)
      encodeInto(w, e.v)
    }
    return
  }
  throw new CborError(`cannot encode value of type ${typeof value}`)
}

/** Canonically encode a value. Throws on floats, unsupported types, or
 *  duplicate map keys. */
export function encode(value: CborValue): Uint8Array {
  const w = new Writer()
  encodeInto(w, value)
  return w.result()
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!
  }
  return a.length - b.length
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
}

// ── Decoder (structural, strict) ─────────────────────────────────────────────

class Reader {
  constructor(
    readonly buf: Uint8Array,
    readonly limits: DecodeLimits
  ) {}
  pos = 0
  byte(): number {
    if (this.pos >= this.buf.length) throw new CborError('unexpected end of input')
    return this.buf[this.pos++]!
  }
  take(n: number): Uint8Array {
    if (n < 0) throw new CborError('negative length')
    if (this.pos + n > this.buf.length) throw new CborError('unexpected end of input')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

/** Read the argument for a head byte's additional-info field. Rejects
 *  indefinite length (31) and reserved (28-30). Returns a bigint. */
function readArg(r: Reader, ai: number): bigint {
  if (ai < 24) return BigInt(ai)
  if (ai === 24) return BigInt(r.byte())
  if (ai === 25) {
    const b = r.take(2)
    return (BigInt(b[0]!) << 8n) | BigInt(b[1]!)
  }
  if (ai === 26) {
    const b = r.take(4)
    let v = 0n
    for (const x of b) v = (v << 8n) | BigInt(x)
    return v
  }
  if (ai === 27) {
    const b = r.take(8)
    let v = 0n
    for (const x of b) v = (v << 8n) | BigInt(x)
    return v
  }
  if (ai === 31) throw new CborError('indefinite-length items are forbidden')
  throw new CborError(`reserved additional-info value ${ai}`)
}

function toNumberOrBigInt(n: bigint): number | bigint {
  return n <= MAX_SAFE ? Number(n) : n
}

function decodeItem(r: Reader, depth: number): CborValue {
  if (depth > r.limits.maxDepth) throw new CborError('max nesting depth exceeded')
  const head = r.byte()
  const major = head >> 5
  const ai = head & 0x1f

  switch (major) {
    case 0: // unsigned int
      return toNumberOrBigInt(readArg(r, ai))
    case 1: // negative int: -1 - n
      return negFrom(readArg(r, ai))
    case 2: {
      // byte string
      const len = readArg(r, ai)
      checkStrLen(len, r.limits)
      return Uint8Array.from(r.take(Number(len)))
    }
    case 3: {
      // text string
      const len = readArg(r, ai)
      checkStrLen(len, r.limits)
      const bytes = r.take(Number(len))
      return decodeUtf8Strict(bytes)
    }
    case 4: {
      // array
      const len = readArg(r, ai)
      if (len > BigInt(r.limits.maxEntries)) throw new CborError('array too large')
      const n = Number(len)
      const arr: CborValue[] = []
      for (let i = 0; i < n; i++) arr.push(decodeItem(r, depth + 1))
      return arr
    }
    case 5: {
      // map
      const len = readArg(r, ai)
      if (len > BigInt(r.limits.maxEntries)) throw new CborError('map too large')
      const n = Number(len)
      const map: CborMap = new Map()
      const seen: Uint8Array[] = []
      for (let i = 0; i < n; i++) {
        const kStart = r.pos
        const key = decodeItem(r, depth + 1) as CborKey
        const kBytes = r.buf.subarray(kStart, r.pos)
        for (const prev of seen) {
          if (bytesEqual(prev, kBytes)) throw new CborError('duplicate map key')
        }
        seen.push(Uint8Array.from(kBytes))
        const val = decodeItem(r, depth + 1)
        map.set(key, val)
      }
      return map
    }
    case 6:
      throw new CborError('CBOR tags are forbidden')
    case 7: {
      if (ai === 20) return false
      if (ai === 21) return true
      if (ai === 22) return null
      if (ai === 23) throw new CborError('`undefined` is forbidden')
      if (ai === 25 || ai === 26 || ai === 27) throw new CborError('floating point is forbidden')
      throw new CborError(`unsupported simple/float value (ai ${ai})`)
    }
    default:
      throw new CborError(`unknown major type ${major}`)
  }
}

function negFrom(n: bigint): number | bigint {
  const v = -1n - n
  return v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v
}

function checkStrLen(len: bigint, limits: DecodeLimits): void {
  if (len > BigInt(limits.maxStringBytes)) throw new CborError('string exceeds max length')
}

/** Strict UTF-8 decode: rejects malformed sequences (the default TextDecoder
 *  with fatal:true throws on invalid UTF-8, which we want). */
function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new CborError('invalid UTF-8 in text string')
  }
}

/**
 * Structurally decode CBOR under the limits, rejecting indefinite lengths,
 * tags, floats, `undefined`, duplicate keys, and trailing bytes. This does NOT
 * check canonical shape (ordering / shortest / NFC) — use `decodeCanonical`.
 */
export function decode(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): CborValue {
  const r = new Reader(bytes, limits)
  const value = decodeItem(r, 1)
  if (r.pos !== bytes.length) throw new CborError('trailing bytes after top-level item')
  return value
}

/**
 * Decode AND require canonical form: decode structurally, then re-encode the
 * decoded value and require it to byte-equal the input. Any difference —
 * non-shortest integer, unsorted map keys, non-NFC text — is a rejection.
 * This is the function the format uses for manifests and envelopes.
 */
export function decodeCanonical(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): CborValue {
  const value = decode(bytes, limits)
  const reencoded = encode(value)
  if (!bytesEqual(reencoded, bytes)) {
    throw new CborError('non-canonical CBOR (rejected, not normalized)')
  }
  return value
}
