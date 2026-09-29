import { describe, it, expect } from 'vitest'
import { UpdateService, notesText, type Updater, type UpdatePref, type UpdateState } from '../../src/shell/update/index.js'

/** A fake electron-updater that counts what it was asked to do. */
function fakeUpdater(result: Awaited<ReturnType<Updater['checkForUpdates']>> | Error) {
  const calls = { check: 0, download: 0, install: 0, created: 0 }
  const handlers: Record<string, (x: never) => void> = {}
  const updater: Updater = {
    async checkForUpdates() {
      calls.check++
      if (result instanceof Error) throw result
      return result
    },
    async downloadUpdate() {
      calls.download++
      handlers['download-progress']?.({ percent: 50 } as never)
      return []
    },
    quitAndInstall() {
      calls.install++
    },
    on(event: string, cb: (x: never) => void) {
      handlers[event] = cb
      return updater
    }
  }
  return { updater, calls }
}

function harness(opts: { pref?: UpdatePref; canInstall?: boolean; result?: Parameters<typeof fakeUpdater>[0] } = {}) {
  let pref: UpdatePref = opts.pref ?? 'ask'
  const f = fakeUpdater(
    'result' in opts
      ? opts.result!
      : { isUpdateAvailable: true, updateInfo: { version: '9.9.9', releaseNotes: '<p>Fixes</p>' } }
  )
  const timers: { fn: () => void; ms: number }[] = []
  const states: UpdateState[] = []
  const svc = new UpdateService({
    createUpdater: async () => {
      f.calls.created++
      return f.updater
    },
    getPref: () => pref,
    setPref: (p) => {
      pref = p
    },
    canInstall: opts.canInstall ?? true,
    onState: (s) => states.push(s),
    now: () => 1000,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number])
      if (i >= 0) timers.splice(i, 1)
    }
  })
  return { svc, calls: f.calls, timers, states, pref: () => pref }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('UpdateService: consent', () => {
  it('schedules nothing and loads no updater while the answer is ask or off', async () => {
    for (const pref of ['ask', 'off'] as const) {
      const h = harness({ pref })
      h.svc.start()
      expect(h.timers).toHaveLength(0)
      await h.svc.check({ manual: false })
      expect(h.calls.created).toBe(0)
      expect(h.calls.check).toBe(0)
    }
  })

  it('always runs a manual check, whatever the setting', async () => {
    const h = harness({ pref: 'off' })
    const s = await h.svc.check({ manual: true })
    expect(h.calls.check).toBe(1)
    expect(s).toMatchObject({ phase: 'available', version: '9.9.9', notes: 'Fixes' })
  })

  it('checks right away when turned on, then daily', async () => {
    const h = harness({ pref: 'ask' })
    h.svc.setPref('on')
    await flush()
    expect(h.pref()).toBe('on')
    expect(h.calls.check).toBe(1)
    expect(h.timers.map((t) => t.ms)).toEqual([24 * 60 * 60 * 1000])
  })

  it('starts with one delayed check when already on', async () => {
    const h = harness({ pref: 'on' })
    h.svc.start()
    expect(h.timers.map((t) => t.ms)).toEqual([30_000])
    expect(h.calls.check).toBe(0)
    h.timers[0].fn()
    await flush()
    expect(h.calls.check).toBe(1)
  })

  it('turning checks off cancels the pending one', () => {
    const h = harness({ pref: 'on' })
    h.svc.start()
    h.svc.setPref('off')
    expect(h.timers).toHaveLength(0)
  })
})

describe('UpdateService: finding is not downloading', () => {
  it('downloads nothing on its own, and only when asked', async () => {
    const h = harness({ pref: 'on' })
    await h.svc.check({ manual: false })
    expect(h.calls.download).toBe(0)
    const s = await h.svc.download()
    expect(h.calls.download).toBe(1)
    expect(s).toEqual({ phase: 'ready', version: '9.9.9' })
    expect(h.states).toContainEqual({ phase: 'downloading', version: '9.9.9', percent: 50 })
    expect(h.svc.install()).toBe(true)
    expect(h.calls.install).toBe(1)
  })

  it('will not install before a download finished', async () => {
    const h = harness()
    await h.svc.check({ manual: true })
    expect(h.svc.install()).toBe(false)
    expect(h.calls.install).toBe(0)
  })

  it('never downloads where it cannot install (a .deb)', async () => {
    const h = harness({ canInstall: false })
    const found = await h.svc.check({ manual: true })
    expect(found).toMatchObject({ phase: 'available', canInstall: false })
    await h.svc.download()
    expect(h.calls.download).toBe(0)
  })
})

describe('UpdateService: outcomes', () => {
  it('reports current when nothing newer is published', async () => {
    const h = harness({ result: { isUpdateAvailable: false, updateInfo: { version: '0.1.0' } } })
    expect(await h.svc.check({ manual: true })).toEqual({ phase: 'current', checkedAt: 1000 })
  })

  it('reports inactive when the build cannot update itself', async () => {
    const h = harness({ result: null })
    expect(await h.svc.check({ manual: true })).toEqual({ phase: 'inactive' })
  })

  it('reports an error rather than throwing', async () => {
    const h = harness({ result: new Error('offline') })
    expect(await h.svc.check({ manual: true })).toEqual({ phase: 'error', message: 'offline' })
  })
})

describe('notesText', () => {
  it('reduces release-note HTML to text the chrome can show as text', () => {
    expect(notesText('<h2>Fixes</h2><ul><li>One &amp; two</li><li><a href="x">link</a></li></ul>')).toBe(
      'Fixes\n• One & two\n• link'
    )
  })

  it('handles the array form and caps the length', () => {
    expect(notesText([{ version: '1', note: 'a' }, { version: '2', note: 'b' }])).toBe('a\n\nb')
    expect(notesText('x'.repeat(5000))).toHaveLength(4001)
    expect(notesText(undefined)).toBe('')
  })
})
