// @yourproject/format — the thing format.
// Canonical CBOR, hashing, signing/verification, sealed envelopes, and the
// bundle admission algorithm. Pure TypeScript: no UI, no Electron, no network.

export { encode, decode, decodeCanonical, bytesEqual, compareBytes, CborError } from './cbor.js'
export type { CborValue, CborKey, CborMap } from './cbor.js'

export { hash, toHex, fromHex, toHashText, asHash, HASH_LENGTH } from './hash.js'
export type { Hash } from './hash.js'

export { DEFAULT_LIMITS, MAX_SEALED_SLOTS } from './limits.js'
export type { DecodeLimits } from './limits.js'

export { decodeManifest, encodeManifest, ManifestError } from './manifest.js'
export type { Manifest, Attachment } from './manifest.js'

export {
  decodeEnvelope,
  encodeEnvelope,
  base64urlNoPad,
  signingInputFor,
  ENVELOPE_DOMAIN,
  EnvelopeError
} from './envelope.js'
export type { Envelope, Author, Signer, UnsignedEnvelope, DecodedEnvelope } from './envelope.js'

export { registerScheme, getVerifier, knownSchemes, SSH_ED25519_SCHEME } from './schemes.js'
export type { Verifier } from './schemes.js'

export { verifyEnvelope } from './verify.js'
export type { VerifyResult } from './verify.js'

export {
  conversationKey,
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
  Nip44Error
} from './nip44.js'

export { seal, unseal, unsealerFromKey, isSealed, SealedError } from './sealed.js'
export type { Unsealer } from './sealed.js'

export {
  admitBundle,
  parseBundle,
  parseTar,
  chainInfo,
  DEFAULT_BUNDLE_LIMITS,
  BundleError
} from './bundle.js'
export type { AdmissionResult, AdmitOptions, BundleSource, BundleLimits } from './bundle.js'
