import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, fromHex, type ShellHandle } from './helpers.js'

// ── Versions ─────────────────────────────────────────────────────────────────
// The envelope has carried path/seq/prev since the format was written, the
// library has indexed (author, path, seq) and detected forks all along, and
// none of it was ever used: every published thing set them to null.
//
// A chain starts when you AMEND. The new version takes path = the original's
// envelope hash, so chain identity is collision-free and names where the line
// began, and every thing already in a library becomes amendable retroactively.
//
// The property worth guarding hardest: a chain is (author_key, path). Amending
// somebody else's thing gives you YOUR line rooted on theirs — never a new
// version of theirs, which you could not sign even if you wanted to.

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

/** Publish whatever the open draft last streamed, approving the confirm. */
async function publishOpenDraft(): Promise<Record<string, unknown>> {
  // Clear the previous outcome FIRST. lastPublish is sticky, so polling it for
  // 'valid' returns the PREVIOUS publish instantly — which silently made a
  // second amendment look like it had produced the first one's envelope.
  await shell.app.evaluate(async (electron) => {
    ;(electron.app as unknown as { __shell: { lastPublish: unknown } }).__shell.lastPublish = null
  })
  await expect
    .poll(
      () =>
        shell.app.evaluate(async (electron) => {
          const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
          return s.publishDraft() as never
        }) as Promise<Record<string, unknown>>,
      { timeout: 20_000 }
    )
    .toHaveProperty('status', 'pending')
  await expect
    .poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), { timeout: 20_000 })
    .toBe(true)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  return (await expect
    .poll(
      () =>
        shell.app.evaluate(async (electron) => {
          const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
          return s.lastPublish as never
        }) as Promise<Record<string, unknown> | null>,
      { timeout: 20_000 }
    )
    .toHaveProperty('status', 'valid')) as unknown as Record<string, unknown>
}

/** Open a thing and wait until the header is REALLY showing it.
 *
 *  The header is rebuilt asynchronously, so polling for "the version badge"
 *  can catch the previous thing's badge mid-swap — which is how this spec
 *  flaked once before the badge carried its own hash. */
async function openAndSettle(hash: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(hash)})`)
        return chromeEval<string | null>(
          `document.querySelector('[data-testid=header-version]')?.getAttribute('data-envelope-hash') ?? null`
        )
      },
      { timeout: 25_000 }
    )
    .toBe(hash)
}

/** Amend `hash` and publish the result, returning the new version's hash. */
async function amendAndPublish(hash: string): Promise<string> {
  const started = await shell.amend(hash)
  expect(started.id, String(started.error ?? '')).toBeTruthy()
  await shell.openThing(started.id as string)
  await publishOpenDraft()
  const last = await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> } }).__shell
    return s.lastPublish as never
  })
  return (last as Record<string, unknown>).envelopeHash as string
}

/** Something of my own to amend.
 *
 *  The type is varied per call on purpose: composing identical content twice in
 *  the same second reproduces the envelope exactly (author + content + the
 *  claimed second), so the second is a duplicate and never enters the library. */
let composed = 0
async function mine(): Promise<string> {
  const r = await shell.compose(NAMETAG.toString('base64'), `nametag-${++composed}`)
  return r.outcome.envelopeHash as string
}

test('amending starts a chain rooted on the original, and continues it', async () => {
  test.setTimeout(120_000)
  const original = await mine()
  const v1 = await amendAndPublish(original)
  const v2 = await amendAndPublish(v1)

  const history = await shell.history((await shell.identity()).address, original)
  expect(history.map((h) => h.seq)).toEqual([1, 2])
  expect(history.map((h) => h.envelopeHash)).toEqual([v1, v2])
  // path names where the line began, so a chain can never collide with another.
  expect(history.every((h) => h.path === original)).toBe(true)
})

test('the feed shows the current version, not the whole line', async () => {
  test.setTimeout(120_000)
  const original = await mine()
  const before = ((await shell.feed()) as unknown[]).length
  const v1 = await amendAndPublish(original)
  await amendAndPublish(v1)

  // Three things exist; one row. Both the superseded version AND the original
  // the chain was rooted on are collapsed away.
  const rows = (await shell.feed()) as { envelopeHash: string }[]
  expect(rows.length, 'a line of three versions is one row').toBe(before)
  expect(rows.some((r) => r.envelopeHash === original)).toBe(false)
  expect(rows.some((r) => r.envelopeHash === v1)).toBe(false)
})

test('an ordinary thing still gets its own row', async () => {
  // The regression guard the co-signing collapse already taught us to write:
  // collapsing must be scoped to things actually in a chain.
  const before = ((await shell.feed()) as unknown[]).length
  await mine()
  await mine()
  expect(((await shell.feed()) as unknown[]).length).toBe(before + 2)
})

test('opening an old version says so, and offers the current one', async () => {
  test.setTimeout(120_000)
  const original = await mine()
  const v1 = await amendAndPublish(original)
  const v2 = await amendAndPublish(v1)

  await openAndSettle(v1)
  const got = await chromeEval<{ text: string; superseded: string }>(
    `(() => { const b = document.querySelector('[data-testid=header-version]'); return { text: b.textContent, superseded: b.getAttribute('data-superseded') } })()`
  )
  // A version number alone would not say whether this is current.
  expect(got.text).toBe('version 1 of 2')
  expect(got.superseded).toBe('1')
  expect(await chromeEval<number>(`document.querySelectorAll('[data-testid=header-latest]').length`)).toBe(1)

  // And the newest one does not claim to be superseded.
  await openAndSettle(v2)
  expect(
    await chromeEval<string | null>(
      `document.querySelector('[data-testid=header-version]').getAttribute('data-superseded')`
    )
  ).toBe('0')
})

test('history lists every version, oldest first', async () => {
  test.setTimeout(120_000)
  const original = await mine()
  const v1 = await amendAndPublish(original)
  await amendAndPublish(v1)

  await openAndSettle(v1)
  await chromeEval(`document.querySelector('[data-testid=header-version]').click()`)
  const seqs = await expect
    .poll(
      () =>
        chromeEval<string[]>(
          `[...document.querySelectorAll('[data-testid=history-item]')].map(e => e.getAttribute('data-seq'))`
        ),
      { timeout: 20_000 }
    )
    .toEqual(['1', '2'])
  void seqs
  const text = await chromeEval<string>(`document.querySelector('[data-testid=history-modal]').textContent`)
  // An earlier version is superseded, not corrected or removed.
  expect(text).toMatch(/is not deleted or corrected/i)
})

test("amending someone else's thing is YOUR line, not their version 2", async () => {
  test.setTimeout(120_000)
  // The property that matters most. A chain is (author, path): you cannot sign
  // as them, so you cannot extend their line — and the chrome must not pretend
  // otherwise by calling it "New version".
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG),
    args: new Map([['name', 'Theirs']])
  })
  const theirs = (await shell.ingest(bundle)).envelopeHash as string

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(theirs)})`)
  const label = await expect
    .poll(
      () => chromeEval<string | null>(`document.querySelector('[data-testid=header-amend]')?.textContent ?? null`),
      { timeout: 20_000 }
    )
    .toBe('Your version…')
  void label

  const mineHash = await amendAndPublish(theirs)
  const me = (await shell.identity()).address
  // Their thing has no chain of their own; mine is rooted on it under MY key.
  expect((await shell.history(me, theirs)).map((h) => h.seq)).toEqual([1])
  const rows = (await shell.feed()) as { envelopeHash: string; authorKey: string }[]
  expect(rows.find((r) => r.envelopeHash === mineHash)?.authorKey).toBe(me)
})

test('a version pointing at the wrong predecessor is called out', async () => {
  test.setTimeout(120_000)
  // prev is an author claim that nothing checked before this. Here a version
  // claims seq 2 on the chain but points its prev at the ORIGINAL rather than
  // at version 1 — a broken link the chain's own order exposes.
  const priv = secp256k1.utils.randomSecretKey()
  const rootBundle = await buildBundle(ethSigner(priv), { type: 'nametag', program: new Uint8Array(NAMETAG) })
  const root = (await shell.ingest(rootBundle)).envelopeHash as string

  const v1 = await buildBundle(ethSigner(priv), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG),
    args: new Map([['name', 'one']]),
    path: root,
    seq: 1,
    prev: fromHex(root)
  })
  const v1Hash = (await shell.ingest(v1)).envelopeHash as string

  const v2 = await buildBundle(ethSigner(priv), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG),
    args: new Map([['name', 'two']]),
    path: root,
    seq: 2,
    prev: fromHex(root) // WRONG: should be v1
  })
  const v2Hash = (await shell.ingest(v2)).envelopeHash as string
  void v1Hash

  await openAndSettle(v2Hash)
  expect(
    await chromeEval<number>(`document.querySelectorAll('[data-testid=header-prev-mismatch]').length`)
  ).toBe(1)
})
