import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Updates are asked for, never assumed ─────────────────────────────────────
// privacy.md: nothing touches the network unless you asked. These run the real
// electron-updater against a local feed (SHELL_UPDATE_FEED) and count what
// reaches it: nothing before the human answers the first-run question, nothing
// after a no, and a manual check always.

const FEED_YML = `version: 999.0.0
files:
  - url: Souspli-999.0.0-win-x64.exe
    sha512: ${'A'.repeat(86)}==
    size: 1
  - url: Souspli-999.0.0-mac-arm64.zip
    sha512: ${'A'.repeat(86)}==
    size: 1
  - url: Souspli-999.0.0-linux-x86_64.AppImage
    sha512: ${'A'.repeat(86)}==
    size: 1
path: Souspli-999.0.0-win-x64.exe
sha512: ${'A'.repeat(86)}==
releaseDate: '2026-09-28T00:00:00.000Z'
releaseNotes: '<p>Test notes &amp; fixes</p>'
`

let server: Server
let feedUrl = ''
const requests: string[] = []

test.beforeAll(async () => {
  server = createServer((req, res) => {
    // electron-updater appends ?noCache=…, so match the path.
    const path = new URL(req.url ?? '/', 'http://x').pathname
    requests.push(path)
    if (path.endsWith('.yml')) {
      res.writeHead(200, { 'content-type': 'text/yaml' })
      res.end(FEED_YML)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  feedUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
test.afterAll(async () => {
  await new Promise((r) => server.close(r))
})

async function launch(): Promise<ShellHandle> {
  requests.length = 0
  return launchShell({
    extraEnv: {
      SHELL_NO_UPDATE_PROMPT: '0',
      SHELL_UPDATE_FEED: feedUrl,
      // Short, so "nothing was fetched" is a real wait past the first check.
      SHELL_UPDATE_FIRST_CHECK_MS: '300'
    }
  })
}

function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

const count = (sel: string) => `document.querySelectorAll(${JSON.stringify(sel)}).length`
const click = (sel: string) => `document.querySelector(${JSON.stringify(sel)}).click()`
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('nothing is checked until the human says yes, then an update is shown, not fetched', async () => {
  const shell = await launch()
  try {
    await expect.poll(() => chromeEval<number>(shell, count('[data-testid=update-consent-on]')), { timeout: 10_000 }).toBe(1)
    await settle(1500) // well past SHELL_UPDATE_FIRST_CHECK_MS
    expect(requests).toEqual([])

    await chromeEval(shell, click('[data-testid=update-consent-on]'))
    await expect
      .poll(() => chromeEval<string | null>(shell, "document.querySelector('[data-testid=update-status]')?.dataset.phase ?? null"), {
        timeout: 15_000
      })
      .toBe('available')
    const text = await chromeEval<string>(shell, "document.querySelector('[data-testid=updates-modal]').textContent")
    expect(text).toContain('999.0.0')
    expect(text).toContain('Test notes & fixes') // shown as text, entities decoded
    // Found is not fetched: only the feed was requested, no installer.
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((u) => u.endsWith('.yml'))).toBe(true)
    // The answer is kept.
    const status = await chromeEval<Record<string, unknown>>(shell, 'window.shell.updateStatus()')
    expect(status).toMatchObject({ pref: 'on', prompt: false })
  } finally {
    await shell.close()
  }
})

test('a no means no background checks, and Help → Check for updates… still works', async () => {
  const shell = await launch()
  try {
    await expect.poll(() => chromeEval<number>(shell, count('[data-testid=update-consent-off]')), { timeout: 10_000 }).toBe(1)
    await chromeEval(shell, click('[data-testid=update-consent-off]'))
    await settle(1500)
    expect(requests).toEqual([])

    // The real menu item, clicked.
    await shell.app.evaluate(async (electron) => {
      const item = electron.Menu.getApplicationMenu()!
        .items.flatMap((i) => i.submenu?.items ?? [])
        .find((i) => i.label === 'Check for updates…')
      if (!item) throw new Error('no Check for updates… menu item')
      item.click()
    })
    await expect
      .poll(() => chromeEval<string | null>(shell, "document.querySelector('[data-testid=update-status]')?.dataset.phase ?? null"), {
        timeout: 15_000
      })
      .toBe('available')
    expect(requests.length).toBeGreaterThan(0)
    // Still off: one manual look is not consent to daily ones.
    expect(await chromeEval<boolean>(shell, "document.querySelector('[data-testid=update-auto]').checked")).toBe(false)
  } finally {
    await shell.close()
  }
})
