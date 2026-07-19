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

  it('neutralises path traversal (URL normalises dot-segments; no fs behind it)', () => {
    // `new URL()` collapses `..` before we look, so the key is harmless and
    // simply misses the in-memory blob map. Either way, nothing escapes.
    const p = parseThingUrl('thing://abc/../../etc/passwd')
    expect(p).not.toBeNull()
    expect(p!.path).not.toContain('..')
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
