import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STARTERS, starterByKey, starterBytes } from '../../src/shell/starters/index.js'

// The starters are inlined at build time from samples/*.html. These assertions
// are what keep samples/ the single source of truth: if someone edits a sample
// (or checks in a divergent copy), the bytes stop matching and the starter's
// program hash would no longer equal the one the sample specs produce.

const sampleBytes = (type: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '..', '..', 'samples', `${type}.html`)))

describe('starters', () => {
  it('ships all six samples', () => {
    expect(STARTERS.length).toBe(6)
    expect([...STARTERS].map((s) => s.type).sort()).toEqual(['card', 'invite', 'memo', 'nametag', 'poster', 'todo'])
  })

  it('byte-matches the on-disk sample for every starter', () => {
    for (const s of STARTERS) {
      expect(starterBytes(s), `${s.type} drifted from samples/${s.type}.html`).toEqual(sampleBytes(s.type))
    }
  })

  it('has distinct keys, types, and programs', () => {
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(6)
    expect(new Set(STARTERS.map((s) => s.type)).size).toBe(6)
    expect(new Set(STARTERS.map((s) => s.html)).size).toBe(6)
  })

  it('resolves by key and rejects unknown keys', () => {
    expect(starterByKey('starter:nametag')?.type).toBe('nametag')
    expect(starterByKey('starter:nope')).toBeNull()
    expect(starterByKey('library:nametag')).toBeNull()
  })

  it('every starter is a self-contained page that uses the bridge', () => {
    for (const s of STARTERS) {
      expect(s.html).toContain('window.bridge.getArgs()')
      expect(s.html).toContain("emit('draft'")
      expect(s.html).not.toContain('src="http') // no external resources (the cage CSP forbids them)
    }
  })
})
