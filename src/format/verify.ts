import { decodeEnvelope, type Envelope } from './envelope.js'
import { getVerifier } from './schemes.js'
import { DEFAULT_LIMITS, type DecodeLimits } from './limits.js'

// ── Envelope verification — format spec §6, §8.1 steps 3-4 ──────────────────
// Three distinct outcomes, which MUST be surfaced differently in UI:
//   valid        — signature checks out over the received (canonical) bytes.
//   invalid      — a check failed: malformed/non-canonical, or bad signature.
//                  This is an ALARM (tampering or corruption).
//   unverifiable — the signature scheme is unknown. This is "cannot check",
//                  not "failed a check".

export type VerifyResult =
  | { status: 'valid'; envelope: Envelope }
  | { status: 'invalid'; reason: string }
  | { status: 'unverifiable'; scheme: string }

/**
 * Decode and verify an envelope from its canonical CBOR bytes. Verification is
 * over the bytes as received (the signing input is derived from the received
 * canonical envelope minus its signature).
 */
export function verifyEnvelope(bytes: Uint8Array, limits: DecodeLimits = DEFAULT_LIMITS): VerifyResult {
  let decoded
  try {
    decoded = decodeEnvelope(bytes, limits)
  } catch (e) {
    return { status: 'invalid', reason: `decode: ${(e as Error).message}` }
  }
  const { envelope, signingInput } = decoded
  const verifier = getVerifier(envelope.author.s)
  if (!verifier) return { status: 'unverifiable', scheme: envelope.author.s }
  let ok = false
  try {
    ok = verifier(signingInput, envelope.sig, envelope.author.k)
  } catch {
    ok = false
  }
  return ok
    ? { status: 'valid', envelope }
    : { status: 'invalid', reason: 'signature verification failed' }
}
