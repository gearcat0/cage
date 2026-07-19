import { describe, it, expect } from 'vitest'
import { THING_WEB_PREFERENCES, thingPartition } from '../../src/main/cage.js'

// Static guards for the Layer 1 flags (finding P0-1). NO behavioral test can
// catch a refactor that drops `sandbox: true` or flips `contextIsolation`,
// because every behavioral test passes with those off — the OS sandbox and
// context isolation defend against exploit/leak vectors the suite does not
// fire. A static assertion on the exact options object is the only guard.

describe('THING_WEB_PREFERENCES (Layer 1 flags)', () => {
  it('sets every hardening flag to its safe value', () => {
    expect(THING_WEB_PREFERENCES.sandbox).toBe(true)
    expect(THING_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(THING_WEB_PREFERENCES.nodeIntegration).toBe(false)
    expect(THING_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false)
    expect(THING_WEB_PREFERENCES.webSecurity).toBe(true)
    expect(THING_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false)
    expect(THING_WEB_PREFERENCES.experimentalFeatures).toBe(false)
    expect(THING_WEB_PREFERENCES.webviewTag).toBe(false)
    expect(THING_WEB_PREFERENCES.navigateOnDragDrop).toBe(false)
  })

  it('does not silently gain a dangerous flag', () => {
    // If someone adds e.g. `nodeIntegration: true` under a different key, this
    // fails loudly. The set of keys is the surface; pin it.
    expect(Object.keys(THING_WEB_PREFERENCES).sort()).toEqual([
      'allowRunningInsecureContent',
      'contextIsolation',
      'experimentalFeatures',
      'nodeIntegration',
      'nodeIntegrationInSubFrames',
      'navigateOnDragDrop',
      'sandbox',
      'spellcheck',
      'v8CacheOptions',
      'webSecurity',
      'webviewTag'
    ].sort())
  })
})

describe('thingPartition', () => {
  it('is per-thing and NON-persistent (no persist: prefix)', () => {
    const p = thingPartition('abc-123')
    expect(p).toBe('thing-abc-123')
    // A `persist:`-prefixed partition would let a thing read another's storage
    // breadcrumbs — a tracking channel that must be impossible.
    expect(p.startsWith('persist:')).toBe(false)
  })

  it('gives different ids different partitions', () => {
    expect(thingPartition('a')).not.toBe(thingPartition('b'))
  })
})
