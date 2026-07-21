// Decode limits — format spec §2.3. CBOR decoders are a classic DoS surface and
// this decoder runs in the trusted shell, so every limit is enforced and
// configurable. Exceeding any limit is a decode error, not a truncation.

export interface DecodeLimits {
  /** Max raw manifest size in bytes (applied to raw bytes by the caller). */
  maxManifestBytes: number
  /** Max raw envelope size in bytes (applied to raw bytes by the caller). */
  maxEnvelopeBytes: number
  /** Max CBOR nesting depth. */
  maxDepth: number
  /** Max attachment count (manifest att map). */
  maxAttachments: number
  /** Max entries in any single map or array. */
  maxEntries: number
  /** Max length of any text or byte string, in bytes. */
  maxStringBytes: number
}

export const DEFAULT_LIMITS: DecodeLimits = {
  maxManifestBytes: 1024 * 1024, // 1 MiB
  maxEnvelopeBytes: 64 * 1024, // 64 KiB
  maxDepth: 16,
  maxAttachments: 256,
  maxEntries: 4096,
  maxStringBytes: 1024 * 1024 // 1 MiB
}

/** Max slots in a Sealed envelope before trial-decryption (§7, gap #5). An
 *  unbounded slot list is a CPU-exhaustion attack: cap first, decrypt second. */
export const MAX_SEALED_SLOTS = 512
