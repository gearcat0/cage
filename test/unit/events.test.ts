import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cage, record, recordTestEmit } from '../../src/main/events.js'

// The event log survives into the real shell, so its boundedness is a
// production property, not test scaffolding. These pin the ring-buffer math
// (finding P0-3) deterministically — the Playwright flood test proves the same
// under a real flood, but timing there is fuzzy; here it is exact.

const MAX_EVENTS = 2000 // must match events.ts

beforeEach(() => {
  cage.events.length = 0
  cage.dropped = 0
  cage.testEmits.length = 0
})

describe('record (ring buffer)', () => {
  it('keeps at most MAX_EVENTS and counts what it evicts', () => {
    for (let i = 0; i < MAX_EVENTS + 500; i++) {
      record({ type: 'blocked-request', url: `http://x/${i}` })
    }
    expect(cage.events.length).toBe(MAX_EVENTS)
    expect(cage.dropped).toBe(500)
    // The survivors are the most recent, not the oldest.
    const last = cage.events[cage.events.length - 1]
    expect(last.type === 'blocked-request' && last.url).toBe(`http://x/${MAX_EVENTS + 499}`)
  })

  it('does not evict below the cap', () => {
    for (let i = 0; i < 10; i++) record({ type: 'blocked-request', url: `http://x/${i}` })
    expect(cage.events.length).toBe(10)
    expect(cage.dropped).toBe(0)
  })
})

describe('recordTestEmit (test-only capture)', () => {
  const orig = process.env.CAGE_TEST_CAPTURE

  afterEach(() => {
    if (orig === undefined) delete process.env.CAGE_TEST_CAPTURE
    else process.env.CAGE_TEST_CAPTURE = orig
  })

  it('is inert unless CAGE_TEST_CAPTURE=1', () => {
    delete process.env.CAGE_TEST_CAPTURE
    recordTestEmit('done', { ok: true }, 20)
    expect(cage.testEmits.length).toBe(0)
  })

  it('captures small payloads when enabled', () => {
    process.env.CAGE_TEST_CAPTURE = '1'
    recordTestEmit('done', { ok: true }, 20)
    expect(cage.testEmits).toEqual([{ channel: 'done', data: { ok: true } }])
  })

  it('replaces oversized payloads with a placeholder (bounded per-entry bytes)', () => {
    process.env.CAGE_TEST_CAPTURE = '1'
    recordTestEmit('spam', { chunk: 'A'.repeat(200 * 1024) }, 200 * 1024)
    expect(cage.testEmits[0].data).toBe('[payload too large to capture]')
  })

  it('is bounded in entry count', () => {
    process.env.CAGE_TEST_CAPTURE = '1'
    for (let i = 0; i < 4096 + 100; i++) recordTestEmit('spam', i, 8)
    expect(cage.testEmits.length).toBe(4096)
  })
})
