import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { serveAttachment, type CageResources } from '../../src/main/protocol.js'
import type { AttachmentStore } from '../../src/main/store.js'

// Response-level tests for the att/ route (finding 1.2): the Range unit tests
// cover the parser; these assert the actual Response — status, Content-Range,
// Content-Length, Accept-Ranges, and the exact BYTE SLICE — so a regression in
// how ranges become responses is caught, not just a regression in parsing.

const BODY = new Uint8Array(Array.from({ length: 100 }, (_, i) => i)) // 0..99
const HASH = createHash('sha256').update(BODY).digest('hex')

/** A minimal in-memory store over a single blob, used to drive serveAttachment
 *  without Electron. Mirrors EphemeralStore's slicing semantics. */
const store: AttachmentStore = {
  has: (h) => h === HASH,
  read: (h, start, end) => {
    if (h !== HASH || start < 0 || end >= BODY.length || start > end) return null
    const slice = BODY.subarray(start, end + 1)
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(slice)
        c.close()
      }
    })
  }
}

function resources(): CageResources {
  return {
    blobs: new Map(),
    attachments: new Map([['poster', { hash: HASH, mime: 'image/png', size: BODY.length }]]),
    store
  }
}

function req(range?: string): Request {
  const headers = new Headers()
  if (range) headers.set('range', range)
  return new Request('thing://x/att/poster', { headers })
}

async function bytesOf(r: Response): Promise<Uint8Array> {
  return new Uint8Array(await r.arrayBuffer())
}

describe('serveAttachment', () => {
  it('serves the full body (200) with the manifest mime, nosniff, accept-ranges', async () => {
    const r = serveAttachment(resources(), 'poster', req())
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    expect(r.headers.get('content-length')).toBe('100')
    expect(await bytesOf(r)).toEqual(BODY)
  })

  it('serves a byte range (206) with the exact Content-Range and slice', async () => {
    const r = serveAttachment(resources(), 'poster', req('bytes=10-19'))
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(r.headers.get('content-length')).toBe('10')
    expect(await bytesOf(r)).toEqual(BODY.subarray(10, 20))
  })

  it('serves the open-ended range media elements send (bytes=0-)', async () => {
    const r = serveAttachment(resources(), 'poster', req('bytes=0-'))
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 0-99/100')
    expect((await bytesOf(r)).length).toBe(100)
  })

  it('serves a suffix range (last N bytes)', async () => {
    const r = serveAttachment(resources(), 'poster', req('bytes=-10'))
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 90-99/100')
    expect(await bytesOf(r)).toEqual(BODY.subarray(90, 100))
  })

  it('returns 416 with Content-Range for an unsatisfiable range', async () => {
    const r = serveAttachment(resources(), 'poster', req('bytes=200-300'))
    expect(r.status).toBe(416)
    expect(r.headers.get('content-range')).toBe('bytes */100')
  })

  it('404s an unknown name (the table is the gate)', async () => {
    const r = serveAttachment(resources(), 'nope', req())
    expect(r.status).toBe(404)
  })

  it('falls back to the full body on a malformed Range header', async () => {
    const r = serveAttachment(resources(), 'poster', req('bytes=abc'))
    expect(r.status).toBe(200)
    expect((await bytesOf(r)).length).toBe(100)
  })
})
