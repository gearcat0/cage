import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'

// ── Signature scheme registry — format spec §6 ───────────────────────────────
//
// A scheme is (id, key encoding, verify function). The registry maps an id to a
// verifier; adding a scheme MUST NOT require a format change. An unknown scheme
// makes an envelope `unverifiable` — a distinct outcome from `invalid`.
//
// Each verifier receives the domain-separated `signing_input` bytes (§5.1), the
// raw signature bytes, and the author key `k`. It returns whether the signature
// is valid. Verifiers MUST NOT throw on malformed sig/key — return false.

export type Verifier = (signingInput: Uint8Array, sig: Uint8Array, k: Uint8Array) => boolean

const registry = new Map<string, Verifier>()

export function registerScheme(id: string, verifier: Verifier): void {
  registry.set(id, verifier)
}

export function getVerifier(id: string): Verifier | undefined {
  return registry.get(id)
}

export function knownSchemes(): string[] {
  return [...registry.keys()]
}

// ── eth-eip191 (v1 primary, recommended default) ─────────────────────────────
// k is a 20-byte address. The author signs the signing_input with EIP-191
// `personal_sign`; we ecrecover the address and compare to k.

function personalSignDigest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${message.length}`)
  const buf = new Uint8Array(prefix.length + message.length)
  buf.set(prefix, 0)
  buf.set(message, prefix.length)
  return keccak_256(buf)
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

const verifyEthEip191: Verifier = (signingInput, sig, k) => {
  try {
    if (k.length !== 20) return false
    // Ethereum signature wire form is r(32) || s(32) || v(1), v ∈ {27,28} (or
    // {0,1}). Note this differs from @noble's "recovered" format (rec||r||s).
    if (sig.length !== 65) return false
    const compact = sig.subarray(0, 64) // r||s
    let rec = sig[64]!
    if (rec === 27 || rec === 28) rec -= 27
    if (rec !== 0 && rec !== 1) return false
    const digest = personalSignDigest(signingInput)
    const point = secp256k1.Signature.fromBytes(compact).addRecoveryBit(rec).recoverPublicKey(digest)
    const uncompressed = point.toBytes(false)
    const addr = keccak_256(uncompressed.subarray(1))
    return bytesEq(addr.subarray(addr.length - 20), k)
  } catch {
    return false
  }
}

// ── nostr-schnorr (v1 primary) ───────────────────────────────────────────────
// k is a 32-byte x-only pubkey. BIP-340 Schnorr over sha256(signing_input).

const verifyNostrSchnorr: Verifier = (signingInput, sig, k) => {
  try {
    if (k.length !== 32) return false
    if (sig.length !== 64) return false
    return schnorr.verify(sig, sha256(signingInput), k)
  } catch {
    return false
  }
}

registerScheme('eth-eip191', verifyEthEip191)
registerScheme('nostr-schnorr', verifyNostrSchnorr)

// LATER: `ssh-ed25519` — its slot in §6 proves the registry holds two curves
// and two key encodings. Verifying `ssh-keygen -Y sign` output means parsing the
// SSHSIG wire format with the `thing-envelope-v1` namespace; deferred. Until it
// is registered, ssh-ed25519 envelopes are `unverifiable`, which is the correct
// outcome for a scheme this build cannot check.
export const SSH_ED25519_SCHEME = 'ssh-ed25519'
