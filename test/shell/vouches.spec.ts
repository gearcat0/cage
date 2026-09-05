import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Vouches ──────────────────────────────────────────────────────────────────
// A signed statement that you know somebody's KEY.
//
// The whole design rests on one asymmetry, and these tests exist to hold it:
// vouches are FREE TO MANUFACTURE. Anyone can mint a thousand keys and have
// them all vouch for each other, so a count of vouches means nothing on its
// own. What cannot be manufactured is a path that starts at YOUR key. So the
// question is never "how trusted is this key" — there is no score here — but
// "do my own vouches reach it, and in how few hops".
//
// The other half is what a vouch is NOT. It says the signer recognises a key.
// It does not say they are honest, that they are who they claim, or that
// anything they signed is true.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))
const STUB = new TextEncoder().encode('<!doctype html><p>v</p>')

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
  let value: T | undefined
  for (;;) {
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out waiting for ${what}: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Open a draft and publish it, approving the confirm the way a human would.
 *  Publishing goes through the chrome on purpose: there is no path that signs
 *  something without a human seeing what is about to be signed. */
async function openAndPublish(draftId: string): Promise<Record<string, unknown>> {
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(draftId)})`)
  const raised = await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
        return s.publishDraft() as never
      }) as Promise<Record<string, unknown>>,
    (r) => r?.status === 'pending',
    'main to accept a publish'
  )
  expect(raised.status).toBe('pending')
  await poll(
    () => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`),
    (v) => v,
    'the confirm'
  )
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  return (await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
        return s.lastPublish as never
      }) as Promise<Record<string, unknown> | null>,
    (pub) => pub?.status === 'valid',
    'the publish to resolve'
  )) as Record<string, unknown>
}

/** Vouch for a key as YOURSELF, end to end through the chrome. */
async function vouchAsMe(key: string): Promise<Record<string, unknown>> {
  const started = await shell.newVouch('eth-eip191', key)
  expect(started.id, String(started.error ?? '')).toBeTruthy()
  return openAndPublish(started.id as string)
}

/** A key that exists, with one thing in the library so People knows of it. */
async function person(): Promise<{ priv: Uint8Array; key: string }> {
  const priv = secp256k1.utils.randomSecretKey()
  const bundle = await buildBundle(ethSigner(priv), { type: 'nametag', program: new Uint8Array(NAMETAG) })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status).toBe('valid')
  return { priv, key: (outcome.author as { k: string }).k }
}

/** `voucher` vouches for `aboutKey`, admitted like anything else. */
async function vouch(priv: Uint8Array, aboutKey: string, name = '', created?: number): Promise<string> {
  const args = new Map<string, string>([
    ['about', aboutKey],
    ['aboutScheme', 'eth-eip191'],
    ['name', name]
  ])
  const bundle = await buildBundle(ethSigner(priv), {
    type: 'vouch',
    program: STUB,
    args,
    ...(created === undefined ? {} : { created })
  })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status, `vouch for ${aboutKey.slice(0, 8)} should admit`).toBe('valid')
  return outcome.envelopeHash as string
}

test('a vouch is counted for the key that SIGNED it, not the key it names', async () => {
  // The voucher comes from the envelope, which is signature-proven. Only the
  // subject is a claim. So a vouch cannot be written on somebody else's behalf:
  // whoever signs it is who it is from, whatever the args say.
  const alice = await person()
  const bob = await person()
  const mallory = await person()

  await vouch(mallory.priv, bob.key, 'Bob')

  const forBob = await shell.vouchesFor('eth-eip191', bob.key)
  expect(forBob.count).toBe(1)
  expect(forBob.rows[0]!.voucherKey).toBe(mallory.key)
  // Mallory cannot make the vouch look like Alice's by any content she writes.
  expect(forBob.rows.some((r) => r.voucherKey === alice.key)).toBe(false)
})

test('vouches from strangers reach nothing: only paths from YOUR key count', async () => {
  // Ten keys all vouching for one target — the sybil shape, and the reason a
  // raw count is worthless. None of it touches you, so none of it reaches you.
  const target = await person()
  for (let i = 0; i < 10; i++) {
    const stranger = secp256k1.utils.randomSecretKey()
    await vouch(stranger, target.key, `sock ${i}`)
  }

  const before = await shell.vouchesFor('eth-eip191', target.key)
  expect(before.count).toBe(10)
  expect(before.fromTribe, 'ten strangers are still ten strangers').toBe(0)
  expect(before.hops, 'unreachable from you').toBeNull()
  expect(await shell.tribe()).toEqual([])

  // One vouch FROM YOU changes the answer entirely — and it is the only kind
  // of vouch that can.
  const me = await shell.identity()
  const published = await vouchAsMe(target.key)
  expect(published.status).toBe('valid')
  expect((published.author as { k: string }).k).toBe(me.address)

  const after = await shell.vouchesFor('eth-eip191', target.key)
  expect(after.hops, 'one hop: you vouched for them yourself').toBe(1)
  expect(after.count, 'the strangers did not disappear — they just do not count').toBe(11)
  expect(after.fromTribe, 'and none of them are in your tribe either').toBe(0)
})

test('the tribe reaches two hops and stops', async () => {
  // you → a → b → c. `b` is a friend of a friend, which still means something.
  // `c` is not, and the walk must not drift outward forever: past two hops
  // "someone vouched for by someone vouched for by someone I once met" is not
  // a trust statement, it is a stranger with extra steps.
  const a = await person()
  const b = await person()
  const c = await person()

  await vouchAsMe(a.key)
  await vouch(a.priv, b.key, 'B')
  await vouch(b.priv, c.key, 'C')

  const tribe = await shell.tribe()
  const seat = (k: string): number | undefined => tribe.find((t) => t.id === `eth-eip191:${k}`)?.hops
  expect(seat(a.key)).toBe(1)
  expect(seat(b.key)).toBe(2)
  expect(seat(c.key), 'three hops out is outside the tribe').toBeUndefined()

  // And the path is kept, so the chrome can say HOW you reach someone rather
  // than asking anyone to take the number on faith.
  expect(tribe.find((t) => t.id === `eth-eip191:${b.key}`)?.via).toEqual([a.key])
})

test('a later vouch supersedes an earlier one from the same key', async () => {
  // A signed thing cannot be unsaid, so amending means publishing a newer one.
  // Both remain in the library; only the latest is counted, or a voucher would
  // accumulate weight simply by repeating themselves.
  const a = await person()
  const target = await person()

  await vouch(a.priv, target.key, 'first name', 1_000)
  await vouch(a.priv, target.key, 'second name', 2_000)

  const got = await shell.vouchesFor('eth-eip191', target.key)
  expect(got.count, 'one voucher, one voice').toBe(1)
  expect(got.rows[0]!.name).toBe('second name')
})

test('you cannot vouch for yourself', async () => {
  const me = await shell.identity()
  const refused = await shell.newVouch('eth-eip191', me.address)
  expect(refused.id).toBeUndefined()
  expect(refused.error).toContain('your own key')
  expect(await shell.tribe()).toEqual([])
})

test('junk subjects are program data, not vouches', async () => {
  for (const bogus of ['not-a-key', 'a'.repeat(39), '', 'b'.repeat(65)]) {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'vouch',
      program: STUB,
      args: new Map<string, string>([['about', bogus]])
    })
    expect((await shell.ingest(bundle)).status).toBe('valid')
  }
  // Nothing above landed in the graph.
  expect(await shell.tribe()).toEqual([])
})

test('only a vouch-typed thing vouches', async () => {
  // An `about` arg on some other type is just an arg. Indexing on args alone
  // would let any program silently write itself into the trust graph.
  const target = await person()
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG),
    args: new Map<string, string>([['about', target.key]])
  })
  expect((await shell.ingest(bundle)).status).toBe('valid')
  expect((await shell.vouchesFor('eth-eip191', target.key)).count).toBe(0)
})

test('the shell seeds the subject, and says plainly what a vouch is worth', async () => {
  const target = await person()
  await shell.setPetname('eth-eip191', target.key, 'Ada')

  // People offers the vouch, and states the distinction that matters: a
  // petname is private, a vouch travels.
  await chromeEval(`window.__shellChrome.openPeople()`)
  const peopleText = await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=people-modal]')?.textContent ?? null`),
    (t) => t !== null,
    'the People modal'
  )
  expect(peopleText).toContain('Naming is private; vouching is public')

  await chromeEval(
    `document.querySelector('[data-author-key="${target.key}"] [data-testid=people-vouch]').click()`
  )
  // The subject is seeded by the SHELL — a program can never learn a key.
  const drafts = await poll(() => shell.drafts(), (d) => d.length === 1, 'the vouch draft')
  expect(drafts[0]!.type).toBe('vouch')
  expect((drafts[0]!.args as { about?: string }).about).toBe(target.key)

  expect((await openAndPublish(drafts[0]!.id)).status).toBe('valid')
  const after = await shell.vouchesFor('eth-eip191', target.key)
  expect(after.hops).toBe(1)
})

test('the header shows where an author sits, and never as a score', async () => {
  const a = await person()
  await vouchAsMe(a.key)

  // Something authored by a key you have vouched for.
  const second = await buildBundle(ethSigner(a.priv), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG),
    args: new Map<string, string>([['name', 'later']])
  })
  const hash = (await shell.ingest(second)).envelopeHash as string

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(hash)})`)
  const badge = await poll(
    () =>
      chromeEval<{ text: string | null; hops: string | null; title: string | null }>(
        `(() => {
          const b = document.querySelector('[data-testid=header-tribe]')
          return b ? { text: b.textContent, hops: b.getAttribute('data-hops'), title: b.getAttribute('title') } : null
        })()`
      ),
    (v) => v !== null,
    'the tribe badge'
  )
  expect(badge.hops).toBe('1')
  expect(badge.text).toBe('you vouched')
  // Not a score, and not verification: it says how you know OF them, and
  // explicitly disclaims the rest.
  expect(badge.text).not.toContain('✓')
  expect(badge.title).toMatch(/nothing about this thing/i)
})

test('a thing by a stranger gets no badge at all', async () => {
  // Absence is the normal case. A "0 hops" badge would read as a score, and
  // would put a trust-shaped label on every stranger in the library.
  const stranger = await person()
  const rows = (await shell.feed()) as { envelopeHash: string; authorKey: string }[]
  const row = rows.find((r) => r.authorKey === stranger.key)!
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(row.envelopeHash)})`)
  await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=header-author]')?.textContent ?? null`),
    (t) => t !== null,
    'the header'
  )
  expect(await chromeEval<number>(`document.querySelectorAll('[data-testid=header-tribe]').length`)).toBe(0)
})

test('"5 attestations, 3 from your tribe" — the sentence the graph is for', async () => {
  // The count alone is free to manufacture. The second half is not, and it is
  // the only part that carries information for YOU.
  const target = await person()
  const friend = await person()
  await vouchAsMe(friend.key)

  // Attest to the target's nametag: one from the tribe, two from strangers.
  const rows = (await shell.feed()) as { envelopeHash: string; authorKey: string }[]
  const subject = rows.find((r) => r.authorKey === target.key)!.envelopeHash
  for (const priv of [friend.priv, secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey()]) {
    const bundle = await buildBundle(ethSigner(priv), {
      type: 'attestation',
      program: STUB,
      args: new Map<string, string>([
        ['attests', subject],
        ['statement', 'Accurately reproduced from the original source']
      ])
    })
    expect((await shell.ingest(bundle)).status).toBe('valid')
  }

  const got = await shell.attestations(subject)
  expect(got.count).toBe(3)
  expect(got.fromTribe, 'one of the three is someone you vouched for').toBe(1)

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(subject)})`)
  await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=header-attestations]')?.textContent ?? null`),
    (t) => t === '3 attestations',
    'the attestation count'
  )
  await chromeEval(`document.querySelector('[data-testid=header-attestations]').click()`)
  const line = await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=attestations-tribe]')?.textContent ?? null`),
    (t) => t !== null,
    'the tribe line'
  )
  expect(line).toContain('3 attestations, 1 from your tribe')
})
