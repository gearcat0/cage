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
  it('ships every sample', () => {
    expect(STARTERS.length).toBe(12)
    expect([...STARTERS].map((s) => s.type).sort()).toEqual([
      'article',
      'attestation',
      'card',
      'comment',
      'contract',
      'invite',
      'invoice',
      'memo',
      'nametag',
      'poster',
      'todo',
      'vouch'
    ])
  })

  it('byte-matches the on-disk sample for every starter', () => {
    for (const s of STARTERS) {
      expect(starterBytes(s), `${s.type} drifted from samples/${s.type}.html`).toEqual(sampleBytes(s.type))
    }
  })

  it('has distinct keys, types, and programs', () => {
    expect(new Set(STARTERS.map((s) => s.key)).size).toBe(12)
    expect(new Set(STARTERS.map((s) => s.type)).size).toBe(12)
    expect(new Set(STARTERS.map((s) => s.html)).size).toBe(12)
  })

  it('resolves by key and rejects unknown keys', () => {
    expect(starterByKey('starter:nametag')?.type).toBe('nametag')
    expect(starterByKey('starter:nope')).toBeNull()
    expect(starterByKey('library:nametag')).toBeNull()
  })

  // The cage paints its view #08080a before a program loads (see #39), so a
  // program with a LIGHT body flashes white every time you switch to it. The
  // invoice shipped with a paper-coloured body and did exactly that. This is
  // cheaper than noticing it again by eye.
  it('every sample has a dark body background, so switching does not flash', () => {
    const DARK = '#1d2320'
    for (const s of STARTERS) {
      const body = /body\s*\{[^}]*\}/.exec(s.html)?.[0] ?? ''
      const declared = /background:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? ''
      // A sample may go through a variable; resolve one level if so.
      const viaVar = /^var\(\s*(--[\w-]+)\s*\)$/.exec(declared)?.[1]
      const resolved = viaVar
        ? (new RegExp(`${viaVar}:\\s*([^;]+)`).exec(s.html)?.[1]?.trim() ?? declared)
        : declared
      expect(resolved.toLowerCase(), `${s.type} has body background "${resolved}", not the dark ${DARK}`).toBe(DARK)
    }
  })

  it('every starter is a self-contained page that uses the bridge', () => {
    for (const s of STARTERS) {
      expect(s.html).toContain('window.bridge.getArgs()')
      expect(s.html).toContain("emit('draft'")
      expect(s.html).not.toContain('src="http') // no external resources (the cage CSP forbids them)
    }
  })
})
