import { describe, it, expect } from 'vitest'
import { encode, decode, decodeCanonical, CborError, type CborValue, type CborMap, type CborKey } from '../../src/format/cbor.js'
import { DEFAULT_LIMITS } from '../../src/format/limits.js'

const hex = (s: string): Uint8Array =>
  Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('canonical encode — shortest-form integers', () => {
  const cases: [number | bigint, string][] = [
    [0, '00'],
    [1, '01'],
    [23, '17'],
    [24, '1818'],
    [255, '18ff'],
    [256, '190100'],
    [65535, '19ffff'],
    [65536, '1a00010000'],
    [4294967295, '1affffffff'],
    [4294967296n, '1b0000000100000000'],
    [-1, '20'],
    [-24, '37'],
    [-25, '3818']
  ]
  for (const [v, h] of cases) {
    it(`${v} -> ${h}`, () => {
      expect(toHex(encode(v))).toBe(h)
      expect(decode(hex(h))).toBe(typeof v === 'bigint' && BigInt(Number(v)) === v ? Number(v) : v)
    })
  }
})

describe('canonical map key ordering (RFC 8949 bytewise, not 7049 length-first)', () => {
  it('sorts keys by encoded bytes; short key before long key with same prefix', () => {
    // Keys 1 and 256: encoded 0x01 and 0x190100. 0x01 < 0x19 bytewise.
    const m: CborMap = new Map<CborKey, CborValue>([
      [256, 'b'],
      [1, 'a']
    ]) as CborMap
    const enc = encode(m)
    // a2 (map,2) | 01 ('1') 6161 ('a') | 190100 ('256') 6162 ('b')
    expect(toHex(enc)).toBe('a20161611901006162')
  })

  it('rejects non-canonical key order on decodeCanonical', () => {
    // Map with keys out of order: {2:0, 1:0} encoded literally.
    const nonCanonical = hex('a2' + '0200' + '0100')
    expect(() => decodeCanonical(nonCanonical)).toThrow(CborError)
    // ...but the structural decode still parses it.
    expect(decode(nonCanonical)).toBeInstanceOf(Map)
  })
})

describe('rejections (structural)', () => {
  it('rejects a non-shortest integer via decodeCanonical', () => {
    // 1 encoded as two bytes: 0x1801.
    expect(() => decodeCanonical(hex('1801'))).toThrow(/non-canonical/)
    expect(decode(hex('1801'))).toBe(1) // structurally it is 1
  })

  it('rejects indefinite-length items', () => {
    expect(() => decode(hex('9fff'))).toThrow(/indefinite/) // indefinite array
    expect(() => decode(hex('5f42010243030405ff'))).toThrow(/indefinite/)
  })

  it('rejects tags', () => {
    expect(() => decode(hex('c11a514b67b0'))).toThrow(/tags/) // tag 1 (epoch)
  })

  it('rejects floats', () => {
    expect(() => decode(hex('fb3ff199999999999a'))).toThrow(/float/) // 1.1 double
    expect(() => decode(hex('f93c00'))).toThrow(/float/) // half 1.0
  })

  it('rejects undefined', () => {
    expect(() => decode(hex('f7'))).toThrow(/undefined/)
  })

  it('rejects duplicate map keys', () => {
    expect(() => decode(hex('a201000100'))).toThrow(/duplicate/) // {1:0, 1:0}
    expect(() => decode(hex('a201000200'))).not.toThrow() // {1:0, 2:0} distinct
  })

  it('rejects trailing bytes', () => {
    expect(() => decode(hex('0000'))).toThrow(/trailing/)
  })

  it('rejects invalid UTF-8 in text strings', () => {
    // text string, len 2, bytes 0xff 0xfe (invalid utf-8)
    expect(() => decode(hex('62fffe'))).toThrow(/UTF-8/)
  })
})

describe('limits', () => {
  it('enforces max depth', () => {
    // Nest arrays deeper than maxDepth.
    let h = '00'
    for (let i = 0; i < DEFAULT_LIMITS.maxDepth + 2; i++) h = '81' + h
    expect(() => decode(hex(h))).toThrow(/depth/)
  })

  it('enforces max entries on arrays/maps', () => {
    const limits = { ...DEFAULT_LIMITS, maxEntries: 3 }
    // array of length 4: 84 00 00 00 00
    expect(() => decode(hex('8400000000'), limits)).toThrow(/too large/)
  })

  it('enforces max string length', () => {
    const limits = { ...DEFAULT_LIMITS, maxStringBytes: 2 }
    // byte string length 3
    expect(() => decode(hex('43000000'), limits)).toThrow(/max length/)
  })
})

describe('round-trip', () => {
  it('round-trips nested structures canonically', () => {
    const v: CborValue = new Map<CborKey, CborValue>([
      [1, 1],
      [2, Uint8Array.from([1, 2, 3])],
      [3, 'hello'],
      [4, [1, 2, [3, 4]]],
      [5, new Map<CborKey, CborValue>([['a', true], ['b', null]])]
    ]) as CborMap
    const enc = encode(v)
    const dec = decodeCanonical(enc)
    expect(encode(dec)).toEqual(enc)
  })

  it('NFC: non-NFC text is rejected by decodeCanonical', () => {
    const nfc = '\u00e9' // 'é' precomposed (NFC, U+00E9)
    const nfd = '\u0065\u0301' // 'e' + combining acute (NFD) — same glyph
    // The encoder normalizes to NFC; decoding those bytes back is canonical.
    const enc = encode(nfd)
    expect(decodeCanonical(enc)).toBe(nfc)
    // Hand-build a text string carrying the NFD bytes; it must be rejected.
    const nfdBytes = new TextEncoder().encode(nfd) // 3 bytes: 65 cc 81
    const nonCanonical = Uint8Array.from([0x60 | nfdBytes.length, ...nfdBytes])
    expect(() => decodeCanonical(nonCanonical)).toThrow(/non-canonical/)
  })
})
