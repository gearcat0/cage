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
  /** Attachment table for the INLINE blobs (name → hash/mime/size). */
  att: Record<string, DraftAtt>
  blobs: Record<string, Uint8Array>
  /** Names to CARRY OVER from the mounted instance's own attachments. A
   *  program can display its attachments but cannot read their bytes (CSP),
   *  so "keep my current image" is declared by name and resolved shell-side
   *  against the instance's store — the bytes never enter the renderer. */
  carry: string[]
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
    return { ok: false, reason: 'draft: payload must be an object' }
  }
  const obj = data as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, reason: `draft: unknown key "${key}"` }
  }

  const type = obj.type
  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, reason: 'draft: type must be a non-empty string' }
  }
  if (type.length > caps.maxTypeLen) {
    return { ok: false, reason: 'draft: type too long' }
  }

  if (!('args' in obj)) return { ok: false, reason: 'draft: args missing' }
  let argsBytes = 0
  try {
    const json = JSON.stringify(obj.args ?? null)
    if (typeof json !== 'string') throw new Error('unserialisable')
    argsBytes = Buffer.byteLength(json)
  } catch {
    return { ok: false, reason: 'draft: args not serialisable' }
  }
  if (argsBytes > caps.maxArgsBytes) {
    return { ok: false, reason: `draft: args too large (${argsBytes} bytes)` }
  }

  const att: Record<string, DraftAtt> = {}
  const blobs: Record<string, Uint8Array> = {}
  const carry: string[] = []
  let blobBytes = 0

  if (obj.blobs !== undefined) {
    const raw = obj.blobs
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: 'draft: blobs must be a name->blob object' }
    }
    const names = Object.keys(raw as Record<string, unknown>)
    if (names.length > caps.maxBlobCount) {
      return { ok: false, reason: `draft: too many blobs (${names.length})` }
    }
    for (const name of names) {
      if (!validBlobName(name, caps.maxNameLen)) {
        return { ok: false, reason: `draft: invalid blob name` }
      }
      // Three value forms: raw bytes, { bytes, mime }, or { carry: true }
      // (keep the mounted instance's attachment of this name — resolved
      // shell-side; a program cannot read its own attachment bytes).
      const v = (raw as Record<string, unknown>)[name]
      let bytes: Uint8Array
      let mime = 'application/octet-stream'
      if (v instanceof Uint8Array) {
        bytes = v
      } else if (typeof v === 'object' && v !== null && (v as { carry?: unknown }).carry === true) {
        if (Object.keys(v).length !== 1) {
          return { ok: false, reason: `draft: blob "${name}" carry marker must be exactly { carry: true }` }
        }
        carry.push(name)
        continue
      } else if (typeof v === 'object' && v !== null && (v as { bytes?: unknown }).bytes instanceof Uint8Array) {
        const o = v as { bytes: Uint8Array; mime?: unknown }
        bytes = o.bytes
        if (o.mime !== undefined) {
          if (typeof o.mime !== 'string' || o.mime.length > 128 || !MIME_RE.test(o.mime)) {
            return { ok: false, reason: `draft: blob "${name}" has an invalid mime type` }
          }
          mime = o.mime
        }
      } else {
        return { ok: false, reason: `draft: blob "${name}" must be bytes, { bytes, mime }, or { carry: true }` }
      }
      if (bytes.byteLength > caps.maxBlobBytes) {
        return { ok: false, reason: `draft: blob "${name}" too large (${bytes.byteLength} bytes)` }
      }
      blobBytes += bytes.byteLength
      if (blobBytes > caps.maxTotalBlobBytes) {
        return { ok: false, reason: `draft: total blob bytes exceed cap` }
      }
      const h = createHash('sha256').update(bytes).digest('hex')
      att[name] = { h, m: mime, n: bytes.byteLength }
      blobs[name] = bytes
    }
  }

  return { ok: true, draft: { type, args: obj.args, att, blobs, carry }, argsBytes, blobBytes }
}

/** type/subtype token form (RFC 6838-ish, permissive): the goal is to refuse
 *  header-breaking junk, not to police the IANA registry. */
const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i
