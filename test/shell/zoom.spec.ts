import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Lockstep zoom ────────────────────────────────────────────────────────────
// Ctrl +/−/0 must scale the trusted chrome and the cage content TOGETHER —
// per-webContents zoom scaled them independently and could never resize the
// app as a whole. With shell-owned view/edit modes there can be TWO cages of
// the open thing; BOTH must track the app-level zoom (the hidden one too, so
// it is right-scaled when revealed), and the native cage rects must follow
// the chrome's zoomed CSS pixels or the panes drift out of alignment.

const NAMETAG_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

interface ZoomState {
  chromeZoom: number
  thingZooms: number[]
  cageXs: number[]
}

async function state(): Promise<ZoomState> {
  return shell.app.evaluate(async (electron) => {
    const wcs = electron.webContents.getAllWebContents().filter((w) => !w.isDestroyed())
    const chrome = wcs.find((w) => w.getURL().includes('shell/chrome'))!
    const things = wcs.filter((w) => w.getURL().startsWith('thing:'))
    const win = electron.BaseWindow.getAllWindows()[0]!
    const views = win.contentView.children.filter((v) =>
      things.includes((v as Electron.WebContentsView).webContents)
    ) as Electron.WebContentsView[]
    return {
      chromeZoom: chrome.getZoomFactor(),
      thingZooms: things.map((t) => t.getZoomFactor()),
      cageXs: views.map((v) => v.getBounds().x)
    } as never
  })
}

// REAL input through the pipeline (sendInputEvent raises before-input-event);
// a page-synthesized KeyboardEvent would not. The thing target is the ACTIVE
// cage — a hidden view does not take real focused input.
async function sendZoomKey(target: 'chrome' | 'thing', keyCode: '+' | '-' | '0'): Promise<void> {
  await shell.app.evaluate(
    async (electron, a) => {
      const app = electron.app as unknown as {
        __shell: { modeState: () => { activeMode: string; viewWcId: number | null; editWcId: number | null } | null }
      }
      let wc: Electron.WebContents | undefined
      if (a.target === 'thing') {
        const s = app.__shell.modeState()
        const id = s?.activeMode === 'edit' ? s.editWcId : s?.viewWcId
        wc = id != null ? (electron.webContents.fromId(id) ?? undefined) : undefined
      } else {
        wc = electron.webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
      }
      if (!wc) throw new Error(`no ${a.target} webContents`)
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers: ['control'] })
    },
    { target, keyCode }
  )
  await new Promise((r) => setTimeout(r, 300))
}

function expectLockstep(s: ZoomState, factor: number, baseX: number): void {
  expect(s.chromeZoom).toBeCloseTo(factor)
  expect(s.thingZooms.length).toBe(2)
  for (const z of s.thingZooms) expect(z).toBeCloseTo(factor)
  for (const x of s.cageXs) expect(x).toBe(Math.round(baseX * factor))
}

test('Ctrl +/−/0 zooms chrome and BOTH cages in lockstep, from either view', async () => {
  const { outcome } = await shell.compose(NAMETAG_HTML.toString('base64'), 'nametag')
  expect(outcome.status).toBe('valid')
  await shell.openThing(outcome.envelopeHash as string)
  // Materialize the edit cage too, then return to view: both must track zoom.
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { setMode: (m: string) => Promise<string> } }).__shell
    await s.setMode('edit')
    await s.setMode('view')
  })
  await new Promise((r) => setTimeout(r, 500))

  const base = await state()
  expect(base.thingZooms.length).toBe(2)
  const baseX = base.cageXs[0]!
  expectLockstep(base, 1, baseX)

  // Zoom in from the CHROME: both cages + both native rects scale.
  await sendZoomKey('chrome', '+')
  expectLockstep(await state(), 1.2, baseX)

  // Zoom in again from the (visible) THING: still lockstep.
  await sendZoomKey('thing', '+')
  expectLockstep(await state(), 1.44, baseX)

  // Ctrl+0 resets everything.
  await sendZoomKey('thing', '0')
  expectLockstep(await state(), 1, baseX)

  // Zoom out below 1 works too.
  await sendZoomKey('chrome', '-')
  const out = await state()
  expect(out.chromeZoom).toBeCloseTo(1 / 1.2)
  for (const z of out.thingZooms) expect(z).toBeCloseTo(1 / 1.2)
  await sendZoomKey('chrome', '0')
})
