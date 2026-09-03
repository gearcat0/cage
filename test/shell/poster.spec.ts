import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The poster sample (samples/poster.html) ──────────────────────────────────
// The draft contract with an ATTACHMENT. Pins the two blob value forms end to
// end: fresh bytes with a REAL mime ({bytes, mime: 'image/png'} — served with
// nosniff, so the mime must survive or the <img> breaks) and {carry: true}
// ("keep my current image", resolved shell-side — a program cannot read its
// own attachment bytes back).

const POSTER_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'poster.html'))
const PNG = readFileSync(join(__dirname, '..', 'fixtures', 'poster.png'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

type ModeState = {
  activeMode: 'view' | 'edit'
  viewWcId: number | null
  editWcId: number | null
  previewWcId: number | null
} | null

const modeState = (): Promise<ModeState> =>
  shell.app.evaluate(
    async (electron) =>
      (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState() as never
  )

async function thingEval<T>(js: string, which: 'view' | 'edit' | 'preview' = 'view'): Promise<T> {
  return shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const id = a.which === 'edit' ? s?.editWcId : a.which === 'preview' ? s?.previewWcId : s?.viewWcId
      if (id == null) throw new Error(`no ${a.which} cage`)
      const wc = electron.webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error('cage wc gone')
      return (await wc.executeJavaScript(a.js)) as never
    },
    { which, js }
  )
}

async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* not ready yet — retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function openViaChrome(envelopeHash: string): Promise<void> {
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(envelopeHash)})`)
  await poll(modeState, (s) => s != null && s.viewWcId !== null && s.activeMode === 'view')
}

async function switchMode(mode: 'view' | 'edit'): Promise<void> {
  await chromeEval(`document.querySelector('[data-testid=mode-${mode}]').click()`)
  await poll(modeState, (s) => s?.activeMode === mode)
}

async function approvePublish(): Promise<void> {
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
}

/** The rendered image state in a cage: loaded means the bytes AND the mime
 *  survived (attachments are served with nosniff). */
const imageState = (which: 'view' | 'edit' | 'preview'): Promise<{ present: boolean; loaded: boolean }> =>
  thingEval<{ present: boolean; loaded: boolean }>(
    `(() => {
      const img = document.getElementById('poster-image')
      return { present: !!img, loaded: !!img && img.complete && img.naturalWidth > 0 }
    })()`,
    which
  )

const setTitle = (value: string): Promise<void> =>
  thingEval(
    `
    var i = document.getElementById('edit-title');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )

let publishedHash = '' // the poster instance carrying the PNG

test('fresh image bytes flow through draft, preview, and publish with their mime intact', async () => {
  const { outcome } = await shell.compose(POSTER_HTML.toString('base64'), 'poster')
  expect(outcome.status).toBe('valid')
  const blankHash = outcome.envelopeHash as string

  // Blank poster: view shows the empty frame.
  await openViaChrome(blankHash)
  await poll(() => thingEval<boolean>(`!!document.getElementById('poster-empty')`, 'view'), (v) => v)

  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v)
  await setTitle('Cage Night')

  // "Pick" the PNG: hand the bytes to the program's draft stream the same way
  // its file handler would (a native file dialog cannot be driven from here).
  await shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => { editWcId: number | null } | null } })
        .__shell.modeState()
      const wc = electron.webContents.fromId(s!.editWcId!)
      await wc!.executeJavaScript(`
        window.bridge.emit('draft', {
          type: 'poster',
          args: { title: 'Cage Night', caption: 'One night only' },
          blobs: { image: { bytes: Uint8Array.from(${JSON.stringify(a.png)}), mime: 'image/png' } }
        })
      `)
    },
    // A plain number array: a Buffer does not survive evaluate serialization
    // intact (it arrives as a plain object, and Array.from(object) is []).
    { png: Array.from(PNG) }
  )

  // The preview mounts with the image ATTACHED and RENDERING (mime survived).
  await poll(() => imageState('preview'), (s) => s.present && s.loaded)
  expect(await thingEval<string | null>(`document.getElementById('view-title')?.textContent ?? null`, 'preview')).toBe(
    'Cage Night'
  )

  // Publish; the outcome lists the attachment; the mounted instance renders it.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await approvePublish()
  const publish = await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        return ((electron.app as unknown as { __shell: { lastPublish: unknown } }).__shell.lastPublish ?? null) as never
      }) as Promise<Record<string, unknown> | null>,
    (p) => p?.status === 'valid'
  )
  expect(publish!.attachments).toEqual(['image'])
  publishedHash = (
    (await shell.feed()) as { envelopeHash: string; type: string }[]
  ).find((r) => r.type === 'poster' && r.envelopeHash !== blankHash)!.envelopeHash

  await openViaChrome(publishedHash)
  await poll(() => imageState('view'), (s) => s.present && s.loaded)
})

test('carry-over: editing keeps the current image without resending bytes', async () => {
  // The published poster is open. Enter edit: the program's initial draft
  // declares {carry: true} for the image it can display but cannot read.
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v)
  await setTitle('Cage Night — encore')

  // The preview carries the image (resolved shell-side) AND the new title.
  await poll(() => imageState('preview'), (s) => s.present && s.loaded)
  await poll(
    () => thingEval<string | null>(`document.getElementById('view-title')?.textContent ?? null`, 'preview'),
    (t) => t === 'Cage Night — encore'
  )

  // Publish the carried draft; the new instance still has the attachment.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await approvePublish()
  const rows = await poll(
    async () => (await shell.feed()) as { envelopeHash: string; type: string }[],
    (f) => f.filter((r) => r.type === 'poster').length === 3
  )
  // The feed is newest-received-first: the encore is the newest poster row.
  const newest = rows.filter((r) => r.type === 'poster')[0]!
  await openViaChrome(newest.envelopeHash)
  await poll(() => imageState('view'), (s) => s.present && s.loaded)
  expect(await thingEval<string | null>(`document.getElementById('view-title')?.textContent ?? null`, 'view')).toBe(
    'Cage Night — encore'
  )
})

test('photo arrangements follow the count, and older single-image posters still render', async () => {
  const types = await shell.knownTypes()
  const poster = types.find((t) => t.testKey === 'starter-poster')!

  /** The rendered set: which arrangement class, how many tiles, any "+N". */
  const setShape = (): Promise<{ cls: string | null; tiles: number; more: string | null; count: string | null }> =>
    thingEval(
      `(() => {
        const s = document.getElementById('poster-set')
        return {
          cls: s ? s.className : null,
          tiles: document.querySelectorAll('.p-tile').length,
          more: document.getElementById('poster-more')?.textContent ?? null,
          count: s ? s.getAttribute('data-count') : null
        }
      })()`,
      'view'
    )

  const openWith = async (args: Record<string, unknown>): Promise<void> => {
    const id = (await shell.newDraft(poster.key, args)).id!
    await shell.openThing(id)
    await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null)
    await shell.app.evaluate(async (electron) => {
      const s = (electron.app as unknown as { __shell: { setMode: (m: string) => Promise<string> } }).__shell
      await s.setMode('view')
    })
    await poll(modeState, (s) => s?.activeMode === 'view' && s.viewWcId !== null)
  }

  const photos = (n: number): { name: string; alt: string; caption: string }[] =>
    Array.from({ length: n }, (_, i) => ({ name: `photo-${i + 1}`, alt: '', caption: '' }))

  // Auto follows the count, the way a photo post does.
  for (const [n, cls] of [
    [1, 'p-set--n1'],
    [2, 'p-set--n2'],
    [3, 'p-set--n3'],
    [4, 'p-set--n4']
  ] as [number, string][]) {
    await openWith({ title: 'Set', layout: 'auto', photos: photos(n) })
    const shape = await poll(setShape, (s) => s.tiles === n, 20_000)
    expect(shape.cls, `${n} photos`).toContain(cls)
    expect(shape.more).toBeNull()
  }

  // Past four: show four and say how many more, rather than shrink them all.
  await openWith({ title: 'Many', layout: 'auto', photos: photos(7) })
  const many = await poll(setShape, (s) => s.tiles === 4, 20_000)
  expect(many.cls).toContain('p-set--n4')
  expect(many.more).toBe('+3')
  expect(many.count).toBe('7')

  // An explicit arrangement overrides the count-based one.
  await openWith({ title: 'Row', layout: 'row', photos: photos(3) })
  expect((await poll(setShape, (s) => s.tiles === 3, 20_000)).cls).toContain('p-set--row')

  // A poster from before this program held several photos: no photos[] at all.
  // It must still render, and its single picture keeps the id others know.
  const { outcome } = await shell.compose(POSTER_HTML.toString('base64'), 'poster', [
    { name: 'image', base64: PNG.toString('base64'), mime: 'image/png' }
  ])
  expect(outcome.status).toBe('valid')
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(outcome.envelopeHash)})`)
  await poll(modeState, (s) => s?.activeMode === 'view' && s.viewWcId !== null)
  expect(
    await poll(
      () => thingEval<boolean>(`!!document.getElementById('poster-image')`, 'view'),
      (v) => v,
      20_000
    )
  ).toBe(true)
})
