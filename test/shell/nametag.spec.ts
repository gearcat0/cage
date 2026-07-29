import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The nametag story (samples/nametag.html) ─────────────────────────────────
// The composition convention end-to-end, with SHELL-owned mode switching: the
// program supplies both UIs and renders whichever mode getArgs().mode says;
// the View|Edit control lives in the trusted chrome header. Opening a thing
// always lands in VIEW (final form). The edit cage mounts lazily and stays
// alive hidden, so in-progress edits survive toggling.

const NAMETAG_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

type ModeState = { activeMode: 'view' | 'edit'; viewWcId: number | null; editWcId: number | null } | null

const modeState = (): Promise<ModeState> =>
  shell.app.evaluate(
    async (electron) =>
      (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState() as never
  )

// Run in a specific cage of the open thing (two `thing:` webContents can
// exist — one per mode — so URL-matching is ambiguous; target by wcId).
async function thingEval<T>(js: string, which: 'view' | 'edit' = 'view'): Promise<T> {
  return shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const id = a.which === 'edit' ? s?.editWcId : s?.viewWcId
      if (id == null) throw new Error(`no ${a.which} cage`)
      const wc = electron.webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error('cage wc gone')
      return (await wc.executeJavaScript(a.js)) as never
    },
    { which, js }
  )
}

// Run in the trusted chrome renderer (drives the REAL header toggle + modals).
async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

async function shellSurface<T>(field: 'lastConfirm' | 'lastPublish'): Promise<T> {
  return shell.app.evaluate(async (electron, f) => {
    const s = (electron.app as unknown as { __shell: Record<string, unknown> }).__shell
    return s[f] as never
  }, field)
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* not ready yet (page still loading, element absent) — retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

// lastPublish persists across tests; clear it so a poll can't match stale state.
const resetLastPublish = (): Promise<void> =>
  shell.app.evaluate(async (electron) => {
    ;(electron.app as unknown as { __shell: Record<string, unknown> }).__shell.lastPublish = null
  })

/** Open through the REAL chrome path — renders the trust header including the
 *  mode toggle (the __shell.open hook alone would leave the header stale). */
async function openViaChrome(envelopeHash: string): Promise<void> {
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(envelopeHash)})`)
  await poll(modeState, (s) => s != null && s.viewWcId !== null && s.activeMode === 'view')
}

/** Switch mode through the REAL chrome toggle; wait for main to confirm. */
async function switchMode(mode: 'view' | 'edit'): Promise<void> {
  await chromeEval(`document.querySelector('[data-testid=mode-${mode}]').click()`)
  await poll(modeState, (s) => s?.activeMode === mode)
}

const displayText = (which: 'view' | 'edit' = 'view'): Promise<string | null> =>
  thingEval<string | null>(`document.getElementById('display')?.textContent ?? null`, which)

// Visibility of every live cage view. While a publish confirm is pending both
// must be hidden: the modal lives in chrome pixels, and the cage views are
// native siblings composited ABOVE the chrome — they would overpaint it.
const cageVisibility = (): Promise<boolean[]> =>
  shell.app.evaluate(async (electron) => {
    const thingWcs = electron.webContents
      .getAllWebContents()
      .filter((w) => !w.isDestroyed() && w.getURL().startsWith('thing:'))
    const win = electron.BaseWindow.getAllWindows()[0]!
    return win.contentView.children
      .filter((v) => thingWcs.includes((v as Electron.WebContentsView).webContents))
      .map((v) => v.getVisible()) as never
  })

let blankHash = '' // E1: the blank nametag (args: null)
let namedHash = '' // E2: the instance carrying {name: 'Joe Bloggs'}

test('opens in view, edit mode publishes, approval creates a named instance of the same program', async () => {
  const { outcome } = await shell.compose(NAMETAG_HTML.toString('base64'), 'nametag')
  expect(outcome.status).toBe('valid')
  blankHash = outcome.envelopeHash as string

  // Always lands in VIEW: the blank tag renders its placeholder, no edit UI.
  await openViaChrome(blankHash)
  const placeholder = await poll(() => displayText('view'), (t) => t !== null)
  expect(placeholder).toBe('—')
  expect(await thingEval<boolean>(`!!document.getElementById('name')`, 'view')).toBe(false)

  // The shell's toggle — not the program — enters edit mode.
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)
  await thingEval(
    `
    document.getElementById('name').value = 'Joe Bloggs';
    document.getElementById('save').click();
  `,
    'edit'
  )

  const confirm = await poll(
    () => shellSurface<{ kind: string; summary: { type: string; args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.kind === 'publish' && c.summary.args?.name === 'Joe Bloggs'
  )
  expect(confirm!.summary.type).toBe('nametag')

  // The decision modal must actually be seeable: with a confirm pending, every
  // cage view is hidden (they would otherwise overpaint the chrome's modal).
  expect((await cageVisibility()).every((v) => !v)).toBe(true)

  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const publish = await poll(
    () => shellSurface<Record<string, unknown> | null>('lastPublish'),
    (p) => p != null && p.status !== undefined
  )
  expect(publish!.status).toBe('valid')
  // Decision made — the active cage comes back.
  await poll(cageVisibility, (vs) => vs.some(Boolean))

  // The new instance: same author, same PROGRAM, different envelope.
  const rows = (await shell.feed()) as { envelopeHash: string; type: string; progHash: string; authorKey: string }[]
  const nametags = rows.filter((r) => r.type === 'nametag')
  expect(nametags.length).toBe(2)
  const blankRow = nametags.find((r) => r.envelopeHash === blankHash)!
  const namedRow = nametags.find((r) => r.envelopeHash !== blankHash)!
  expect(namedRow.progHash).toBe(blankRow.progHash)
  const id = await shell.identity()
  expect(namedRow.authorKey).toBe(id.address)
  namedHash = namedRow.envelopeHash

  // Opening the new instance: VIEW mode with the name; no edit cage yet.
  await openViaChrome(namedHash)
  const display = await poll(() => displayText('view'), (t) => t !== null && t !== '—')
  expect(display).toBe('Joe Bloggs')
  expect(await thingEval<boolean>(`!!document.getElementById('name')`, 'view')).toBe(false)
  expect((await modeState())!.editWcId).toBeNull()
})

test('a denied publish is dropped', async () => {
  await resetLastPublish()
  await openViaChrome(blankHash)
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)
  const before = (await shell.feed()).length

  await thingEval(
    `
    document.getElementById('name').value = 'Nobody';
    document.getElementById('save').click();
  `,
    'edit'
  )
  await poll(
    () => shellSurface<{ summary: { args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.summary.args?.name === 'Nobody'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-reject]').click()`)
  await poll(() => shellSurface<Record<string, unknown> | null>('lastPublish'), (p) => p?.status === 'denied')
  // Deny restores the cages too.
  await poll(cageVisibility, (vs) => vs.some(Boolean))

  // Give a wrongly-approved persist time to land, then assert nothing did.
  await new Promise((r) => setTimeout(r, 600))
  expect((await shell.feed()).length).toBe(before)
})

test('edit mode re-publishes with a changed name', async () => {
  await resetLastPublish()
  await openViaChrome(namedHash)
  await switchMode('edit')
  const prefill = await poll(
    () => thingEval<string | null>(`document.getElementById('name')?.value ?? null`, 'edit'),
    (v) => v !== null
  )
  expect(prefill).toBe('Joe Bloggs')

  await thingEval(
    `
    document.getElementById('name').value = 'Joan Bloggs';
    document.getElementById('save').click();
  `,
    'edit'
  )
  await poll(
    () => shellSurface<{ summary: { args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.summary.args?.name === 'Joan Bloggs'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  await poll(() => shellSurface<Record<string, unknown> | null>('lastPublish'), (p) => p?.status === 'valid')

  const rows = (await shell.feed()) as { envelopeHash: string; type: string }[]
  const third = rows
    .filter((r) => r.type === 'nametag')
    .find((r) => r.envelopeHash !== blankHash && r.envelopeHash !== namedHash)
  expect(third).toBeTruthy()

  await openViaChrome(third!.envelopeHash)
  const display = await poll(() => displayText('view'), (t) => t !== null && t !== '—')
  expect(display).toBe('Joan Bloggs')
})

test('in-progress edits survive toggling between view and edit', async () => {
  await openViaChrome(blankHash)
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)
  await thingEval(`document.getElementById('name').value = 'draft text'`, 'edit')

  // Toggle away: the edit cage stays alive (hidden), its DOM intact.
  await switchMode('view')
  expect((await modeState())!.activeMode).toBe('view')
  expect(await thingEval<string>(`document.getElementById('name').value`, 'edit')).toBe('draft text')

  // Toggle back: same cage, same unsaved input.
  await switchMode('edit')
  expect(await thingEval<string>(`document.getElementById('name').value`, 'edit')).toBe('draft text')
})
