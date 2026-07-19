import type { AttachmentStore, AttachmentTable } from './store.js'
import { record } from './events.js'

// The `thing://` protocol handler.
//
// This is the ONLY "fetch" path a thing has, and it resolves exclusively to
// bytes the thing already came with. The handler never touches the filesystem
// based on thing-controlled input — attachment names resolve through the
// admitted attachment table to a hash, and only that shell-derived hash keys
// the store. It never touches the network.
//
// Two routes:
//   thing://<id>/index.html   — the program itself, from the in-memory blob map
//   thing://<id>/att/<name>   — an attachment, streamed by name from the cage's
//                               store (on-disk CAS for public things, in-memory
//                               ephemeral store for sealed ones)
//
// The security gate for attachments is the TABLE plus this handler, not
// bridge.getBlob(): a thing can hand-build `thing://<id>/att/<name>` itself,
// and that is fine — an unknown name is a 404 either way. `getBlob` returning
// null is a convenience signal, not the boundary.

export interface Blob {
  mime: string
  bytes: Uint8Array
}

/** Everything the handler may serve for one cage id. Populated at mount,
 *  BEFORE the thing loads. Integrity was verified at admission (§8.1); the
 *  handler serves by hash and does not re-verify per request. */
export interface CageResources {
  /** path -> blob, e.g. 'index.html'. The program bytes. */
  blobs: Map<string, Blob>
  /** name -> { hash, mime, size } from the admitted manifest. */
  attachments: AttachmentTable
  /** Where the attachment bytes live (CAS or ephemeral). */
  store: AttachmentStore
}

/** id -> resources for every cage on this session. */
export type ResourceMap = Map<string, CageResources>

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' thing:",
  "style-src 'unsafe-inline' thing:",
  'img-src thing: data: blob:',
  'media-src thing: blob:',
  'font-src thing: data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** The canonical CSP for a thing. Exported so the cage's onHeadersReceived
 *  layer and this protocol layer inject the exact same policy (Layer 4).
 *  `att/` responses carry it too — same policy, no exceptions. */
export const THING_CSP = CSP

export function parseThingUrl(rawUrl: string): { id: string; path: string } | null {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'thing:') return null
  // thing://<id>/<path...>  -> host is the id, pathname is the resource.
  const id = u.hostname
  let path = decodeURIComponent(u.pathname).replace(/^\/+/, '')
  if (path === '') path = 'index.html'
  // Reject any traversal attempt outright. The stores are keyed by hash, not
  // by this path, but a lookup key containing `..` is a smell we refuse on
  // principle.
  if (path.includes('..')) return null
  if (!id) return null
  return { id, path }
}

/** The URL a thing uses to load attachment `name` — what getBlob() returns. */
export function attachmentUrl(id: string, name: string): string {
  return `thing://${id}/att/${encodeURIComponent(name)}`
}

/** A parsed single byte range, inclusive. `null` = serve the full body;
 *  'unsatisfiable' = 416. Multi-range and malformed headers fall back to the
 *  full body, which is HTTP-legal and keeps the handler simple. */
export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null

export function parseRange(header: string | null, size: number): ByteRange {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, a, b] = m
  if (a === '' && b === '') return null
  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b)
    if (n === 0 || size === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  if (start >= size) return 'unsatisfiable'
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (start > end) return 'unsatisfiable'
  return { start, end }
}

const ATT_PREFIX = 'att/'

/**
 * Register the `thing:` handler on a specific (partitioned) session.
 * Returns bytes for known resources and a hard 404 for anything else — a thing
 * asking for content that is not in its supplied resources gets nothing.
 */
export function registerThingProtocol(session: Electron.Session, resources: ResourceMap): void {
  session.protocol.handle('thing', (request) => {
    const parsed = parseThingUrl(request.url)
    if (!parsed) {
      return new Response('bad thing url', { status: 400 })
    }
    const res = resources.get(parsed.id)
    if (!res) {
      return new Response('not found', { status: 404, headers: { 'content-security-policy': CSP } })
    }

    if (parsed.path.startsWith(ATT_PREFIX)) {
      return serveAttachment(res, parsed.path.slice(ATT_PREFIX.length), request)
    }

    const blob = res.blobs.get(parsed.path)
    if (!blob) {
      // Unknown resource: serve nothing. This is what makes
      // `fetch('thing://main/secret')` for un-supplied content fail.
      return new Response('not found', {
        status: 404,
        headers: { 'content-security-policy': CSP }
      })
    }
    return new Response(blob.bytes, {
      status: 200,
      headers: {
        'content-type': blob.mime,
        // Layer 4 (also enforced in the cage's onHeadersReceived): the CSP
        // travels with the bytes so it is authoritative for this response.
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff'
      }
    })
  })
}

/** Serve `att/<name>`: resolve the name in the admitted table, stream the blob
 *  by hash from the store, honour single byte ranges so media seeking works. */
function serveAttachment(res: CageResources, name: string, request: Request): Response {
  const rangeHeader = request.headers.get('range')
  const entry = res.attachments.get(name)
  if (!entry || !res.store.has(entry.hash)) {
    record({ type: 'att-request', name, status: 404, range: rangeHeader })
    return new Response('not found', {
      status: 404,
      headers: { 'content-security-policy': CSP }
    })
  }

  // The admitted size is authoritative: it was verified against the bytes at
  // admission (§8.1 step 8), and the store is shell-controlled thereafter.
  const size = entry.size
  const baseHeaders: Record<string, string> = {
    'content-type': entry.mime,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes'
  }

  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    record({ type: 'att-request', name, status: 416, range: rangeHeader })
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${size}` }
    })
  }

  const start = range ? range.start : 0
  const end = range ? range.end : size - 1

  if (size === 0) {
    record({ type: 'att-request', name, status: 200, range: rangeHeader })
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: { ...baseHeaders, 'content-length': '0' }
    })
  }

  const body = res.store.read(entry.hash, start, end)
  if (!body) {
    // Table says yes but the store cannot produce the bytes — an admission
    // bug, never thing-controlled. Fail closed.
    record({ type: 'att-request', name, status: 404, range: rangeHeader })
    return new Response('not found', {
      status: 404,
      headers: { 'content-security-policy': CSP }
    })
  }

  const status = range ? 206 : 200
  const headers: Record<string, string> = {
    ...baseHeaders,
    'content-length': String(end - start + 1)
  }
  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  record({ type: 'att-request', name, status, range: rangeHeader })
  return new Response(body as unknown as ReadableStream, { status, headers })
}
