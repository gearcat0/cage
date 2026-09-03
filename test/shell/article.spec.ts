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

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 25_000, what = ''): Promise<T> {
  const site = new Error().stack?.split('\n')[2]?.trim().replace(/^at\s+/, '').slice(0, 90) ?? ''
  const deadline = Date.now() + timeoutMs
  // The FIRST error is the diagnostic one; the last is almost always the
  // teardown ("browser has been closed") overwriting it once the test has
  // already given up.
  let firstError: string | null = null
  let lastError: unknown = null
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch (e) {
      // Keep it: a swallowed exception here is why a timeout reads as an
      // unexplained "undefined" when the real answer was in the error.
      lastError = e
      if (firstError === null) firstError = (e as Error).message
    }
    if (Date.now() > deadline) {
      // NOT `.catch(() => null)`: that reports a FAILED CALL as "nothing is
      // open", and the two demand opposite investigations. Say which it was.
      const diag = await modeState().then(
        (m) => (m === null ? '<main says nothing is open>' : JSON.stringify(m)),
        (e: unknown) => `<could not ask main: ${(e as Error).message?.slice(0, 80)}>`
      )
      throw new Error(
        `poll timed out at ${site}${what ? ` waiting for ${what}` : ''}; last value: ${JSON.stringify(value)}; modeState: ${diag}` +
          (firstError ? `; first error: ${firstError}` : '') +
          (lastError && (lastError as Error).message !== firstError
            ? `; last error: ${(lastError as Error).message}`
            : '')
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

const clickEdit = (id: string): Promise<void> =>
  cageEval(
    `(() => {
      // Uncaught exceptions inside a listener do NOT propagate to .click(), and
      // Electron's console-message may not deliver them at all -- so catch them
      // in the page and report through the probe channel, which is proven to
      // arrive. Installed once per renderer.
      if (!window.__errProbe) {
        window.__errProbe = true
        window.addEventListener('error', function (ev) {
          console.log('[bridge-probe] UNCAUGHT ' + ev.message + ' @' + String(ev.filename || '').slice(-24) + ':' + ev.lineno)
        })
      }
      const b = document.getElementById(${JSON.stringify(id)})
      b.click()
      // Report from inside the cage: that this script ran, on which element,
      // and the page's visibility. An action with no emit after it is either a
      // script that never ran, a throttled hidden renderer, or a handler that
      // did not fire -- and these three lines tell them apart.
      // Did the program's HANDLER run? The block order it leaves behind says so:
      // reordered means the handler ran and the missing emit is the program's
      // own; unchanged means the click never reached a live handler.
      // Each .e-block wrapper is id="block-<i>"; its first control names the
      // block's kind well enough to see a reorder (text vs image vs caption).
      // NOTE: this string is evaluated as plain JS inside the cage -- no TS
      // casts, they are a syntax error there and the whole script throws.
      var blocks = Array.prototype.slice.call(document.querySelectorAll('[id^=block-]'))
        .filter(function (e) { return /^block-\\d+$/.test(e.id) })
      var order = blocks.length + ':' + blocks.map(function (w) {
        var t = w.querySelector('[id^=block-text-]')
        var c = w.querySelector('[id^=block-caption-]')
        return t ? String(t.value).slice(0, 6) : c ? 'IMG' : '?'
      }).join('|')
      console.log(
        '[bridge-probe] clicked=' + ${JSON.stringify(id)} + ' vis=' + document.visibilityState + ' order=' + order
      )
    })()`,
    'edit'
  )

const typeEdit = (id: string, value: string): Promise<void> =>
  cageEval(
    `(() => {
      const i = document.getElementById(${JSON.stringify(id)})
      i.value = ${JSON.stringify(value)}
      i.dispatchEvent(new Event('input'))
      console.log('[bridge-probe] typed=' + ${JSON.stringify(id)} + ' vis=' + document.visibilityState)
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
  await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null, 25_000, 'the draft to open in edit mode')
  await poll(
    () => cageEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'),
    (v) => v,
    25_000,
    'the edit cage to render its form'
  )

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

  const preview = await poll(
    () => shapeOf('preview'),
    (s) => s.imgLoaded === true,
    25_000,
    'the preview to render the picked image'
  )
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
    (s) => JSON.stringify(s.kids) === JSON.stringify(['h2.a-h', 'figure.a-fig.a-fig--left', 'p.a-p']),
    25_000,
    'the preview to reflect the moved image'
  )

  // Publish, and the signed instance renders exactly the same document.
  // (Opened through the __shell hook, so the chrome header was never rendered;
  // publish through the same hook and approve in the real confirm modal.)
  const pending = (await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
    return s.publishDraft() as never
  })) as Record<string, unknown>
  expect(pending.status).toBe('pending')
  await poll(
    () => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`),
    (v) => v,
    25_000,
    'the publish confirm to appear'
  )
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

  // Open the published thing explicitly. Chrome opens it by itself after a
  // publish, but that is fire-and-forget: waiting on it means waiting on a
  // race, and under load the poll below can start while NOTHING is mounted
  // (modeState: null). Ask for what this test wants to look at.
  await shell.openThing(published!.envelopeHash as string)
  await poll(
    modeState,
    (s) => s?.activeMode === 'view' && s.viewWcId !== null,
    25_000,
    'the published article to open in view mode'
  )

  const view = await poll(
    () => shapeOf('view'),
    (s) => s.imgLoaded === true,
    25_000,
    'the published view to render its image'
  )
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

test('provenance metadata renders as a claim, and survives a publish', async () => {
  const types = await shell.knownTypes()
  const article = types.find((t) => t.testKey === 'starter-article')!
  const draftId = (await shell.newDraft(article.key, {
    title: 'The cage holds',
    deck: 'A short summary under the headline',
    authors: ['Ada Lovelace', 'Charles Babbage'],
    publisher: 'The Example Times',
    section: 'World',
    location: 'NAIROBI',
    published: '2026-09-01',
    updated: '2026-09-02',
    retrieved: '2026-09-03',
    sourceUrl: 'https://example.com/a/story',
    archiveUrl: 'https://archive.example/x',
    language: 'en',
    rights: '© Example Times',
    keywords: ['cage', 'format'],
    blocks: [{ kind: 'paragraph', text: 'Body text.' }]
  })).id!
  await shell.openThing(draftId)
  await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null, 25_000, 'the draft to open')
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { setMode: (m: string) => Promise<string> } }).__shell
    await s.setMode('view')
  })
  await poll(modeState, (s) => s?.activeMode === 'view' && s.viewWcId !== null, 25_000, 'view mode')

  const shown = await poll(
    () =>
      cageEval<Record<string, string | null>>(
        `(() => ({
          deck: document.getElementById('view-deck')?.textContent ?? null,
          byline: document.getElementById('view-byline')?.textContent ?? null,
          dateline: document.getElementById('view-dateline')?.textContent ?? null,
          prov: document.getElementById('view-provenance')?.textContent ?? null
        }))()`,
        'view'
      ),
    (v) => v.deck !== null,
    25_000,
    'the masthead to render'
  )
  expect(shown.deck).toBe('A short summary under the headline')
  expect(shown.byline).toBe('Ada Lovelace, Charles Babbage') // authors[] supersedes byline
  expect(shown.dateline).toContain('NAIROBI')
  expect(shown.dateline).toContain('The Example Times')
  // Provenance is presented as a CLAIM, never as verification.
  expect(shown.prov).toContain('https://example.com/a/story')
  expect(shown.prov).toContain('None of it is verified')
  expect(shown.prov).not.toContain('✓')
})

test('a video block plays from its attachment', async () => {
  const types = await shell.knownTypes()
  const article = types.find((t) => t.testKey === 'starter-article')!
  const draftId = (await shell.newDraft(article.key)).id!
  await shell.openThing(draftId)
  await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null, 25_000, 'the draft to open')
  await poll(() => cageEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v, 25_000, 'the form')

  await typeEdit('edit-title', 'With video')
  await clickEdit('add-video')
  await typeEdit('block-caption-0', 'The launch, as it happened')

  // Real bytes through the program's own picker, as the image test does. The
  // clip need not decode: what is under test is that a video BLOCK mounts a
  // <video> pointed at its attachment, served over thing:// with Range.
  await shell.app.evaluate(async (electron, bytes) => {
    const s = (electron.app as unknown as { __shell: { modeState: () => { editWcId: number | null } | null } })
      .__shell.modeState()
    const wc = electron.webContents.fromId(s!.editWcId!)
    await wc!.executeJavaScript(`
      (() => {
        const file = new File([Uint8Array.from(${JSON.stringify(bytes)})], 'clip.mp4', { type: 'video/mp4' })
        const dt = new DataTransfer()
        dt.items.add(file)
        const input = document.getElementById('block-file-0')
        input.files = dt.files
        input.dispatchEvent(new Event('change'))
      })()
    `)
  }, Array.from(new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112, 105, 115, 111, 109])))

  const vid = await poll(
    () =>
      cageEval<{ tag: string | null; src: string | null; controls: boolean } | null>(
        `(() => {
          const v = document.querySelector('#view-article video')
          return v ? { tag: v.tagName, src: v.getAttribute('src'), controls: v.controls } : null
        })()`,
        'preview'
      ),
    (v) => v !== null && v.src !== null,
    25_000,
    'the preview to mount a <video> for the attachment'
  )
  expect(vid!.tag).toBe('VIDEO')
  expect(vid!.src).toContain('/att/vid-1') // its own name space, never reusing img-N
  expect(vid!.controls).toBe(true)
})
