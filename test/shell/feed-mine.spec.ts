import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── "by you" + the All | Mine filter ─────────────────────────────────────────
// Once testers exchange things, every feed row looks alike apart from a
// truncated address. Rows signed by the identity this shell holds read
// "by you", and the filter narrows the feed to exactly those.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

async function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
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
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const click = (shell: ShellHandle, testid: string): Promise<void> =>
  chromeEval(shell, `document.querySelector('[data-testid=${testid}]').click()`)

const rowCount = (shell: ShellHandle): Promise<number> =>
  chromeEval<number>(shell, `document.querySelectorAll('.sh-feed-item:not([data-testid=draft-item])').length`)

const youCount = (shell: ShellHandle): Promise<number> =>
  chromeEval<number>(shell, `document.querySelectorAll('[data-testid=feed-you]').length`)

test('rows signed by this shell read "by you"; others show an address', async () => {
  const shell = await launchShell()
  try {
    // One of mine (signed by the running identity) …
    const mine = await shell.compose(NAMETAG.toString('base64'), 'nametag')
    expect(mine.outcome.status).toBe('valid')
    // … and one from a stranger.
    const foreign = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'nametag',
      program: new Uint8Array(NAMETAG)
    })
    expect((await shell.ingest(foreign)).status).toBe('valid')

    await poll(() => rowCount(shell), (n) => n === 2)
    expect(await youCount(shell)).toBe(1)

    // The stranger's row shows a checksummed address, never "by you".
    const id = await shell.identity()
    const labels = await chromeEval<string[]>(
      shell,
      `Array.from(document.querySelectorAll('.sh-feed-author')).map((n) => n.textContent)`
    )
    expect(labels).toContain('by you')
    expect(labels.some((l) => /^0x[0-9a-fA-F]{6}…/.test(l))).toBe(true)
    // The marker is derived from the ENVELOPE's author key, not from a guess:
    // the row's title still carries the full key, and it is ours.
    const titles = await chromeEval<string[]>(
      shell,
      `Array.from(document.querySelectorAll('[data-testid=feed-you]')).map((n) => n.getAttribute('title'))`
    )
    expect(titles).toEqual([`eth-eip191:${id.address}`])

    // Opening my own thing labels the header too.
    await chromeEval(shell, `window.__shellChrome.openThing(${JSON.stringify(mine.outcome.envelopeHash)})`)
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=header-you]')`),
      (v) => v
    )
  } finally {
    await shell.close()
  }
})

test('the Mine filter narrows the feed to things you signed', async () => {
  const shell = await launchShell()
  try {
    const mine = await shell.compose(NAMETAG.toString('base64'), 'nametag')
    for (let i = 0; i < 2; i++) {
      const foreign = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
        type: 'memo',
        program: new TextEncoder().encode(`<!doctype html><p>from a stranger ${i}</p>`)
      })
      expect((await shell.ingest(foreign)).status).toBe('valid')
    }
    await poll(() => rowCount(shell), (n) => n === 3)

    await click(shell, 'feed-filter-mine')
    await poll(() => rowCount(shell), (n) => n === 1)
    expect(await youCount(shell)).toBe(1)
    expect(await chromeEval<string>(shell, `document.querySelector('.sh-feed-head').textContent`)).toContain('By you · 1')
    // The active scope is visible, not just applied.
    expect(
      await chromeEval<boolean>(
        shell,
        `document.querySelector('[data-testid=feed-filter-mine]').classList.contains('sh-feed-filter-btn--active')`
      )
    ).toBe(true)

    // …and All brings everything back.
    await click(shell, 'feed-filter-all')
    await poll(() => rowCount(shell), (n) => n === 3)
    void mine
  } finally {
    await shell.close()
  }
})

test('drafts stay visible under the Mine filter', async () => {
  const shell = await launchShell()
  try {
    // A draft is yours by definition and is not published, so the published
    // feed's scope must not hide it.
    const types = await shell.knownTypes()
    const nametag = types.find((t) => t.testKey === 'starter-nametag')!
    expect((await shell.newDraft(nametag.key)).id).toBeTruthy()
    await poll(
      () => chromeEval<number>(shell, `document.querySelectorAll('[data-testid=draft-item]').length`),
      (n) => n === 1
    )
    await click(shell, 'feed-filter-mine')
    await poll(() => rowCount(shell), (n) => n === 0)
    expect(await chromeEval<number>(shell, `document.querySelectorAll('[data-testid=draft-item]').length`)).toBe(1)
    expect(await chromeEval<string>(shell, `document.querySelector('.evm-empty').textContent`)).toContain(
      'Nothing published by you yet'
    )
  } finally {
    await shell.close()
  }
})
