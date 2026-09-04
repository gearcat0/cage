import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Petnames ─────────────────────────────────────────────────────────────────
// What YOU call a key.
//
// This is the one name in the system nobody else can influence. An author may
// claim any name they like inside a thing, and may even prove an ENS name — but
// they cannot make you call them something. So a petname is local, never enters
// a thing, and must never be dressed up as verification: the ✓ treatment
// belongs to a name proven to map to the key, and a petname is not that.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

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

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what = ''): Promise<T> {
  const deadline = Date.now() + 20_000
  for (;;) {
    let v: T | undefined
    try {
      v = await fn()
      if (pred(v)) return v
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out${what ? ` waiting for ${what}` : ''}: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** A thing by somebody else, so there is a foreign key to name. */
async function foreignThing(): Promise<{ hash: string; key: string }> {
  const priv = secp256k1.utils.randomSecretKey()
  const bundle = await buildBundle(ethSigner(priv), { type: 'nametag', program: new Uint8Array(NAMETAG) })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status).toBe('valid')
  return { hash: outcome.envelopeHash as string, key: (outcome.author as { k: string }).k }
}

test('naming a key replaces the address wherever the author appears', async () => {
  const { hash, key } = await foreignThing()

  // Before: the feed shows the raw address, and nothing claims a name.
  await poll(
    () => chromeEval<number>(`document.querySelectorAll('[data-testid=feed-petname]').length`),
    (n) => n === 0,
    'no names yet'
  )

  await shell.setPetname('eth-eip191', key, 'Ada')

  // The feed row now reads as a name.
  const shown = await poll(
    () =>
      chromeEval<string | null>(
        `document.querySelector('[data-testid=feed-petname]')?.textContent ?? null`
      ),
    (t) => t === 'Ada',
    'the feed row to show the name'
  )
  expect(shown).toBe('Ada')

  // And so does the open thing's header — but as a PETNAME, never as verified:
  // the ✓ treatment belongs to a name proven to map to the key.
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(hash)})`)
  const header = await poll(
    () =>
      chromeEval<{ text: string | null; kind: string | null; title: string | null }>(
        `(() => {
          const a = document.querySelector('[data-testid=header-author]')
          return a ? { text: a.textContent, kind: a.getAttribute('data-name'), title: a.getAttribute('title') } : null
        })()`
      ),
    (v) => v !== null && v.text === 'Ada',
    'the header to show the name'
  )
  expect(header.kind).toBe('petname')
  expect(header.kind).not.toBe('verified')
  expect(header.text).not.toContain('✓')
  // The key stays reachable: a name is a label, not a replacement for the fact.
  expect(header.title).toContain(key)
})

test('a petname is local: it never leaves, and clearing restores the address', async () => {
  const { key } = await foreignThing()
  await shell.setPetname('eth-eip191', key, 'Ada', 'met at the works meeting')

  // It is NOT in anything that could travel: not in the thing's args, not in
  // the bundle. The only place it exists is this machine's library.
  const people = await shell.people()
  const named = people.find((p) => p.authorKey === key)
  expect(named?.name).toBe('Ada')

  const rows = (await shell.feed()) as { authorKey: string; petname?: string | null }[]
  expect(rows.find((r) => r.authorKey === key)?.petname).toBe('Ada')

  // Clearing takes the name away and the address comes back.
  await shell.setPetname('eth-eip191', key, '')
  expect((await shell.people()).find((p) => p.authorKey === key)?.name ?? null).toBeNull()
  await poll(
    () => chromeEval<number>(`document.querySelectorAll('[data-testid=feed-petname]').length`),
    (n) => n === 0,
    'the name to disappear from the feed'
  )
})

test('names survive a restart, and the People view lists who you have seen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-pet-'))
  try {
    let key: string
    {
      const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
      try {
        const priv = secp256k1.utils.randomSecretKey()
        const bundle = await buildBundle(ethSigner(priv), { type: 'nametag', program: new Uint8Array(NAMETAG) })
        const outcome = await first.ingest(bundle)
        key = (outcome.author as { k: string }).k
        await first.setPetname('eth-eip191', key, 'Grace')
        expect((await first.people()).find((p) => p.authorKey === key)?.name).toBe('Grace')
      } finally {
        await first.app.close()
      }
    }
    const second = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      const people = await second.people()
      const grace = people.find((p) => p.authorKey === key!)
      expect(grace?.name, 'a name you gave is still yours after a restart').toBe('Grace')
      expect(grace?.things).toBe(1)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('naming does not disturb the Mine filter', async () => {
  // Regression: petnames carries author_key too, so the feed's unqualified
  // `author_key = ?` silently stopped filtering once that join existed.
  const { key } = await foreignThing()
  await shell.compose(NAMETAG.toString('base64'), 'nametag')
  await shell.setPetname('eth-eip191', key, 'Ada')

  const id = await shell.identity()
  const mine = (await shell.feed({ author: id.address })) as { authorKey: string }[]
  expect(mine.length).toBe(1)
  expect(mine[0]!.authorKey).toBe(id.address)
})
