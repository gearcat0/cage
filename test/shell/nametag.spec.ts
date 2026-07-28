import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── The nametag story (samples/nametag.html) ─────────────────────────────────
// The composition convention end-to-end: the PROGRAM supplies its own
// composition UI. The shell signs it blank; opened with no args it shows its
// set mode and emits a publish request; the human approves in trusted chrome;
// the shell signs a NEW standalone instance with the SAME program and the
// draft's args, and it lands in the author's own feed.

const NAMETAG_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

// Run in the mounted thing's page (the live cage webContents).
async function thingEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().startsWith('thing:'))
    if (!wc) throw new Error('no thing webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

// Run in the trusted chrome renderer (drives the REAL confirm modal).
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

const setModeVisible = (): Promise<boolean> => thingEval<boolean>(`!!document.getElementById('name')`)

// lastPublish persists across tests; clear it so a poll can't match stale state.
const resetLastPublish = (): Promise<void> =>
  shell.app.evaluate(async (electron) => {
    ;(electron.app as unknown as { __shell: Record<string, unknown> }).__shell.lastPublish = null
  })

let blankHash = '' // E1: the blank nametag (args: null)
let namedHash = '' // E2: the instance carrying {name: 'Joe Bloggs'}

test('set mode → publish → approve creates a named instance of the same program', async () => {
  const { outcome } = await shell.compose(NAMETAG_HTML.toString('base64'), 'nametag')
  expect(outcome.status).toBe('valid')
  blankHash = outcome.envelopeHash as string

  // Blank args → the program shows its own composition UI (set mode).
  await shell.openThing(blankHash)
  await poll(setModeVisible, (v) => v)

  await thingEval(`
    document.getElementById('name').value = 'Joe Bloggs';
    document.getElementById('save').click();
  `)

  // The request reaches the shell's confirm flow with the draft args visible
  // to the human.
  const confirm = await poll(
    () => shellSurface<{ kind: string; summary: { type: string; args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.kind === 'publish' && c.summary.args?.name === 'Joe Bloggs'
  )
  expect(confirm!.summary.type).toBe('nametag')

  // Approve through the REAL chrome modal.
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  const publish = await poll(
    () => shellSurface<Record<string, unknown> | null>('lastPublish'),
    (p) => p != null && p.status !== undefined
  )
  expect(publish!.status).toBe('valid')

  // The new instance: same author, same PROGRAM (the load-bearing assertion),
  // different envelope.
  const rows = (await shell.feed()) as { envelopeHash: string; type: string; progHash: string; authorKey: string }[]
  const nametags = rows.filter((r) => r.type === 'nametag')
  expect(nametags.length).toBe(2)
  const blankRow = nametags.find((r) => r.envelopeHash === blankHash)!
  const namedRow = nametags.find((r) => r.envelopeHash !== blankHash)!
  expect(namedRow.progHash).toBe(blankRow.progHash)
  const id = await shell.identity()
  expect(namedRow.authorKey).toBe(id.address)
  namedHash = namedRow.envelopeHash

  // Opening the new instance renders VIEW mode: the name, no input.
  await shell.openThing(namedHash)
  const display = await poll(
    () => thingEval<string | null>(`document.getElementById('display')?.textContent ?? null`),
    (t) => t !== null
  )
  expect(display).toBe('Joe Bloggs')
  expect(await setModeVisible()).toBe(false)
})

test('a denied publish is dropped', async () => {
  await shell.openThing(blankHash)
  await poll(setModeVisible, (v) => v)
  const before = (await shell.feed()).length

  await thingEval(`
    document.getElementById('name').value = 'Nobody';
    document.getElementById('save').click();
  `)
  await poll(
    () => shellSurface<{ summary: { args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.summary.args?.name === 'Nobody'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-reject]').click()`)
  await poll(() => shellSurface<Record<string, unknown> | null>('lastPublish'), (p) => p?.status === 'denied')

  // Give a wrongly-approved persist time to land, then assert nothing did.
  await new Promise((r) => setTimeout(r, 600))
  expect((await shell.feed()).length).toBe(before)
})

test('edit mode re-publishes with a changed name', async () => {
  await resetLastPublish()
  await shell.openThing(namedHash)
  await poll(() => thingEval<boolean>(`!!document.getElementById('edit')`), (v) => v)

  await thingEval(`document.getElementById('edit').click()`)
  const prefill = await poll(() => thingEval<string | null>(`document.getElementById('name')?.value ?? null`), (v) => v !== null)
  expect(prefill).toBe('Joe Bloggs')

  await thingEval(`
    document.getElementById('name').value = 'Joan Bloggs';
    document.getElementById('save').click();
  `)
  await poll(
    () => shellSurface<{ summary: { args: { name?: string } } } | null>('lastConfirm'),
    (c) => c?.summary.args?.name === 'Joan Bloggs'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  await poll(() => shellSurface<Record<string, unknown> | null>('lastPublish'), (p) => p?.status === 'valid')

  const rows = (await shell.feed()) as { envelopeHash: string; type: string }[]
  const third = rows.filter((r) => r.type === 'nametag').find((r) => r.envelopeHash !== blankHash && r.envelopeHash !== namedHash)
  expect(third).toBeTruthy()

  await shell.openThing(third!.envelopeHash)
  const display = await poll(
    () => thingEval<string | null>(`document.getElementById('display')?.textContent ?? null`),
    (t) => t !== null
  )
  expect(display).toBe('Joan Bloggs')
})
