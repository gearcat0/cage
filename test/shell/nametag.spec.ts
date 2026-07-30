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

// Run in a specific cage of the open thing (two `thing:` webContents can
// exist — one per mode — so URL-matching is ambiguous; target by wcId).
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

const displayText = (which: 'view' | 'edit' | 'preview' = 'view'): Promise<string | null> =>
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

// Type into the edit cage through the page's own input event — the program
// streams its working state on the "draft" channel on every input.
const typeName = (value: string): Promise<void> =>
  thingEval(
    `
    var i = document.getElementById('name');
    i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )

const publishEnabled = (): Promise<boolean> =>
  chromeEval<boolean>(`!document.querySelector('[data-testid=header-publish]').disabled`)

/** Publish via the SHELL: wait until the preview reflects the draft (so the
 *  latest draft is known-arrived), then click the chrome Publish button. */
async function clickPublish(expectedName: string): Promise<void> {
  await poll(() => displayText('preview'), (t) => t === expectedName)
  await chromeEval(`document.querySelector('[data-testid=header-publish]').click()`)
}

test('opens in view, edit mode publishes, approval creates a named instance of the same program', async () => {
  const { outcome } = await shell.compose(NAMETAG_HTML.toString('base64'), 'nametag')
  expect(outcome.status).toBe('valid')
  blankHash = outcome.envelopeHash as string

  // Always lands in VIEW: the blank tag renders its placeholder, no edit UI,
  // and NOTHING to publish (no draft yet) — the Publish button is disabled.
  await openViaChrome(blankHash)
  const placeholder = await poll(() => displayText('view'), (t) => t !== null)
  expect(placeholder).toBe('—')
  expect(await thingEval<boolean>(`!!document.getElementById('name')`, 'view')).toBe(false)
  expect(await publishEnabled()).toBe(false)

  // The shell's toggle — not the program — enters edit mode. The program
  // streams its initial draft on load, which ENABLES Publish (this is how the
  // chrome detects the program supports the edit contract at all).
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)
  await poll(publishEnabled, (v) => v)

  await typeName('Joe Bloggs')
  await clickPublish('Joe Bloggs')

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

  await typeName('Nobody')
  await clickPublish('Nobody')
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

  await typeName('Joan Bloggs')
  await clickPublish('Joan Bloggs')
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

test('live preview: view mode shows the unpublished draft in final form', async () => {
  await openViaChrome(blankHash)
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)

  // Control positions BEFORE the badge swap — they must not move when the
  // wider preview badge replaces "✓ signed" (fixed status slot).
  const buttonX = (): Promise<{ view: number; publish: number }> =>
    chromeEval(`({
      view: document.querySelector('[data-testid=mode-view]').getBoundingClientRect().x,
      publish: document.querySelector('[data-testid=header-publish]').getBoundingClientRect().x
    })`)
  const beforeSwap = await buttonX()

  // Type through the page's own input event — the program streams its
  // working state on the "draft" channel as you type. (An initial-state
  // preview may mount first; wait for the TYPED draft's preview.)
  await typeName('Previewed')
  await poll(() => displayText('preview'), (t) => t === 'Previewed')

  // View mode now shows the DRAFT rendered in final form...
  await switchMode('view')
  expect(await displayText('preview')).toBe('Previewed')
  // ...and the View/Edit/Publish controls have NOT moved despite the badge swap.
  expect(await buttonX()).toEqual(beforeSwap)
  // ...while the signed instance underneath is untouched (blank placeholder).
  expect(await thingEval<string | null>(`document.getElementById('display')?.textContent ?? null`, 'view')).toBe('—')

  // The preview cage is the visible one; the signed view stays hidden.
  const vis = await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
    const win = electron.BaseWindow.getAllWindows()[0]!
    const visOf = (id: number | null | undefined): boolean | null => {
      if (id == null) return null
      const v = win.contentView.children.find((c) => (c as Electron.WebContentsView).webContents?.id === id)
      return v ? v.getVisible() : null
    }
    return { view: visOf(s?.viewWcId), preview: visOf(s?.previewWcId) } as never
  }) as { view: boolean | null; preview: boolean | null }
  expect(vis).toEqual({ view: false, preview: true })

  // The trust badge must not sit above unsigned draft content: chrome swaps
  // "✓ signed" for the preview badge.
  const badges = await chromeEval<{ preview: string; trust: string }>(`({
    preview: document.querySelector('[data-testid=preview-badge]').style.visibility,
    trust: document.querySelector('[data-trust=verified]').style.visibility
  })`)
  expect(badges.preview).toBe('visible')
  expect(badges.trust).toBe('hidden')

  // Further edits keep streaming — even while view mode is showing: the edit
  // cage is alive underneath and its drafts remount the preview.
  await typeName('Previewed Again')
  await poll(() => displayText('preview'), (t) => t === 'Previewed Again')

  // Dedupe: re-emitting an IDENTICAL draft must NOT remount the preview
  // (remounts are visible flicker).
  const stableId = (await modeState())!.previewWcId
  await typeName('Previewed Again')
  await new Promise((r) => setTimeout(r, 900)) // past the debounce window
  expect((await modeState())!.previewWcId).toBe(stableId)
})

test('live preview works when editing an EXISTING instance, without stealing focus', async () => {
  const focusedId = (): Promise<number | null> =>
    shell.app.evaluate(async (electron) => (electron.webContents.getFocusedWebContents()?.id ?? null) as never)

  await openViaChrome(namedHash)
  await switchMode('edit')
  await poll(() => thingEval<boolean>(`!!document.getElementById('name')`, 'edit'), (v) => v)

  // Switching to edit hands the edit cage keyboard focus.
  const editWcId = (await modeState())!.editWcId
  await poll(focusedId, (id) => id === editWcId)

  // Type — drafts stream and previews remount UNDER the typing user.
  await thingEval(
    `
    var i = document.getElementById('name');
    i.value = 'Josephine';
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )
  await poll(modeState, (s) => s?.previewWcId != null)
  // The remount must not steal focus from the edit cage (typing was unusable
  // when every keystroke's preview grabbed the keyboard).
  await poll(focusedId, (id) => id === editWcId)

  // A SECOND remount (fresh preview cage): focus still with the edit cage.
  const firstPreview = (await modeState())!.previewWcId
  await thingEval(
    `
    var i = document.getElementById('name');
    i.value = 'Josephine II';
    i.dispatchEvent(new Event('input'));
  `,
    'edit'
  )
  await poll(modeState, (s) => s?.previewWcId != null && s.previewWcId !== firstPreview)
  await poll(focusedId, (id) => id === editWcId)

  // REAL keystrokes, spread across several preview remounts: every character
  // must land (this is exactly the "focus lost constantly while typing" bug).
  await thingEval(`var i = document.getElementById('name'); i.value = ''; i.focus();`, 'edit')
  for (const ch of 'Real Name') {
    await shell.app.evaluate(
      async (electron, a) => {
        const wc = electron.webContents.fromId(a.id)
        if (!wc || wc.isDestroyed()) throw new Error('edit cage gone')
        wc.sendInputEvent({ type: 'char', keyCode: a.ch })
      },
      { id: editWcId!, ch }
    )
    await new Promise((r) => setTimeout(r, 90))
  }
  expect(await thingEval<string>(`document.getElementById('name').value`, 'edit')).toBe('Real Name')
  await poll(focusedId, (id) => id === editWcId)

  // And the preview really is the draft of the EXISTING instance's edit.
  await switchMode('view')
  await poll(
    () => thingEval<string | null>(`document.getElementById('display')?.textContent ?? null`, 'preview'),
    (v) => v === 'Real Name'
  )
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
