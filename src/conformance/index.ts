// @yourproject/conformance — the format half of the interop suite.
//
// The committed ./vectors/*.json are the language-agnostic artifact: a second
// implementation proves interop by running exactly these against its own code.
// In TypeScript, implement `ConformanceTarget` and call `runAll`; in any other
// language, consume the JSON directly (its schema is documented in README.md).
//
// The CAGE half of conformance — the hardened escape suite that proves an
// untrusted thing cannot break out of the renderer — is inherently host-specific
// (Electron) and lives as the Playwright `test/shell/*.spec.ts` battery, indexed
// in README.md. It is not reducible to portable data the way the format is.

import canonical from './vectors/canonical.json'
import hashing from './vectors/hashing.json'
import envelopes from './vectors/envelopes.json'
import bundles from './vectors/bundles.json'
import chain from './vectors/chain.json'
import sealed from './vectors/sealed.json'
import limits from './vectors/limits.json'

import type {
  VectorSet,
  CanonicalVector,
  HashVector,
  EnvelopeVector,
  BundleVector,
  ChainVector,
  SealedVector,
  LimitVector
} from './runner.js'

export * from './runner.js'
export type { ConformanceTarget, AdmitOutcome, VerifyOutcome, ChainFacts } from './target.js'
export { formatTarget } from './target.js'

/** The committed vector set, assembled from ./vectors/*.json. */
export function loadVectors(): VectorSet {
  return {
    canonical: canonical as CanonicalVector[],
    hashing: hashing as HashVector[],
    envelopes: envelopes as EnvelopeVector[],
    bundles: bundles as BundleVector[],
    chain: chain as ChainVector[],
    sealed: sealed as SealedVector[],
    limits: limits as LimitVector[]
  }
}
