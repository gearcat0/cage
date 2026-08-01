import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The contact-card sample (samples/card.html) ──────────────────────────────
// Pure scalars: args {name, role, org, email, phone, url}. Pins the field
// round trip through draft → preview → publish → mount, and the view rule
// that only SET fields render (a real card has no empty labels).

const CARD_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'card.html'))

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

const setField = (key: string, value: string): Promise<void> =>
  thingEval(
    `
    var i = document.getElementById('edit-${key}');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )

const textOf = (id: string, which: 'view' | 'preview'): Promise<string | null> =>
  thingEval<string | null>(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`, which)

test('card fields round-trip; only set fields render in view', async () => {
  const { outcome } = await shell.compose(CARD_HTML.toString('base64'), 'card')
  expect(outcome.status).toBe('valid')
  const blankHash = outcome.envelopeHash as string

  // Blank card: name placeholder, no role line, no contact rows.
  await openViaChrome(blankHash)
  const name = await poll(() => textOf('view-name', 'view'), (t) => t !== null)
  expect(name).toBe('—')
  expect(await thingEval<boolean>(`!!document.getElementById('view-role')`, 'view')).toBe(false)
  expect(await thingEval<number>(`document.querySelectorAll('#view-rows .row').length`, 'view')).toBe(0)

  // Fill everything except the phone.
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-name')`, 'edit'), (v) => v)
  await setField('name', 'Ada Lovelace')
  await setField('role', 'Analyst')
  await setField('org', 'Analytical Engines Ltd')
  await setField('email', 'ada@example.org')
  await setField('url', 'ada.example.org')

  // Preview: full card, phone row absent (unset fields do not render).
  await poll(() => textOf('view-name', 'preview'), (t) => t === 'Ada Lovelace')
  expect(await textOf('view-role', 'preview')).toBe('Analyst · Analytical Engines Ltd')
  await poll(() => thingEval<boolean>(`!!document.getElementById('view-email')`, 'preview'), (v) => v)
  expect(await thingEval<boolean>(`!!document.getElementById('view-phone')`, 'preview')).toBe(false)
  expect(await thingEval<boolean>(`!!document.getElementById('view-url')`, 'preview')).toBe(true)

  // Publish; the mounted instance carries the fields.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const rows = await poll(
    async () => (await shell.feed()) as { envelopeHash: string; type: string }[],
    (f) => f.filter((r) => r.type === 'card').length === 2
  )
  const published = rows.filter((r) => r.type === 'card')[0]! // newest first
  await openViaChrome(published.envelopeHash)
  await poll(() => textOf('view-name', 'view'), (t) => t === 'Ada Lovelace')
  expect(await textOf('view-role', 'view')).toBe('Analyst · Analytical Engines Ltd')
  expect(await thingEval<boolean>(`!!document.getElementById('view-phone')`, 'view')).toBe(false)
  // Editing the published card starts from its fields.
  await switchMode('edit')
  await poll(() => thingEval<string | null>(`document.getElementById('edit-name')?.value ?? null`, 'edit'), (v) => v === 'Ada Lovelace')
  expect(await thingEval<string>(`document.getElementById('edit-phone').value`, 'edit')).toBe('')
})
