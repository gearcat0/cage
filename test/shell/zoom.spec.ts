import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Lockstep zoom ────────────────────────────────────────────────────────────
// Ctrl +/−/0 must scale the trusted chrome and the cage content TOGETHER —
// per-webContents zoom scaled them independently and could never resize the
// app as a whole. The native cage rect must follow the chrome's zoomed CSS
// pixels or the panes drift out of alignment.

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
  thingZoom: number
  cageX: number
}

async function state(): Promise<ZoomState> {
  return shell.app.evaluate(async (electron) => {
    const wcs = electron.webContents.getAllWebContents().filter((w) => !w.isDestroyed())
    const chrome = wcs.find((w) => w.getURL().includes('shell/chrome'))!
    const thing = wcs.find((w) => w.getURL().startsWith('thing:'))!
    const win = electron.BaseWindow.getAllWindows()[0]!
    const cageView = win.contentView.children.find(
      (v) => (v as Electron.WebContentsView).webContents === thing
    ) as Electron.WebContentsView
    return { chromeZoom: chrome.getZoomFactor(), thingZoom: thing.getZoomFactor(), cageX: cageView.getBounds().x } as never
  })
}

// REAL input through the pipeline (sendInputEvent raises before-input-event);
// a page-synthesized KeyboardEvent would not.
async function sendZoomKey(target: 'chrome' | 'thing', keyCode: '+' | '-' | '0'): Promise<void> {
  await shell.app.evaluate(
    async (electron, a) => {
      const wcs = electron.webContents.getAllWebContents().filter((w) => !w.isDestroyed())
      const wc =
        a.target === 'thing'
          ? wcs.find((w) => w.getURL().startsWith('thing:'))!
          : wcs.find((w) => w.getURL().includes('shell/chrome'))!
      wc.focus()
      wc.sendInputEvent({ type: 'keyDown', keyCode: a.keyCode, modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: a.keyCode, modifiers: ['control'] })
    },
    { target, keyCode }
  )
  await new Promise((r) => setTimeout(r, 300))
}

test('Ctrl +/−/0 zooms chrome and cage in lockstep, from either view', async () => {
  const { outcome } = await shell.compose(NAMETAG_HTML.toString('base64'), 'nametag')
  expect(outcome.status).toBe('valid')
  await shell.openThing(outcome.envelopeHash as string)
  await new Promise((r) => setTimeout(r, 500))

  const base = await state()
  expect(base.chromeZoom).toBeCloseTo(1)
  expect(base.thingZoom).toBeCloseTo(1)

  // Zoom in from the CHROME: both views + the native cage rect scale.
  await sendZoomKey('chrome', '+')
  let s = await state()
  expect(s.chromeZoom).toBeCloseTo(1.2)
  expect(s.thingZoom).toBeCloseTo(1.2)
  expect(s.cageX).toBe(Math.round(base.cageX * 1.2))

  // Zoom in again from the THING: still lockstep — no per-view divergence.
  await sendZoomKey('thing', '+')
  s = await state()
  expect(s.chromeZoom).toBeCloseTo(1.44)
  expect(s.thingZoom).toBeCloseTo(1.44)
  expect(s.cageX).toBe(Math.round(base.cageX * 1.44))

  // Ctrl+0 resets everything.
  await sendZoomKey('thing', '0')
  s = await state()
  expect(s.chromeZoom).toBeCloseTo(1)
  expect(s.thingZoom).toBeCloseTo(1)
  expect(s.cageX).toBe(base.cageX)

  // Zoom out below 1 works too.
  await sendZoomKey('chrome', '-')
  s = await state()
  expect(s.chromeZoom).toBeCloseTo(1 / 1.2)
  expect(s.thingZoom).toBeCloseTo(1 / 1.2)
  await sendZoomKey('chrome', '0')
})
