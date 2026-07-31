import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The memo sample (samples/memo.html) ──────────────────────────────────────
// The nametag contract with STRUCTURED state: args {to, from, subject,
// message}. Pins that a multi-field program round-trips through draft →
// preview → publish → mounted instance intact (including line breaks in the
// message body).

const MEMO_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'memo.html'))

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

const setField = (key: 'to' | 'from' | 'subject' | 'message', value: string): Promise<void> =>
  thingEval(
    `
    var i = document.getElementById('edit-${key}');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )

const viewField = (key: string, which: 'view' | 'preview'): Promise<string | null> =>
  thingEval<string | null>(`document.getElementById('view-${key}')?.textContent ?? null`, which)

const MESSAGE = 'Bring your own cage.\nSecond line intact.'

test('memo: multi-field args round-trip through draft, preview, and publish', async () => {
  const { outcome } = await shell.compose(MEMO_HTML.toString('base64'), 'memo')
  expect(outcome.status).toBe('valid')
  const blankHash = outcome.envelopeHash as string

  // View mode of the blank memo: placeholders everywhere.
  await openViaChrome(blankHash)
  const to = await poll(() => viewField('to', 'view'), (t) => t !== null)
  expect(to).toBe('—')
  expect(await viewField('message', 'view')).toBe('—')

  // Edit: fill all four fields (each input streams a draft).
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-to')`, 'edit'), (v) => v)
  await setField('to', 'All staff')
  await setField('from', 'The shell')
  await setField('subject', 'Composition conventions')
  await setField('message', MESSAGE)

  // The preview renders the full structured draft, line breaks intact.
  await poll(() => viewField('message', 'preview'), (t) => t === MESSAGE)
  expect(await viewField('to', 'preview')).toBe('All staff')
  expect(await viewField('from', 'preview')).toBe('The shell')
  expect(await viewField('subject', 'preview')).toBe('Composition conventions')

  // Publish the latest draft via the shell; approve in chrome.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastConfirm: { summary?: { args?: unknown } } | null } })
          .__shell
        return (s.lastConfirm?.summary?.args ?? null) as never
      }) as Promise<Record<string, string> | null>,
    (a) => a?.subject === 'Composition conventions'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)

  // The published instance mounts with every field intact.
  const rows = await poll(
    async () => (await shell.feed()) as { envelopeHash: string; type: string }[],
    (f) => f.filter((r) => r.type === 'memo').length === 2
  )
  const published = rows.find((r) => r.type === 'memo' && r.envelopeHash !== blankHash)!
  await openViaChrome(published.envelopeHash)
  await poll(() => viewField('message', 'view'), (t) => t === MESSAGE)
  expect(await viewField('to', 'view')).toBe('All staff')
  expect(await viewField('from', 'view')).toBe('The shell')
  expect(await viewField('subject', 'view')).toBe('Composition conventions')
})
