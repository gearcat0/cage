import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The news article (samples/article.html) ──────────────────────────────────
// The richest sample: a block document (headings, paragraphs, images with
// captions and float placement, footnotes) whose images ride the draft
// attachment path. Structural edits are batched between preview assertions —
// each preview costs a 600ms debounce plus a renderer spawn.

const PNG = readFileSync(join(__dirname, '..', 'fixtures', 'poster.png'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})
// Block editing chains several debounced preview remounts.
test.beforeEach(() => test.setTimeout(90_000))

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

async function cageEval<T>(js: string, which: 'view' | 'edit' | 'preview'): Promise<T> {
  return shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const id = a.which === 'edit' ? s?.editWcId : a.which === 'preview' ? s?.previewWcId : s?.viewWcId
      if (id == null) throw new Error(`no ${a.which} cage`)
      const wc = electron.webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error('cage gone')
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

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) {
      const diag = await modeState().catch(() => null)
      throw new Error(`poll timed out; last value: ${JSON.stringify(value)}; modeState: ${JSON.stringify(diag)}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

const clickEdit = (id: string): Promise<void> =>
  cageEval(`document.getElementById(${JSON.stringify(id)}).click()`, 'edit')

const typeEdit = (id: string, value: string): Promise<void> =>
  cageEval(
    `(() => {
      const i = document.getElementById(${JSON.stringify(id)})
      i.value = ${JSON.stringify(value)}
      i.dispatchEvent(new Event('input'))
    })()`,
    'edit'
  )

/** The rendered shape of the article in a view-mode cage: block tags in order,
 *  figure classes, footnote wiring. */
const shapeOf = (which: 'view' | 'preview'): Promise<Record<string, unknown>> =>
  cageEval<Record<string, unknown>>(
    `(() => {
      const art = document.getElementById('view-article')
      const kids = Array.from(art.children).map((n) => n.tagName.toLowerCase() + (n.className ? '.' + n.className.split(' ').join('.') : ''))
      const fig = art.querySelector('figure')
      const img = fig && fig.querySelector('img')
      const ref = document.getElementById('fnref-1')
      const note = document.getElementById('fn-1')
      return {
        title: document.getElementById('view-title')?.textContent ?? null,
        byline: document.getElementById('view-byline')?.textContent ?? null,
        kids: kids,
        figClass: fig ? fig.className : null,
        caption: fig ? (fig.querySelector('figcaption')?.textContent ?? null) : null,
        imgLoaded: !!img && img.complete && img.naturalWidth > 0,
        fnHref: ref ? ref.querySelector('a').getAttribute('href') : null,
        noteText: note ? note.textContent.replace(' ↩', '') : null,
        backHref: note ? note.querySelector('a').getAttribute('href') : null
      }
    })()`,
    which
  )

test('an article renders headings, a wrapped image with caption, and footnotes', async () => {
  const types = await shell.knownTypes()
  const article = types.find((t) => t.testKey === 'starter-article')!
  const draftId = (await shell.newDraft(article.key)).id!
  await shell.openThing(draftId)
  await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null)
  await poll(() => cageEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v)

  // Build the document in one burst, then look at the preview once.
  await typeEdit('edit-title', 'The cage holds')
  await typeEdit('edit-byline', 'By a tester')
  await clickEdit('add-heading')
  await typeEdit('block-text-0', 'What happened')
  await clickEdit('add-paragraph')
  await typeEdit('block-text-1', 'A paragraph that should wrap around the picture beside it.')
  await clickEdit('add-image')
  await typeEdit('block-caption-2', 'The observatory at dusk')
  await typeEdit('block-alt-2', 'A domed building against a dark sky')
  await cageEval(
    `(() => {
      const s = document.getElementById('block-placement-2')
      s.value = 'left'
      s.dispatchEvent(new Event('change'))
    })()`,
    'edit'
  )
  await clickEdit('add-footnote')
  await typeEdit('block-text-3', 'Sources close to the matter.')

  // Give the program a real File through its own picker: a native file dialog
  // cannot be driven, but setting input.files via DataTransfer exercises the
  // program's actual change handler (thumbnail, picked bytes, re-emit) rather
  // than bypassing it — an emit injected behind the program's back is simply
  // overwritten by its next one, which correctly reports no image.
  await shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => { editWcId: number | null } | null } })
        .__shell.modeState()
      const wc = electron.webContents.fromId(s!.editWcId!)
      await wc!.executeJavaScript(`
        (() => {
          const bytes = Uint8Array.from(${JSON.stringify(a.png)})
          const file = new File([bytes], 'observatory.png', { type: 'image/png' })
          const dt = new DataTransfer()
          dt.items.add(file)
          const input = document.getElementById('block-file-2')
          input.files = dt.files
          input.dispatchEvent(new Event('change'))
        })()
      `)
    },
    { png: Array.from(PNG) }
  )

  const preview = await poll(() => shapeOf('preview'), (s) => s.imgLoaded === true)
  expect(preview.title).toBe('The cage holds')
  expect(preview.byline).toBe('By a tester')
  // Heading, paragraph, figure — in document order, with the float class.
  expect(preview.kids).toEqual(['h2.a-h', 'p.a-p', 'figure.a-fig.a-fig--left'])
  expect(preview.figClass).toContain('a-fig--left')
  expect(preview.caption).toBe('The observatory at dusk')
  // The footnote marker and its note are wired both ways.
  expect(preview.fnHref).toBe('#fn-1')
  expect(preview.noteText).toBe('Sources close to the matter.')
  expect(preview.backHref).toBe('#fnref-1')

  // Reordering is real: move the image above the paragraph.
  await clickEdit('block-up-2')
  await poll(
    () => shapeOf('preview'),
    (s) => JSON.stringify(s.kids) === JSON.stringify(['h2.a-h', 'figure.a-fig.a-fig--left', 'p.a-p'])
  )

  // Publish, and the signed instance renders exactly the same document.
  // (Opened through the __shell hook, so the chrome header was never rendered;
  // publish through the same hook and approve in the real confirm modal.)
  const pending = (await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
    return s.publishDraft() as never
  })) as Record<string, unknown>
  expect(pending.status).toBe('pending')
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const published = await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
        return s.lastPublish as never
      }) as Promise<Record<string, unknown> | null>,
    (p) => p?.status === 'valid'
  )
  expect(published!.attachments).toEqual(['img-1'])
  expect(await shell.drafts()).toEqual([])

  const view = await poll(() => shapeOf('view'), (s) => s.imgLoaded === true)
  expect(view.title).toBe('The cage holds')
  expect(view.kids).toEqual(['h2.a-h', 'figure.a-fig.a-fig--left', 'p.a-p'])
  expect(view.caption).toBe('The observatory at dusk')
  expect(view.fnHref).toBe('#fn-1')
})

test('a blank article is honest, and hostile args still render', async () => {
  const types = await shell.knownTypes()
  const article = types.find((t) => t.testKey === 'starter-article')!

  // Args a malicious or broken author could ship: wrong types, unknown kind,
  // unknown placement, a named image with no attachment.
  const draftId = (await shell.newDraft(article.key, {
    title: 42,
    byline: null,
    blocks: [
      { kind: 'nonsense', text: 'renders as a paragraph' },
      { kind: 'image', name: 'img-9', caption: 7, alt: null, placement: 'sideways' },
      'not even an object'
    ]
  })).id
  expect(draftId, 'non-string args are still CBOR-able and accepted').toBeTruthy()
  await shell.openThing(draftId!)
  await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null)
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { setMode: (m: string) => Promise<string> } }).__shell
    await s.setMode('view')
  })

  const shape = await poll(() => shapeOf('view'), (s) => s.kids !== undefined)
  expect(shape.title).toBe('Untitled') // 42 is not a string
  expect(shape.byline).toBeNull()
  // unknown kind → paragraph; unknown placement → full width; missing blob →
  // a labelled placeholder rather than a broken image.
  expect(shape.kids).toEqual(['p.a-p', 'figure.a-fig.a-fig--full', 'p.a-p'])
  expect(shape.imgLoaded).toBe(false)
  expect(await cageEval<string | null>(`document.querySelector('.a-fig__missing')?.textContent ?? null`, 'view')).toContain(
    'img-9'
  )
})
