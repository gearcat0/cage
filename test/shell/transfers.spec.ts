import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Transfers ────────────────────────────────────────────────────────────────
// A magnet is not a fetch. It may take hours, so it becomes a background
// transfer: progress, a cancel, several at once, and an intent that survives a
// restart.
//
// Hermetic (launchShell sets SHELL_TORRENT_OFFLINE=1), so nothing here reaches
// a swarm. That bounds what can be tested end to end — a download can be
// started, listed, cancelled and resumed, but never completed, because
// completing needs a peer. The live path is `pnpm world magnet`.
//
// The one thing hermetic testing cannot produce is the case that prompted all
// of this: a peer that is DISCOVERED but will not answer. Its wording is
// checked by pushing that state into the window directly.

const MAGNET = (hex: string, name: string): string =>
  `magnet:?xt=urn:btih:${hex.repeat(40).slice(0, 40)}&dn=${encodeURIComponent(name)}`

let shell: ShellHandle
test.beforeEach(async () => {
  shell = await launchShell()
})
test.afterEach(async () => {
  await shell?.close()
})

async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

test('several downloads run at once, each its own transfer', async () => {
  test.setTimeout(60_000)
  const a = await shell.fetchLocator(MAGNET('a', 'first.thing'))
  const b = await shell.fetchLocator(MAGNET('b', 'second.thing'))
  expect(a.status).toBe('started')
  expect(b.status).toBe('started')
  expect(a.transferId).not.toBe(b.transferId)

  const rows = (await shell.transfers()).downloads as { id: string; name: string }[]
  expect(rows.length).toBe(2)
  expect(rows.map((r) => r.name).sort()).toEqual(['first.thing', 'second.thing'])
})

test('asking for the same magnet twice is one download, not two', async () => {
  // Two rows would race for one directory, and the second would "resume" the
  // first's partial data as though it were its own.
  const first = await shell.fetchLocator(MAGNET('c', 'same.thing'))
  const again = await shell.fetchLocator(MAGNET('c', 'same.thing'))
  expect(first.status).toBe('started')
  expect(again.transferId).toBe(first.transferId)
  expect(((await shell.transfers()).downloads as unknown[]).length).toBe(1)
})

test('cancelling removes the transfer and its partial data', async () => {
  const started = await shell.fetchLocator(MAGNET('d', 'cancel-me.thing'))
  const id = started.transferId as string
  const dir = join(shell.userDataDir, 'downloads', 'd'.repeat(40))
  await expect.poll(() => existsSync(dir), { timeout: 10_000 }).toBe(true)

  expect((await shell.cancelTransfer(id)).cancelled).toBe(true)
  expect(((await shell.transfers()).downloads as unknown[]).length).toBe(0)
  // Left alone, abandoned partials would accumulate silently.
  expect(existsSync(dir), 'the partial download should be gone').toBe(false)
})

test('a download survives a restart: the intent is remembered and resumed', async () => {
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'shell-transfer-'))
  try {
    let id: string
    {
      const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
      try {
        const started = await first.fetchLocator(MAGNET('e', 'resume-me.thing'))
        expect(started.status).toBe('started')
        id = started.transferId as string
        expect(((await first.transfers()).downloads as unknown[]).length).toBe(1)
      } finally {
        await first.app.close() // keep the profile
      }
    }
    const second = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      // Quitting is not cancelling. The row is an intent, exactly as a seeding
      // row is, so the next start picks it up rather than losing the work.
      const rows = await expect
        .poll(async () => (await second.transfers()).downloads as { id: string; name: string }[], { timeout: 30_000 })
        .toHaveLength(1)
      void rows
      const resumed = (await second.transfers()).downloads as { id: string; name: string }[]
      expect(resumed[0]!.id).toBe(id!)
      expect(resumed[0]!.name).toBe('resume-me.thing')
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cancelled download stays cancelled across a restart', async () => {
  test.setTimeout(90_000)
  const dir = mkdtempSync(join(tmpdir(), 'shell-transfer-'))
  try {
    {
      const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
      try {
        const started = await first.fetchLocator(MAGNET('f', 'gone.thing'))
        await first.cancelTransfer(started.transferId as string)
      } finally {
        await first.app.close()
      }
    }
    const second = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      await new Promise((r) => setTimeout(r, 1500))
      expect(((await second.transfers()).downloads as unknown[]).length).toBe(0)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the window shows a live download, and says what it is waiting for', async () => {
  test.setTimeout(60_000)
  await shell.fetchLocator(MAGNET('9', 'watch-me.thing'))
  await chromeEval(`window.__shellChrome.openTransfers()`)

  const shown = await expect
    .poll(
      () => chromeEval<number>(`document.querySelectorAll('[data-testid=download-row]').length`),
      { timeout: 15_000 }
    )
    .toBe(1)
  void shown
  const why = await chromeEval<string>(
    `document.querySelector('[data-testid=download-diagnosis]').textContent`
  )
  // Offline there is genuinely no swarm, and "looking" is the honest word for
  // it — not an error, and not a claim that nobody has it.
  expect(why).toMatch(/looking for peers/i)

  // Closing the window must not cancel the transfer, and it says so.
  const body = await chromeEval<string>(`document.querySelector('[data-testid=transfers-modal]').textContent`)
  expect(body).toMatch(/closing this window does not stop it/i)
  await chromeEval(`document.querySelector('[data-testid=transfers-close]').click()`)
  expect(((await shell.transfers()).downloads as unknown[]).length).toBe(1)
})

test('a peer that is found but will not answer is reported AS THAT', async () => {
  // The case that prompted this work. A tracker knew one peer, that peer was
  // this machine's own public IP behind NAT, both its ports refused — and the
  // app said "fetch timed out", which reads as "nobody is sharing this".
  //
  // It cannot happen hermetically (there is no discovery at all), so the state
  // is pushed into the window directly. The wording IS the deliverable.
  await chromeEval(`window.__shellChrome.openTransfers()`)
  await chromeEval(`window.__shellChrome.paintTransfers({
    downloads: [{
      id: 'x', magnet: 'magnet:?xt=urn:btih:${'0'.repeat(40)}', infoHash: '${'0'.repeat(40)}',
      name: 'stuck.thing', state: 'peers-unreachable', bytes: 0, downloaded: 0, progress: 0,
      downloadSpeed: 0, peersConnected: 0, peersDiscovered: 2, silentSources: [], error: null,
      startedAt: Date.now()
    }],
    sharing: []
  })`)
  const why = await chromeEval<string>(
    `document.querySelector('[data-testid=download-diagnosis]').textContent`
  )
  expect(why).toMatch(/found 2 peers/i)
  expect(why).toMatch(/none have accepted a connection/i)
  // Names the likely cause, which is what makes it actionable rather than sad.
  expect(why).toMatch(/NAT|no longer running/i)
  // And it must NOT read as an empty swarm — the confusion being fixed.
  expect(why).not.toMatch(/looking for peers/i)
})

test('nothing found yet names which sources are silent', async () => {
  await chromeEval(`window.__shellChrome.openTransfers()`)
  await chromeEval(`window.__shellChrome.paintTransfers({
    downloads: [{
      id: 'y', magnet: 'magnet:?xt=urn:btih:${'1'.repeat(40)}', infoHash: '${'1'.repeat(40)}',
      name: 'quiet.thing', state: 'finding-peers', bytes: 0, downloaded: 0, progress: 0,
      downloadSpeed: 0, peersConnected: 0, peersDiscovered: 0, silentSources: ['dht', 'tracker'],
      error: null, startedAt: Date.now()
    }],
    sharing: []
  })`)
  const why = await chromeEval<string>(`document.querySelector('[data-testid=download-diagnosis]').textContent`)
  expect(why).toMatch(/dht, tracker/i)
})
