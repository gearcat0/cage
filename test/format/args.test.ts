import { describe, it, expect } from 'vitest'
import { jsToCbor, cborToJs, ArgsError } from '../../src/format/args.js'
import { encode, decodeCanonical, type CborMap } from '../../src/format/cbor.js'

describe('jsToCbor', () => {
  it('round-trips a nametag-shaped object through canonical CBOR', () => {
    const args = { name: 'Joe Bloggs' }
    const decoded = decodeCanonical(encode(jsToCbor(args)))
    expect(cborToJs(decoded)).toEqual(args)
  })

  it('round-trips nested objects, arrays, and scalars', () => {
    const args = {
      title: 'card',
      count: 3,
      big: 9223372036854775807n,
      on: true,
      empty: null,
      tags: ['a', 'b', { deep: [1, 2] }],
      raw: Uint8Array.from([1, 2, 3])
    }
    const decoded = decodeCanonical(encode(jsToCbor(args)))
    expect(cborToJs(decoded)).toEqual(args)
  })

  it('maps plain objects to Maps with undefined values skipped', () => {
    const m = jsToCbor({ a: 1, b: undefined, c: 'x' }) as CborMap
    expect(m).toBeInstanceOf(Map)
    expect([...m.keys()]).toEqual(['a', 'c'])
  })

  it('maps top-level undefined to null', () => {
    expect(jsToCbor(undefined)).toBeNull()
    expect(jsToCbor(null)).toBeNull()
  })

  it('rejects floats, NaN, Infinity, and -0', () => {
    expect(() => jsToCbor(1.5)).toThrow(ArgsError)
    expect(() => jsToCbor({ x: NaN })).toThrow(/non-integer/)
    expect(() => jsToCbor([Infinity])).toThrow(/non-integer/)
    expect(() => jsToCbor(-0)).toThrow(/negative zero/)
  })

  it('rejects non-data values', () => {
    expect(() => jsToCbor(() => 0)).toThrow(ArgsError)
    expect(() => jsToCbor(Symbol('s'))).toThrow(ArgsError)
    expect(() => jsToCbor(new Date(0))).toThrow(/plain objects/)
    expect(() => jsToCbor({ x: new Map() })).toThrow(/plain objects/)
  })
})

describe('cborToJs', () => {
  it('converts CborMaps to plain objects, stringifying non-string keys', () => {
    const m: CborMap = new Map()
    m.set('name', 'Joe')
    m.set(1, 'one')
    m.set(Uint8Array.from([0xab]), 'bytes')
    expect(cborToJs(m)).toEqual({ name: 'Joe', '1': 'one', ab: 'bytes' })
  })

  it('throws on key collision after string conversion', () => {
    const m: CborMap = new Map()
    m.set('1', 'text')
    m.set(1, 'number')
    expect(() => cborToJs(m)).toThrow(/duplicate key/)
  })

  it('passes scalars and Uint8Array through', () => {
    expect(cborToJs('x')).toBe('x')
    expect(cborToJs(7)).toBe(7)
    expect(cborToJs(true)).toBe(true)
    expect(cborToJs(null)).toBeNull()
    const b = Uint8Array.from([9])
    expect(cborToJs(b)).toBe(b)
  })
})
