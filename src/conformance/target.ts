// ── Conformance target — the surface a conforming implementation must expose ──
//
// The vectors are language-agnostic DATA (see ./vectors/*.json). A runner checks
// them against a `ConformanceTarget`: the minimal set of format operations the
// suite exercises. Our own package is wired up as `formatTarget`; a SECOND
// implementation proves interop by implementing this same interface (in any
// language, over the same JSON vectors) and passing `runAll`.
//
// The target never SIGNS or SEALS — a verifier/decoder surface is all that
// interop requires. Producing vectors is the generator's job (generate.ts).

import {
  decodeCanonical,
  decodeManifest,
  verifyEnvelope,
  decodeEnvelope,
  admitBundle,
  parseBundle,
  parseTar,
  unsealerFromKey,
  hash,
  toHex,
  fromHex,
  DEFAULT_LIMITS,
  DEFAULT_BUNDLE_LIMITS,
  type DecodeLimits,
  type BundleLimits
} from '../format/index.js'

export interface AdmitOptions {
  /** A recipient private key (hex) for sealed bundles; absent = public / not-for-me. */
  unsealerPrivHex?: string
  limits?: Partial<BundleLimits>
}

export interface AdmitOutcome {
  status: 'valid' | 'invalid' | 'unverifiable' | 'not-for-me'
  scheme?: string
  reason?: string
  sealed?: boolean
  envelopeHashHex?: string
  manHashHex?: string
  progHashHex?: string
  attHashHex?: Record<string, string>
  authorScheme?: string
  authorKeyHex?: string
}

export interface VerifyOutcome {
  status: 'valid' | 'invalid' | 'unverifiable'
  scheme?: string
  authorScheme?: string
  authorKeyHex?: string
}

export interface ChainFacts {
  path?: string
  seq?: number
  prevHex?: string
  /** sha256 of the envelope bytes — how the NEXT link's `prev` points here. */
  selfHex: string
}

/**
 * The operations the conformance suite drives. Every method either returns a
 * plain, comparable result or THROWS on rejection — the runner treats a throw
 * where a vector expects `reject` as a pass, and an unexpected throw as a fail.
 */
export interface ConformanceTarget {
  name: string
  sha256(bytes: Uint8Array): Uint8Array
  /** Decode-and-require-canonical. Throws on non-canonical / structurally invalid / over-limit input. */
  decodeCanonical(bytes: Uint8Array, limits?: Partial<DecodeLimits>): void
  /** Decode a manifest. Throws on invalid / over-limit input (e.g. too many attachments). */
  decodeManifest(bytes: Uint8Array, limits?: Partial<DecodeLimits>): void
  /** Verify a top-level (unsealed) envelope's signature. */
  verifyEnvelope(bytes: Uint8Array): VerifyOutcome
  /** Parse a tar under the bundle caps. Throws on a cap violation (tar-bomb, too many entries). */
  parseTar(tar: Uint8Array, limits?: Partial<BundleLimits>): void
  /** Parse + admit a bundle (§8.1). May throw if the tar itself violates a parse cap. */
  admit(tar: Uint8Array, opts?: AdmitOptions): AdmitOutcome
  /** The chain fields of an envelope, plus its own hash (for §5.3 linkage). */
  chainInfo(bytes: Uint8Array): ChainFacts
}

// ── Our reference implementation, wired to the interface ─────────────────────

export const formatTarget: ConformanceTarget = {
  name: '@yourproject/format',

  sha256(bytes) {
    return hash(bytes)
  },

  decodeCanonical(bytes, limits) {
    decodeCanonical(bytes, { ...DEFAULT_LIMITS, ...(limits ?? {}) })
  },

  decodeManifest(bytes, limits) {
    decodeManifest(bytes, { ...DEFAULT_LIMITS, ...(limits ?? {}) })
  },

  verifyEnvelope(bytes) {
    const r = verifyEnvelope(bytes)
    if (r.status === 'valid') {
      return {
        status: 'valid',
        authorScheme: r.envelope.author.s,
        authorKeyHex: toHex(r.envelope.author.k)
      }
    }
    if (r.status === 'unverifiable') return { status: 'unverifiable', scheme: r.scheme }
    return { status: 'invalid' }
  },

  parseTar(tar, limits) {
    parseTar(tar, { ...DEFAULT_BUNDLE_LIMITS, ...(limits ?? {}) })
  },

  admit(tar, opts) {
    const limits: BundleLimits = { ...DEFAULT_BUNDLE_LIMITS, ...(opts?.limits ?? {}) }
    const source = parseBundle(tar, limits)
    const unsealer = opts?.unsealerPrivHex ? unsealerFromKey(fromHex(opts.unsealerPrivHex)) : undefined
    const r = admitBundle(source, { limits, unsealer })
    if (r.status === 'valid') {
      const attHashHex: Record<string, string> = {}
      for (const [name, att] of r.manifest.att) attHashHex[name] = toHex(att.h)
      return {
        status: 'valid',
        sealed: r.sealed,
        envelopeHashHex: toHex(r.envelopeHash),
        manHashHex: toHex(r.envelope.man),
        progHashHex: toHex(r.manifest.prog),
        attHashHex,
        authorScheme: r.envelope.author.s,
        authorKeyHex: toHex(r.envelope.author.k)
      }
    }
    if (r.status === 'invalid') return { status: 'invalid', reason: r.reason }
    if (r.status === 'unverifiable') return { status: 'unverifiable', scheme: r.scheme }
    return { status: 'not-for-me' }
  },

  chainInfo(bytes) {
    const { envelope } = decodeEnvelope(bytes)
    const facts: ChainFacts = { selfHex: toHex(hash(bytes)) }
    if (envelope.path !== undefined) facts.path = envelope.path
    if (envelope.seq !== undefined) facts.seq = envelope.seq
    if (envelope.prev !== undefined) facts.prevHex = toHex(envelope.prev)
    return facts
  }
}
