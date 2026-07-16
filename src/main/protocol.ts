// The `thing://` protocol handler.
//
// This is the ONLY "fetch" path a thing has, and it resolves exclusively to
// bytes the thing already came with. The handler never touches the filesystem
// based on thing-controlled input, and never touches the network. It serves
// from an in-memory blob map that was populated BEFORE the thing loaded.

export interface Blob {
  mime: string
  bytes: Uint8Array
}

/** id -> (path -> blob). e.g. blobs['abc123']['index.html']. */
export type BlobMap = Map<string, Map<string, Blob>>

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
 *  layer and this protocol layer inject the exact same policy (Layer 4). */
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
  // Reject any traversal attempt outright. There is no filesystem behind this,
  // but a lookup key containing `..` is a smell we refuse on principle.
  if (path.includes('..')) return null
  if (!id) return null
  return { id, path }
}

/**
 * Register the `thing:` handler on a specific (partitioned) session.
 * Returns bytes for known resources and a hard 404 for anything else — a thing
 * asking for content that is not in its supplied blob map gets nothing.
 */
export function registerThingProtocol(session: Electron.Session, blobs: BlobMap): void {
  session.protocol.handle('thing', (request) => {
    const parsed = parseThingUrl(request.url)
    if (!parsed) {
      return new Response('bad thing url', { status: 400 })
    }
    const blob = blobs.get(parsed.id)?.get(parsed.path)
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
