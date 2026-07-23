import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { randomBytes } from '@noble/hashes/utils.js'
import { decodeCanonical, encode, type CborMap, type CborValue, type CborKey } from './cbor.js'
import { DEFAULT_LIMITS, MAX_SEALED_SLOTS, type DecodeLimits } from './limits.js'
import { conversationKey, encrypt as nip44Encrypt, decrypt as nip44Decrypt } from './nip44.js'

// ── Sealed envelopes — format spec §7 ────────────────────────────────────────
//
// Sealed = { 1: uint v(=1), 2: [Slot], 3: bytes(24) nonce, 4: bytes ct }
// Slot   = { 1: bytes(32) epk, 2: bytes wrap }
//
// A random content key CK encrypts the (padded) envelope once with
// XChaCha20-Poly1305; each slot wraps CK to one recipient with NIP-44 v2 under a
// FRESH ephemeral sender key. Recipients are NOT listed — a recipient
// trial-decrypts each slot until one succeeds. Sign-then-encrypt: the author's
// signature is INSIDE the ciphertext, so the world cannot see who sent it.

export class SealedError extends Error {
  override name = 'SealedError'
}

const OUTER_PAD_PREFIX = 2

/** NIP-44-style length-prefixed padding for the inner envelope, so ciphertext
 *  length does not fingerprint the envelope. (Same scheme as §7's note.) */
function padOuter(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) throw new SealedError('envelope too large to seal')
  // Pad up to the next 256-byte bucket (small envelopes → uniform size).
  const bucket = 256
  const total = Math.max(bucket, Math.ceil((bytes.length + OUTER_PAD_PREFIX) / bucket) * bucket)
  const out = new Uint8Array(total)
  out[0] = (bytes.length >> 8) & 0xff
  out[1] = bytes.length & 0xff
  out.set(bytes, OUTER_PAD_PREFIX)
  return out
}

function unpadOuter(padded: Uint8Array): Uint8Array {
  if (padded.length < OUTER_PAD_PREFIX) throw new SealedError('padded plaintext too short')
  const len = (padded[0]! << 8) | padded[1]!
  const content = padded.subarray(OUTER_PAD_PREFIX, OUTER_PAD_PREFIX + len)
  if (content.length !== len) throw new SealedError('invalid inner padding')
  return content
}

/** Is this byte sequence a Sealed envelope (v=1, has slots)? Cheap structural
 *  peek so the caller can branch before full processing. */
export function isSealed(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): boolean {
  try {
    const m = decodeCanonical(bytes, limits)
    return m instanceof Map && m.get(1) === 1 && Array.isArray(m.get(2)) && m.get(4) instanceof Uint8Array
  } catch {
    return false
  }
}

interface ParsedSealed {
  slots: { epk: Uint8Array; wrap: Uint8Array }[]
  nonce: Uint8Array
  ct: Uint8Array
}

function parseSealed(bytes: Uint8Array, limits: DecodeLimits): ParsedSealed {
  const top = decodeCanonical(bytes, limits)
  if (!(top instanceof Map)) throw new SealedError('sealed: expected a map')
  if (top.get(1) !== 1) throw new SealedError('sealed: v must be 1')
  const rawSlots = top.get(2)
  if (!Array.isArray(rawSlots)) throw new SealedError('sealed: slots must be an array')
  // Cap slot count BEFORE any crypto — trial-decryption is O(slots) of real
  // work, so an unbounded slot list is a CPU-exhaustion attack (§7 gap #5).
  if (rawSlots.length > MAX_SEALED_SLOTS) {
    throw new SealedError(`sealed: too many slots (${rawSlots.length} > ${MAX_SEALED_SLOTS})`)
  }
  const nonce = top.get(3)
  const ct = top.get(4)
  if (!(nonce instanceof Uint8Array) || nonce.length !== 24) throw new SealedError('sealed: nonce must be 24 bytes')
  if (!(ct instanceof Uint8Array)) throw new SealedError('sealed: ct must be a byte string')
  const slots = rawSlots.map((s) => {
    if (!(s instanceof Map)) throw new SealedError('sealed: slot must be a map')
    const epk = s.get(1)
    const wrap = s.get(2)
    if (!(epk instanceof Uint8Array) || epk.length !== 32) throw new SealedError('slot.epk must be 32 bytes')
    if (!(wrap instanceof Uint8Array)) throw new SealedError('slot.wrap must be a byte string')
    return { epk, wrap }
  })
  return { slots, nonce, ct }
}

/**
 * An Unsealer attempts to unwrap the content key CK from one slot. The keyring
 * implements this over its private key, so `format` NEVER receives key bytes: a
 * bug here yields a wrong unwrap, never key exfiltration. `unwrap` returns the
 * 32-byte CK on success, or null if this slot is not for us (MAC mismatch).
 */
export interface Unsealer {
  unwrap(epk: Uint8Array, wrap: Uint8Array): Uint8Array | null
}

/** A convenience Unsealer holding a raw private key — fine for tests and simple
 *  callers; the shell keyring provides its own so the key stays internal. */
export function unsealerFromKey(recipientPriv: Uint8Array): Unsealer {
  return {
    unwrap(epk, wrap) {
      try {
        const ck = nip44Decrypt(wrap, conversationKey(recipientPriv, epk))
        return ck.length === 32 ? ck : null
      } catch {
        return null
      }
    }
  }
}

/**
 * Trial-decrypt a Sealed envelope with an injected Unsealer. Returns the inner
 * (signed) envelope bytes on success, or 'not-for-me' if no slot unwraps. Never
 * throws for a well-formed sealed blob that simply is not addressed to us.
 */
export function unseal(
  bytes: Uint8Array,
  unsealer: Unsealer,
  limits: DecodeLimits = DEFAULT_LIMITS
): Uint8Array | 'not-for-me' {
  const r = unsealFull(bytes, unsealer, limits)
  return r === 'not-for-me' ? r : r.envelope
}

export interface UnsealResult {
  /** The inner (signed) envelope bytes. */
  envelope: Uint8Array
  /** The content key CK — needed to decrypt the sealed bundle members (§7.1). */
  ck: Uint8Array
}

/** Like `unseal`, but also returns the recovered content key CK so the caller
 *  can decrypt the sealed bundle's other members (manifest.enc, program.enc,
 *  ciphertext attachments — §7.1). */
export function unsealFull(
  bytes: Uint8Array,
  unsealer: Unsealer,
  limits: DecodeLimits = DEFAULT_LIMITS
): UnsealResult | 'not-for-me' {
  const { slots, nonce, ct } = parseSealed(bytes, limits)
  for (const slot of slots) {
    const ck = unsealer.unwrap(slot.epk, slot.wrap)
    if (!ck || ck.length !== 32) continue
    try {
      const padded = xchacha20poly1305(ck, nonce).decrypt(ct)
      return { envelope: unpadOuter(padded), ck }
    } catch {
      // CK unwrapped but the outer AEAD failed — corrupt sealed blob. A wrong
      // slot would have failed at unwrap above, so this is tampering.
      throw new SealedError('sealed: content key valid but outer decrypt failed (tampered)')
    }
  }
  return 'not-for-me'
}

// ── Sealed bundle members (§7.1) ─────────────────────────────────────────────
// Every part of a sealed thing except envelope.cbor travels as its own member,
// encrypted under CK with a fresh 24-byte nonce, stored `nonce(24) || ct`.

const MEMBER_NONCE_LEN = 24

/** Encrypt a sealed bundle member (manifest / program / attachment) under CK. */
export function sealMember(plaintext: Uint8Array, ck: Uint8Array): Uint8Array {
  const nonce = randomBytes(MEMBER_NONCE_LEN)
  const ciphertext = xchacha20poly1305(ck, nonce).encrypt(plaintext)
  const out = new Uint8Array(MEMBER_NONCE_LEN + ciphertext.length)
  out.set(nonce, 0)
  out.set(ciphertext, MEMBER_NONCE_LEN)
  return out
}

/** Decrypt a sealed bundle member under CK. Throws on tamper (AEAD failure). */
export function unsealMember(member: Uint8Array, ck: Uint8Array): Uint8Array {
  if (member.length < MEMBER_NONCE_LEN + 16) throw new SealedError('sealed member too short')
  const nonce = member.subarray(0, MEMBER_NONCE_LEN)
  const ciphertext = member.subarray(MEMBER_NONCE_LEN)
  return xchacha20poly1305(ck, nonce).decrypt(ciphertext)
}

// ── Sealing (out of scope for the v1 shell; used by tests, kept for LATER) ────

/** Seal an envelope to recipient x-only pubkeys. Returns the Sealed bytes AND
 *  the content key CK, so the caller can encrypt the other bundle members (§7.1)
 *  under the same CK. Each slot uses a fresh ephemeral sender key; slot order is
 *  randomized. */
export function sealEnvelope(
  envelopeBytes: Uint8Array,
  recipientXonlyPubs: Uint8Array[]
): { sealed: Uint8Array; ck: Uint8Array } {
  if (recipientXonlyPubs.length === 0) throw new SealedError('seal: no recipients')
  if (recipientXonlyPubs.length > MAX_SEALED_SLOTS) throw new SealedError('seal: too many recipients')
  const ck = randomBytes(32)
  const nonce = randomBytes(24)
  const ct = xchacha20poly1305(ck, nonce).encrypt(padOuter(envelopeBytes))

  const slots: CborValue[] = recipientXonlyPubs.map((recipient) => {
    const ephPriv = secp256k1.utils.randomSecretKey()
    const epk = schnorr.getPublicKey(ephPriv) // 32-byte x-only
    const convKey = conversationKey(ephPriv, recipient)
    const wrap = nip44Encrypt(ck, convKey)
    return new Map<CborKey, CborValue>([[1, epk], [2, wrap]])
  })
  shuffle(slots)

  const map: CborMap = new Map<CborKey, CborValue>()
  map.set(1, 1)
  map.set(2, slots)
  map.set(3, nonce)
  map.set(4, ct)
  return { sealed: encode(map), ck }
}

/** Seal an envelope only (identity-only sealed thing). */
export function seal(envelopeBytes: Uint8Array, recipientXonlyPubs: Uint8Array[]): Uint8Array {
  return sealEnvelope(envelopeBytes, recipientXonlyPubs).sealed
}

function shuffle<T>(arr: T[]): void {
  // Fisher-Yates with rejection-sampled random indices (order must not leak who
  // was invited first — §7).
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
}

function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive
  for (;;) {
    const b = randomBytes(4)
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
    if (v < limit) return v % maxExclusive
  }
}
