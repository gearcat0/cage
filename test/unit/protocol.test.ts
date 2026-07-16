import { describe, it, expect } from 'vitest'
import { parseThingUrl, THING_CSP } from '../../src/main/protocol.js'

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

describe('THING_CSP', () => {
  it('kills every network sink and locks the base', () => {
    expect(THING_CSP).toContain("default-src 'none'")
    expect(THING_CSP).toContain("connect-src 'none'")
    expect(THING_CSP).toContain("frame-src 'none'")
    expect(THING_CSP).toContain("base-uri 'none'")
    expect(THING_CSP).toContain("form-action 'none'")
  })
})
