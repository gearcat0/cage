import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The invitation sample (samples/invite.html) ──────────────────────────────
// Scalars + viewerInfo(): the event date is STORED as ISO and RENDERED in the
// viewer's locale. Pins that the stored arg stays ISO through publish while
// the view shows a locale-formatted date (never the raw ISO).

const INVITE_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'invite.html'))

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

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
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

test('invitation: ISO date stored, locale date rendered; fields round-trip', async () => {
  const { outcome } = await shell.compose(INVITE_HTML.toString('base64'), 'invite')
  expect(outcome.status).toBe('valid')
  const blankHash = outcome.envelopeHash as string

  await openViaChrome(blankHash)
  const title = await poll(() => textOf('view-title', 'view'), (t) => t !== null)
  expect(title).toBe('—')
  expect(await thingEval<boolean>(`!!document.getElementById('view-date')`, 'view')).toBe(false)

  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit-title')`, 'edit'), (v) => v)
  await setField('title', 'Cage Warming')
  await setField('host', 'The Shell Collective')
  await setField('date', '2027-06-05')
  await setField('time', '19:30')
  await setField('location', 'The Old Observatory')
  await setField('details', 'Bring a thing.\nNo network required.')

  // The preview renders a LOCALE date — not the raw ISO — from the stored arg.
  const previewDate = await poll(() => textOf('view-date', 'preview'), (t) => t !== null)
  expect(previewDate).not.toBe('2027-06-05')
  expect(previewDate).toContain('2027')
  // It matches what the page itself would format for its viewerInfo locale —
  // asserted inside the preview cage so the expectation is locale-correct.
  expect(
    await thingEval<boolean>(
      `(() => {
        const vi = window.bridge.viewerInfo()
        const expected = new Intl.DateTimeFormat(vi.locale || undefined, {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        }).format(new Date('2027-06-05T00:00:00'))
        return document.getElementById('view-date').textContent === expected
      })()`,
      'preview'
    )
  ).toBe(true)
  expect(await textOf('view-host', 'preview')).toBe('hosted by The Shell Collective')

  // Publish; the mounted instance still STORES ISO (checked via its edit
  // prefill) and renders the locale date.
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const rows = await poll(
    async () => (await shell.feed()) as { envelopeHash: string; type: string }[],
    (f) => f.filter((r) => r.type === 'invite').length === 2
  )
  const published = rows.filter((r) => r.type === 'invite')[0]!
  await openViaChrome(published.envelopeHash)
  await poll(() => textOf('view-title', 'view'), (t) => t === 'Cage Warming')
  expect(await textOf('view-date', 'view')).toContain('2027')
  expect(await textOf('view-date', 'view')).not.toBe('2027-06-05')
  expect(await textOf('view-time', 'view')).toBe('19:30')
  expect(await textOf('view-details', 'view')).toBe('Bring a thing.\nNo network required.')

  await switchMode('edit')
  await poll(
    () => thingEval<string | null>(`document.getElementById('edit-date')?.value ?? null`, 'edit'),
    (v) => v === '2027-06-05' // the STORED arg is ISO, presentation-free
  )
})
