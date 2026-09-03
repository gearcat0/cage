import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The todo sample (samples/todo.html) ──────────────────────────────────────
// ARRAY state through the draft contract: args {title, items: [{text, done}]}.
// Pins that arrays of objects survive draft → preview → publish → mount (the
// CBOR seam: JS arrays/objects → canonical CBOR → plain JS again), and that
// list edits (add / retext / toggle / remove) stream correctly.

const TODO_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'todo.html'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})

// List editing chains several 600ms-debounced preview remounts, each spawning
// a renderer; on a loaded CI runner that legitimately exceeds the 30s default.
// More budget, not less coverage — a real hang still fails, just later.
test.beforeEach(() => test.setTimeout(90_000))
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
    }
    if (Date.now() > deadline) {
      // The cage state machine, so a CI timeout says WHICH way it was stuck
      // (no open thing / no preview / preview mid-mount / preview crashed).
      // NOT `.catch(() => null)`: that reports a FAILED CALL as "nothing is
      // open", and the two demand opposite investigations. Say which it was.
      const diag = await modeState().then(
        (m) => (m === null ? '<main says nothing is open>' : JSON.stringify(m)),
        (e: unknown) => `<could not ask main: ${(e as Error).message?.slice(0, 80)}>`
      )
      throw new Error(
        `poll timed out; last value: ${JSON.stringify(value)}; modeState: ${diag}` +
          (lastError ? `; last error: ${(lastError as Error).message}` : '')
      )
    }
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

const editClick = (id: string): Promise<void> => thingEval(`document.getElementById(${JSON.stringify(id)}).click()`, 'edit')

const editType = (id: string, value: string): Promise<void> =>
  thingEval(
    `
    var i = document.getElementById(${JSON.stringify(id)});
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )

const countIn = (which: 'view' | 'preview'): Promise<string | null> =>
  thingEval<string | null>(`document.getElementById('view-count')?.textContent ?? null`, which)

/** Snapshot of the rendered list in a view-mode cage. */
const listIn = (which: 'view' | 'preview'): Promise<{ text: string; done: boolean }[]> =>
  thingEval<{ text: string; done: boolean }[]>(
    `Array.from(document.querySelectorAll('#view-items li')).map((li) => ({
      text: li.querySelector('.text').textContent,
      done: li.classList.contains('done')
    }))`,
    which
  )

test('array args: add, retext, toggle, remove — preview and published instance carry the list', async () => {
  const { outcome } = await shell.compose(TODO_HTML.toString('base64'), 'todo')
  expect(outcome.status).toBe('valid')
  const blankHash = outcome.envelopeHash as string

  // Blank list: view placeholder.
  await openViaChrome(blankHash)
  await poll(() => thingEval<boolean>(`!!document.getElementById('view-empty')`, 'view'), (v) => v)
  expect(await countIn('view')).toBe('0 of 0 done')

  // Build the list in edit mode.
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v)
  await editType('edit-title', 'Chores')
  await editClick('add-item')
  await editType('item-text-0', 'Feed the cat')
  await editClick('add-item')
  await editType('item-text-1', 'Water plants')
  await editClick('item-done-1') // toggle done (fires change)

  // The preview renders the array state.
  await poll(() => countIn('preview'), (c) => c === '1 of 2 done')
  expect(await listIn('preview')).toEqual([
    { text: 'Feed the cat', done: false },
    { text: 'Water plants', done: true }
  ])

  // Remove works too: add a third, delete it, preview returns to two.
  await editClick('add-item')
  await editType('item-text-2', 'Oops')
  await poll(() => countIn('preview'), (c) => c === '1 of 3 done')
  await editClick('item-del-2')
  await poll(() => countIn('preview'), (c) => c === '1 of 2 done')

  // Publish; the mounted instance carries the array intact through CBOR.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const rows = await poll(
    async () => (await shell.feed()) as { envelopeHash: string; type: string }[],
    (f) => f.filter((r) => r.type === 'todo').length === 2
  )
  const published = rows.filter((r) => r.type === 'todo')[0]! // newest first
  await openViaChrome(published.envelopeHash)
  await poll(() => countIn('view'), (c) => c === '1 of 2 done')
  expect(await thingEval<string | null>(`document.getElementById('view-title')?.textContent ?? null`, 'view')).toBe(
    'Chores'
  )
  expect(await listIn('view')).toEqual([
    { text: 'Feed the cat', done: false },
    { text: 'Water plants', done: true }
  ])
})

test('editing a published list starts from its items', async () => {
  // The published list is open from the previous test.
  await switchMode('edit')
  await poll(() => thingEval<string | null>(`document.getElementById('item-text-0')?.value ?? null`, 'edit'), (v) => v === 'Feed the cat')
  expect(await thingEval<boolean>(`document.getElementById('item-done-1').checked`, 'edit')).toBe(true)

  // Check off the remaining item — the preview reflects the full array.
  await editClick('item-done-0')
  await poll(() => countIn('preview'), (c) => c === '2 of 2 done')
})
