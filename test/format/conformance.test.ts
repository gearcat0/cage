import { describe, it, expect } from 'vitest'
import { formatTarget, loadVectors, runAll, type Result } from '../../src/conformance/index.js'

// The reference implementation MUST pass its own conformance suite. This is both
// a self-consistency proof (the committed vectors describe exactly what the code
// does) and a regression guard (any behavioural drift flips a vector). A second
// implementation runs this same `runAll` over the same committed vectors.

const results: Result[] = runAll(formatTarget, loadVectors())

describe('conformance vectors — @yourproject/format', () => {
  it('the suite is non-empty across every category', () => {
    const categories = new Set(results.map((r) => r.category))
    expect(categories).toEqual(new Set(['canonical', 'hashing', 'envelopes', 'bundles', 'chain', 'sealed', 'limits']))
    expect(results.length).toBeGreaterThan(30)
  })

  for (const r of results) {
    it(`${r.category}: ${r.name}`, () => {
      expect(r.ok, r.detail).toBe(true)
    })
  }
})
