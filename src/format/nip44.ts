import { secp256k1 } from '@noble/curves/secp256k1.js'
import { chacha20 } from '@noble/ciphers/chacha.js'
import { extract, expand } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { randomBytes } from '@noble/hashes/utils.js'

// ── NIP-44 v2 ────────────────────────────────────────────────────────────────
// Used to wrap the content key CK to each recipient in a sealed envelope (§7).
// This implements the v2 payload as raw binary (not base64 — the wrap is a CBOR
// byte string here, so base64 would be redundant): version(1) || nonce(32) ||
// ciphertext || mac(32). ChaCha20 (unauthenticated) + HMAC-SHA256 over
// (nonce || ciphertext), keyed by HKDF-derived material.

export class Nip44Error extends Error {
  override name = 'Nip44Error'
}

const VERSION = 2

/** conversation_key = HKDF-extract(salt="nip44-v2", IKM=ecdh_x). `xonlyPub` is
 *  a 32-byte x-only pubkey (assumed even-y, per nostr convention). */
export function conversationKey(privkey: Uint8Array, xonlyPub: Uint8Array): Uint8Array {
  if (xonlyPub.length !== 32) throw new Nip44Error('x-only pubkey must be 32 bytes')
  const pub = new Uint8Array(33)
  pub[0] = 0x02
  pub.set(xonlyPub, 1)
  const shared = secp256k1.getSharedSecret(privkey, pub) // 33 bytes: prefix || X
  const sharedX = shared.subarray(1)
  return extract(sha256, sharedX, new TextEncoder().encode('nip44-v2'))
}

function messageKeys(convKey: Uint8Array, nonce: Uint8Array): {
  chachaKey: Uint8Array
  chachaNonce: Uint8Array
  hmacKey: Uint8Array
} {
  const keys = expand(sha256, convKey, nonce, 76)
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76)
  }
}

/** NIP-44 padding: prefix with 2-byte big-endian length, pad to a size bucket
 *  so ciphertext length does not fingerprint the plaintext length. */
function calcPaddedLen(unpadded: number): number {
  if (unpadded <= 32) return 32
  const nextPower = 1 << (Math.floor(Math.log2(unpadded - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((unpadded - 1) / chunk) + 1)
}

function pad(plaintext: Uint8Array): Uint8Array {
  const len = plaintext.length
  if (len < 1 || len > 0xffff) throw new Nip44Error('plaintext length out of range')
  const padded = calcPaddedLen(len)
  const out = new Uint8Array(2 + padded)
  out[0] = (len >> 8) & 0xff
  out[1] = len & 0xff
  out.set(plaintext, 2)
  return out
}

function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 2) throw new Nip44Error('padded too short')
  const len = (padded[0]! << 8) | padded[1]!
  const content = padded.subarray(2, 2 + len)
  if (content.length !== len) throw new Nip44Error('invalid padding length')
  if (padded.length !== 2 + calcPaddedLen(len)) throw new Nip44Error('invalid padded size')
  return content
}

function hmacAad(hmacKey: Uint8Array, aad: Uint8Array, message: Uint8Array): Uint8Array {
  const combined = new Uint8Array(aad.length + message.length)
  combined.set(aad, 0)
  combined.set(message, aad.length)
  return hmac(sha256, hmacKey, combined)
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** Encrypt with a conversation key. Returns the raw v2 payload bytes. `nonce`
 *  is exposed for deterministic tests; omit for a fresh random one. */
export function encrypt(plaintext: Uint8Array, convKey: Uint8Array, nonce?: Uint8Array): Uint8Array {
  const n = nonce ?? randomBytes(32)
  if (n.length !== 32) throw new Nip44Error('nonce must be 32 bytes')
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, n)
  const ciphertext = chacha20(chachaKey, chachaNonce, pad(plaintext))
  const mac = hmacAad(hmacKey, n, ciphertext)
  const out = new Uint8Array(1 + 32 + ciphertext.length + 32)
  out[0] = VERSION
  out.set(n, 1)
  out.set(ciphertext, 33)
  out.set(mac, 33 + ciphertext.length)
  return out
}

/** Decrypt a raw v2 payload with a conversation key. Throws on any tamper
 *  (version, MAC, or padding). */
export function decrypt(payload: Uint8Array, convKey: Uint8Array): Uint8Array {
  if (payload.length < 1 + 32 + 32 + 1) throw new Nip44Error('payload too short')
  if (payload[0] !== VERSION) throw new Nip44Error(`unsupported version ${payload[0]}`)
  const nonce = payload.subarray(1, 33)
  const ciphertext = payload.subarray(33, payload.length - 32)
  const mac = payload.subarray(payload.length - 32)
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce)
  const expectedMac = hmacAad(hmacKey, nonce, ciphertext)
  if (!constantTimeEqual(mac, expectedMac)) throw new Nip44Error('MAC mismatch')
  const padded = chacha20(chachaKey, chachaNonce, ciphertext)
  return unpad(padded)
}
