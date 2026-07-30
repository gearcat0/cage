import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell } from './helpers.js'

// ── Startup rendering ────────────────────────────────────────────────────────
// The chrome's boot script invokes shell:identity / shell:feed while the page
// is still loading. If main loads the chrome before those handlers are
// registered, the invokes reject and the feed renders EMPTY until some later
// feed-changed event — the "library is invisible at startup" bug. This spec
// restarts against a persisted library and requires the feed to render with
// no ingest happening in the second session.

const NAMETAG_HTML = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

test('the chrome feed shows previously stored things at startup', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'shell-boot-'))
  try {
    // Session 1: author a thing into the library, then quit.
    const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dataDir } })
    const { outcome } = await first.compose(NAMETAG_HTML.toString('base64'), 'nametag')
    expect(outcome.status).toBe('valid')
    await first.close()

    // Session 2: same library; the feed must render from boot alone.
    const second = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dataDir } })
    try {
      const feedCount = async (): Promise<number> =>
        second.app.evaluate(async (electron) => {
          const wc = electron.webContents
            .getAllWebContents()
            .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
          if (!wc) return -1
          return (await wc.executeJavaScript(`document.querySelectorAll('.sh-feed-item').length`)) as never
        })
      const deadline = Date.now() + 10_000
      let count = 0
      for (;;) {
        count = await feedCount()
        if (count > 0 || Date.now() > deadline) break
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(count).toBeGreaterThan(0)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
