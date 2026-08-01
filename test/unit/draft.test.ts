import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { DEFAULT_DRAFT_CAPS, validBlobName, validateDraft } from '../../src/main/draft.js'

const caps = {
  ...DEFAULT_DRAFT_CAPS,
  maxBlobBytes: 1024,
  maxTotalBlobBytes: 2048,
  maxBlobCount: 4,
  maxArgsBytes: 512
}

describe('validateDraft', () => {
  it('accepts a valid draft and assembles the attachment table', () => {
    const bytes = new TextEncoder().encode('<svg/>')
    const r = validateDraft({ type: 'event', args: { a: 1 }, blobs: { poster: bytes } }, caps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.type).toBe('event')
    expect(r.draft.args).toEqual({ a: 1 })
    expect(r.draft.att.poster).toEqual({
      h: createHash('sha256').update(bytes).digest('hex'),
      m: 'application/octet-stream',
      n: bytes.length
    })
    expect(r.blobBytes).toBe(bytes.length)
  })

  it('accepts a draft with no blobs', () => {
    const r = validateDraft({ type: 'note', args: 'hello' }, caps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.att).toEqual({})
  })

  it('rejects non-object payloads', () => {
    for (const bad of [null, undefined, 'x', 42, [1]]) {
      const r = validateDraft(bad, caps)
      expect(r.ok).toBe(false)
    }
  })

  it('rejects a missing, empty, or oversized type', () => {
    expect(validateDraft({ args: {} }, caps).ok).toBe(false)
    expect(validateDraft({ type: '', args: {} }, caps).ok).toBe(false)
    expect(validateDraft({ type: 'x'.repeat(caps.maxTypeLen + 1), args: {} }, caps).ok).toBe(false)
  })

  it('rejects missing or unserialisable args', () => {
    expect(validateDraft({ type: 'event' }, caps).ok).toBe(false)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(validateDraft({ type: 'event', args: cyclic }, caps).ok).toBe(false)
  })

  it('rejects oversized args', () => {
    const r = validateDraft({ type: 'event', args: 'x'.repeat(caps.maxArgsBytes + 1) }, caps)
    expect(r.ok).toBe(false)
  })

  it('rejects unknown top-level keys (the contract must not drift)', () => {
    const r = validateDraft({ type: 'event', args: {}, author: 'me' }, caps)
    expect(r.ok).toBe(false)
  })

  it('rejects non-Uint8Array blob values', () => {
    const r = validateDraft({ type: 'event', args: {}, blobs: { x: 'str' } }, caps)
    expect(r.ok).toBe(false)
  })

  it('enforces the per-blob cap', () => {
    const r = validateDraft(
      { type: 'event', args: {}, blobs: { big: new Uint8Array(caps.maxBlobBytes + 1) } },
      caps
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('too large')
  })

  it('enforces the TOTAL cap even when every blob is individually small', () => {
    // Three blobs of 1024 sum to 3072 > 2048: the P0-3 pattern.
    const blobs = { a: new Uint8Array(1024), b: new Uint8Array(1024), c: new Uint8Array(1024) }
    const r = validateDraft({ type: 'event', args: {}, blobs }, caps)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('total blob bytes')
  })

  it('enforces the blob-count cap', () => {
    const blobs: Record<string, Uint8Array> = {}
    for (let i = 0; i <= caps.maxBlobCount; i++) blobs[`b${i}`] = new Uint8Array(1)
    const r = validateDraft({ type: 'event', args: {}, blobs }, caps)
    expect(r.ok).toBe(false)
  })

  it('rejects blob names that could not round-trip as att/ URL segments', () => {
    for (const name of ['', 'a/b', 'a\\b', '..', 'a..b', 'a\tb', 'a\u0000b', 'x'.repeat(300)]) {
      const r = validateDraft({ type: 'event', args: {}, blobs: { [name]: new Uint8Array(1) } }, caps)
      expect(r.ok, `name ${JSON.stringify(name)} should be rejected`).toBe(false)
    }
  })
})

describe('validBlobName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['poster', 'poster.webp', 'my poster (1)', 'ünïcode']) {
      expect(validBlobName(name, 255), name).toBe(true)
    }
  })
})

describe('validateDraft — blob value forms', () => {
  const caps = {
    ...DEFAULT_DRAFT_CAPS,
    maxBlobBytes: 1024,
    maxTotalBlobBytes: 2048,
    maxBlobCount: 4,
    maxArgsBytes: 512
  }

  it('accepts { bytes, mime } and records the mime in the att table', () => {
    const bytes = new TextEncoder().encode('png-ish')
    const r = validateDraft({ type: 'poster', args: null, blobs: { image: { bytes, mime: 'image/png' } } }, caps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.att.image.m).toBe('image/png')
    expect(r.draft.blobs.image).toBe(bytes)
    expect(r.draft.carry).toEqual([])
  })

  it('accepts { carry: true } and lists the name for shell-side resolution', () => {
    const r = validateDraft({ type: 'poster', args: null, blobs: { image: { carry: true } } }, caps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.draft.carry).toEqual(['image'])
    expect(r.draft.att.image).toBeUndefined()
    expect(r.blobBytes).toBe(0)
  })

  it('rejects malformed mimes, extra carry keys, and junk values', () => {
    const bytes = new Uint8Array([1])
    for (const blob of [
      { bytes, mime: 'not a mime' },
      { bytes, mime: 'image/png; charset=x' },
      { bytes, mime: 'x'.repeat(200) + '/y' },
      { carry: true, bytes },
      { carry: 1 },
      { bytesish: bytes },
      'text',
      42
    ]) {
      const r = validateDraft({ type: 'poster', args: null, blobs: { image: blob } }, caps)
      expect(r.ok).toBe(false)
    }
  })

  it('counts carry names toward the blob-count cap', () => {
    const blobs: Record<string, unknown> = {}
    for (let i = 0; i < 5; i++) blobs[`b${i}`] = { carry: true }
    const r = validateDraft({ type: 'poster', args: null, blobs }, caps)
    expect(r.ok).toBe(false)
  })
})
