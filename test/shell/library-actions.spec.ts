import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  launchShell,
  buildBundle,
  bundleTarHash,
  ethSigner,
  secp256k1,
  type ShellHandle
} from './helpers.js'

// ── Library actions: Copy and Delete ─────────────────────────────────────────
// Copy is the shell-level "edit the selected object" primitive: things are
// immutable, so editing starts by making YOUR OWN instance with the exact same
// program, type, args, and attachments — including for things authored by
// someone else. Delete removes a thing everywhere the shell holds it: index
// row, content blobs (GC'd only when no remaining thing references them —
// blobs are content-addressed and shared), and its seeded bundle.

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

async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

async function viewEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(
    async (electron, code) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      if (s?.viewWcId == null) throw new Error('no view cage')
      const wc = electron.webContents.fromId(s.viewWcId)
      if (!wc || wc.isDestroyed()) throw new Error('cage wc gone')
      return (await wc.executeJavaScript(code)) as never
    },
    js
  )
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
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

async function openViaChrome(envelopeHash: string): Promise<void> {
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(envelopeHash)})`)
  await poll(modeState, (s) => s != null && s.viewWcId !== null && s.activeMode === 'view')
}

interface FeedRow {
  envelopeHash: string
  type: string
  progHash: string
  authorKey: string
}
const feed = async (): Promise<FeedRow[]> => (await shell.feed()) as unknown as FeedRow[]

let origBundle: Uint8Array
let origHash = ''
let copyHash = ''
let progHash = ''

test('Copy creates your own instance with the identical program and args', async () => {
  // A nametag WITH args, authored by SOMEONE ELSE — copy must work on foreign
  // things and must round-trip args byte-faithfully.
  origBundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG_HTML),
    args: new Map([['name', 'Original']])
  })
  const r = await shell.ingest(origBundle)
  expect(r.status).toBe('valid')
  origHash = r.envelopeHash as string

  await openViaChrome(origHash)
  await chromeEval(`document.querySelector('[data-testid=header-copy]').click()`)
  const rows = await poll(feed, (f) => f.filter((x) => x.type === 'nametag').length === 2)

  const orig = rows.find((x) => x.envelopeHash === origHash)!
  const copy = rows.find((x) => x.envelopeHash !== origHash)!
  copyHash = copy.envelopeHash
  progHash = orig.progHash
  expect(copy.progHash).toBe(orig.progHash)
  expect(copy.authorKey).toBe((await shell.identity()).address)
  expect(copy.authorKey).not.toBe(orig.authorKey)

  // The copy carries the same args: its view mode renders the original name.
  await openViaChrome(copyHash)
  const display = await poll(
    () => viewEval<string | null>(`document.getElementById('display')?.textContent ?? null`),
    (t) => t !== null
  )
  expect(display).toBe('Original')
})

test('deleting the open thing closes it and clears the header', async () => {
  // The copy is open from the previous test. Delete it via the header button
  // + the real confirm modal.
  await chromeEval(`document.querySelector('[data-testid=header-delete]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=danger-confirm]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=danger-confirm]').click()`)

  await poll(feed, (f) => f.filter((x) => x.type === 'nametag').length === 1)
  await poll(modeState, (s) => s === null) // cages destroyed
  const headerText = await chromeEval<string>(`document.querySelector('.sh-thing-header').textContent`)
  expect(headerText).toContain('Select a thing')
  const reopen = await shell.openThing(copyHash)
  expect(reopen.error).toBeTruthy()
})

test('content blobs die only with their last referrer; the seed dies with the thing', async () => {
  // The original still references the shared program blob.
  expect(shell.casBlobs()).toContain(progHash)
  expect(await shell.seedHas(bundleTarHash(origBundle))).toBe(true)

  // Delete the original from its FEED ROW — no need to open (you may not want
  // to mount a thing before removing it).
  await chromeEval(`document.querySelector('[data-testid=feed-delete]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=danger-confirm]')`), (v) => v)
  await chromeEval(`document.querySelector('[data-testid=danger-confirm]').click()`)

  await poll(feed, (f) => f.filter((x) => x.type === 'nametag').length === 0)
  // Last referrer gone: the program blob is GC'd, and the bundle is unseeded.
  expect(shell.casBlobs()).not.toContain(progHash)
  expect(await shell.seedHas(bundleTarHash(origBundle))).toBe(false)
})
