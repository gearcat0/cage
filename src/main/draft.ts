import { createHash } from 'node:crypto'

// ── Publish drafts ───────────────────────────────────────────────────────────
// `emit("publish", …)` hands the shell a draft of a manifest-to-be:
//
//   { type: string, args: unknown, blobs?: { [name: string]: Uint8Array } }
//
// This module is the receipt-side validation: pure, no Electron, unit-testable.
// It enforces shape and size caps and assembles the draft's attachment table
// (name -> { h, m, n }) by hashing each inline blob — mirroring the manifest's
// Att rows so later phases can sign and seal without a shape change.
//
// The caps follow finding P0-3's discipline: bound the TOTAL bytes accepted per
// draft, not just each blob — a thing must not be able to grow shell memory
// without bound by sending many individually-small blobs.
//
// LATER: signing, sealing, and the review/confirm UI consume these drafts.
// LATER: inline blobs carry no MIME type in the publish contract, so the table
// records application/octet-stream; the real MIME is decided at review time
// (or the contract grows a per-blob mime — a format-spec question, noted in
// FORMAT_SPEC_NOTES.md).

export interface DraftCaps {
  maxTypeLen: number
  maxArgsBytes: number
  maxBlobBytes: number
  maxTotalBlobBytes: number
  maxBlobCount: number
  maxNameLen: number
}

export const DEFAULT_DRAFT_CAPS: DraftCaps = {
  maxTypeLen: 128,
  maxArgsBytes: 256 * 1024, // same order as MAX_EMIT_BYTES: args are small
  maxBlobBytes: 32 * 1024 * 1024, // one generated image/video frame, not a film
  maxTotalBlobBytes: 64 * 1024 * 1024, // hard total per draft (P0-3 discipline)
  maxBlobCount: 256, // matches the format spec's max attachment count (§2.3)
  maxNameLen: 255
}

/** Mirrors the manifest Att row (§4): h/m/n. Hash is lowercase hex here —
 *  text-form per §2.1 — because the draft is a JS-side record, not CBOR. */
export interface DraftAtt {
  h: string
  m: string
  n: number
}

export interface Draft {
  type: string
  args: unknown
  att: Record<string, DraftAtt>
  blobs: Record<string, Uint8Array>
}

export type DraftResult =
  | { ok: true; draft: Draft; argsBytes: number; blobBytes: number }
  | { ok: false; reason: string }

const ALLOWED_KEYS = new Set(['type', 'args', 'blobs'])

/** Attachment names become `att/<name>` URL path segments, so refuse anything
 *  the thing:// parser would reject or mangle: empty, oversized, path
 *  separators, dot-dot, control characters. */
export function validBlobName(name: string, maxLen: number): boolean {
  if (name.length === 0 || name.length > maxLen) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('..')) return false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

export function validateDraft(data: unknown, caps: DraftCaps = DEFAULT_DRAFT_CAPS): DraftResult {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'publish: payload must be an object' }
  }
  const obj = data as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `publish: unknown key "${key}"` }
  }

  const type = obj.type
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, reason: 'publish: type must be a non-empty string' }
  }
  if (type.length > caps.maxTypeLen) {
    return { ok: false, reason: 'publish: type too long' }
  }

  if (!('args' in obj)) return { ok: false, reason: 'publish: args missing' }
  let argsBytes = 0
  try {
    const json = JSON.stringify(obj.args ?? null)
    if (typeof json !== 'string') throw new Error('unserialisable')
    argsBytes = Buffer.byteLength(json)
  } catch {
    return { ok: false, reason: 'publish: args not serialisable' }
  }
  if (argsBytes > caps.maxArgsBytes) {
    return { ok: false, reason: `publish: args too large (${argsBytes} bytes)` }
  }

  const att: Record<string, DraftAtt> = {}
  const blobs: Record<string, Uint8Array> = {}
  let blobBytes = 0

  if (obj.blobs !== undefined) {
    const raw = obj.blobs
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'publish: blobs must be a name->bytes object' }
    }
    const names = Object.keys(raw as Record<string, unknown>)
    if (names.length > caps.maxBlobCount) {
      return { ok: false, reason: `publish: too many blobs (${names.length})` }
    }
    for (const name of names) {
      if (!validBlobName(name, caps.maxNameLen)) {
        return { ok: false, reason: `publish: invalid blob name` }
      }
      const bytes = (raw as Record<string, unknown>)[name]
      if (!(bytes instanceof Uint8Array)) {
        return { ok: false, reason: `publish: blob "${name}" is not a Uint8Array` }
      }
      if (bytes.byteLength > caps.maxBlobBytes) {
        return { ok: false, reason: `publish: blob "${name}" too large (${bytes.byteLength} bytes)` }
      }
      blobBytes += bytes.byteLength
      if (blobBytes > caps.maxTotalBlobBytes) {
        return { ok: false, reason: `publish: total blob bytes exceed cap` }
      }
      const h = createHash('sha256').update(bytes).digest('hex')
      att[name] = { h, m: 'application/octet-stream', n: bytes.byteLength }
      blobs[name] = bytes
    }
  }

  return { ok: true, draft: { type, args: obj.args, att, blobs }, argsBytes, blobBytes }
}
