import { describe, it, expect } from 'vitest'
import { attachmentUrl, parseRange, parseThingUrl, THING_CSP } from '../../src/main/protocol.js'

describe('parseThingUrl', () => {
  it('parses id + path', () => {
    expect(parseThingUrl('thing://abc/index.html')).toEqual({ id: 'abc', path: 'index.html' })
    expect(parseThingUrl('thing://abc/sub/page.js')).toEqual({ id: 'abc', path: 'sub/page.js' })
  })

  it('defaults an empty path to index.html', () => {
    expect(parseThingUrl('thing://abc/')).toEqual({ id: 'abc', path: 'index.html' })
    expect(parseThingUrl('thing://abc')).toEqual({ id: 'abc', path: 'index.html' })
  })

  it('rejects non-thing schemes', () => {
    expect(parseThingUrl('https://abc/index.html')).toBeNull()
    expect(parseThingUrl('file:///etc/passwd')).toBeNull()
    expect(parseThingUrl('not a url')).toBeNull()
  })

  it('documents that URL normalisation collapses literal dot-segments', () => {
    // `new URL()` collapses a literal `..` before we look, so this key is
    // harmless and simply misses the resource map. This case tests the WHATWG
    // parser, not our guard — see the next test for the guard itself.
    const p = parseThingUrl('thing://abc/../../etc/passwd')
    expect(p).not.toBeNull()
    expect(p!.path).not.toContain('..')
  })

  it('rejects percent-encoded traversal that survives normalisation (guard is LIVE)', () => {
    // `%2f` is an encoded slash, so the URL parser does NOT treat these as dot
    // segments and does not collapse them. We `decodeURIComponent` AFTER
    // `new URL()`, which turns them into `../` — and the `path.includes('..')`
    // guard is what rejects them. Remove that guard and these return a path;
    // this test is its keeper (finding P1-5 / PR-review 1.1).
    expect(parseThingUrl('thing://abc/att/%2e%2e%2fsecret')).toBeNull()
    expect(parseThingUrl('thing://abc/att/..%2f..%2fetc/passwd')).toBeNull()
    expect(parseThingUrl('thing://abc/%2e%2e%2f%2e%2e%2fpasswd')).toBeNull()
  })

  it('decodes att/ names so the admitted TABLE is the gate, not string shape', () => {
    // These are well-formed and reach the handler; the table lookup on the
    // decoded name is what fails them (an unknown name 404s). parseThingUrl's
    // job here is only to hand the handler the exact decoded name.
    expect(parseThingUrl('thing://abc/att/foo%2Fbar')!.path).toBe('att/foo/bar')
    expect(parseThingUrl('thing://abc/att/poster%20(1).webp')!.path).toBe('att/poster (1).webp')
    // A null byte survives decoding and simply misses the table.
    expect(parseThingUrl('thing://abc/att/foo%00bar')!.path).toBe('att/foo\u0000bar')
  })
})

describe('attachmentUrl', () => {
  it('builds att/ URLs that round-trip through parseThingUrl', () => {
    const url = attachmentUrl('abc', 'poster')
    expect(url).toBe('thing://abc/att/poster')
    expect(parseThingUrl(url)).toEqual({ id: 'abc', path: 'att/poster' })
  })

  it('percent-encodes awkward names and the parser decodes them back', () => {
    const url = attachmentUrl('abc', 'my poster (1).webp')
    const parsed = parseThingUrl(url)
    expect(parsed).not.toBeNull()
    expect(parsed!.path).toBe('att/my poster (1).webp')
  })
})

describe('parseRange', () => {
  it('serves the full body when there is no Range header', () => {
    expect(parseRange(null, 100)).toBeNull()
  })

  it('parses bytes=start-end inclusive', () => {
    expect(parseRange('bytes=0-99', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('parses the open-ended form media elements send (bytes=0-)', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 })
  })

  it('clamps an end past the resource to the last byte', () => {
    expect(parseRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 })
  })

  it('parses suffix ranges (last N bytes)', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 })
  })

  it('flags unsatisfiable ranges for a 416', () => {
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=200-300', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
  })

  it('falls back to the full body on malformed or multi-range headers', () => {
    expect(parseRange('bytes=a-b', 100)).toBeNull()
    expect(parseRange('bytes=0-10,20-30', 100)).toBeNull()
    expect(parseRange('items=0-10', 100)).toBeNull()
    expect(parseRange('bytes=-', 100)).toBeNull()
  })
})

describe('THING_CSP', () => {
  it('kills every network sink and locks the base', () => {
    expect(THING_CSP).toContain("default-src 'none'")
    expect(THING_CSP).toContain("connect-src 'none'")
    expect(THING_CSP).toContain("frame-src 'none'")
    expect(THING_CSP).toContain("base-uri 'none'")
    expect(THING_CSP).toContain("form-action 'none'")
  })
})
