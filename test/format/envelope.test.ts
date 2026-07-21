import { describe, it, expect } from 'vitest'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeEnvelope, decodeEnvelope, type Signer } from '../../src/format/envelope.js'
import { verifyEnvelope } from '../../src/format/verify.js'

// ── Test signers (the keyring implements these in the shell) ─────────────────

function ethAddress(priv: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv, true)).toBytes(false)
  const addr = keccak_256(uncompressed.subarray(1))
  return addr.subarray(addr.length - 20)
}

function ethSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'eth-eip191',
    pubkey: ethAddress(priv),
    async sign(signingInput) {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${signingInput.length}`)
      const buf = new Uint8Array(prefix.length + signingInput.length)
      buf.set(prefix, 0)
      buf.set(signingInput, prefix.length)
      const digest = keccak_256(buf)
      // @noble "recovered" format is rec(1) || r(32) || s(32); Ethereum wants
      // r || s || v with v = recovery + 27.
      const recd = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0) // r||s
      out[64] = recd[0]! + 27 // v
      return out
    }
  }
}

function nostrSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'nostr-schnorr',
    pubkey: schnorr.getPublicKey(priv),
    async sign(signingInput) {
      return schnorr.sign(sha256(signingInput), priv)
    }
  }
}

const man = new Uint8Array(32).fill(0xab)

describe('envelope sign + verify round-trip', () => {
  it('eth-eip191: valid signature verifies', async () => {
    const signer = ethSigner(secp256k1.utils.randomSecretKey())
    const bytes = await encodeEnvelope({ man, created: 1_700_000_000 }, signer)
    const r = verifyEnvelope(bytes)
    expect(r.status).toBe('valid')
    if (r.status === 'valid') {
      expect(r.envelope.author.s).toBe('eth-eip191')
      expect(r.envelope.man).toEqual(man)
      expect(r.envelope.created).toBe(1_700_000_000)
    }
  })

  it('nostr-schnorr: valid signature verifies', async () => {
    const signer = nostrSigner(secp256k1.utils.randomSecretKey())
    const bytes = await encodeEnvelope({ man, created: 42, path: 'event/bbq', seq: 1 }, signer)
    const r = verifyEnvelope(bytes)
    expect(r.status).toBe('valid')
    if (r.status === 'valid') {
      expect(r.envelope.path).toBe('event/bbq')
      expect(r.envelope.seq).toBe(1)
    }
  })

  it('a flipped signature bit is invalid (alarm), not unverifiable', async () => {
    const signer = ethSigner(secp256k1.utils.randomSecretKey())
    const bytes = await encodeEnvelope({ man, created: 1 }, signer)
    // Decode, flip a byte inside the signature, re-encode is not needed — just
    // corrupt the raw bytes near the end (the sig sits last).
    const corrupt = Uint8Array.from(bytes)
    corrupt[corrupt.length - 5] ^= 0xff
    const r = verifyEnvelope(corrupt)
    // Either the sig fails (invalid) or the corruption broke canonical form
    // (also invalid via decode). Never 'valid', never 'unverifiable'.
    expect(r.status).toBe('invalid')
  })

  it('an unknown scheme is unverifiable, not invalid', async () => {
    const signer: Signer = {
      scheme: 'made-up-scheme',
      pubkey: new Uint8Array(20).fill(1),
      async sign() {
        return new Uint8Array(65)
      }
    }
    const bytes = await encodeEnvelope({ man, created: 1 }, signer)
    const r = verifyEnvelope(bytes)
    expect(r.status).toBe('unverifiable')
    if (r.status === 'unverifiable') expect(r.scheme).toBe('made-up-scheme')
  })

  it('signing_input is domain-separated and derived from the received bytes', async () => {
    const signer = ethSigner(secp256k1.utils.randomSecretKey())
    const bytes = await encodeEnvelope({ man, created: 1 }, signer)
    const { signingInput } = decodeEnvelope(bytes)
    expect(new TextDecoder().decode(signingInput)).toMatch(/^thing-envelope-v1:/)
  })

  it('seq/prev without path are rejected', async () => {
    const signer = ethSigner(secp256k1.utils.randomSecretKey())
    await expect(encodeEnvelope({ man, created: 1, seq: 2 }, signer)).rejects.toThrow(/seq requires path/)
  })
})
