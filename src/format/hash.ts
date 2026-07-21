import { sha256 } from '@noble/hashes/sha2.js'

// ── Hashes — format spec §2.1 ────────────────────────────────────────────────
// All hashes are SHA-256 over exact bytes: 32 octets. In CBOR a hash is a
// 32-byte byte string (no multihash prefix, no tag). In text it is lowercase
// hex, prefixed `sha256:`.

export const HASH_LENGTH = 32

export type Hash = Uint8Array

export function hash(bytes: Uint8Array): Hash {
  return sha256(bytes)
}

export function toHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('sha256:') ? hex.slice('sha256:'.length) : hex
  if (clean.length % 2 !== 0) throw new Error('odd-length hex')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('invalid hex')
    out[i] = byte
  }
  return out
}

/** Text form for URLs, logs, UI: `sha256:6b86b273ff34fce…`. */
export function toHashText(h: Hash): string {
  return `sha256:${toHex(h)}`
}

/** Reject a byte string of any length other than 32 where a hash is expected
 *  (spec §2.1). */
export function asHash(bytes: Uint8Array): Hash {
  if (bytes.length !== HASH_LENGTH) {
    throw new Error(`expected a ${HASH_LENGTH}-byte hash, got ${bytes.length} bytes`)
  }
  return bytes
}
