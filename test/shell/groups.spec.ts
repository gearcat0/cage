import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, fromHex, type ShellHandle } from './helpers.js'

// ── Groups ───────────────────────────────────────────────────────────────────
// A roster of people, published by whoever keeps it, and amended by publishing
// a new version of it.
//
// The property worth protecting hardest is what membership is NOT. A roster is
// free to write — anyone can publish one naming anyone — so if being listed
// counted as trust, anyone could write themselves into your tribe. Vouches
// exist precisely because trust has to start with you, and a group must not
// reopen that hole. That is asserted directly here, twice.

const GROUP = readFileSync(join(__dirname, '..', '..', 'samples', 'group.html'))

let shell: ShellHandle
test.beforeEach(async () => {
  shell = await launchShell()
})
test.afterEach(async () => {
  await shell?.close()
})

const key = (c: string): string => c.repeat(40)

/** A roster naming these keys, optionally as version `seq` of `path`. */
async function roster(
  priv: Uint8Array,
  name: string,
  members: string[],
  chain?: { path: string; seq: number; prev: string }
): Promise<string> {
  const bundle = await buildBundle(ethSigner(priv), {
    type: 'group',
    program: new Uint8Array(GROUP),
    args: new Map<string, unknown>([
      ['name', name],
      [
        'members',
        members.map((k) => new Map<string, string>([['key', k], ['scheme', 'eth-eip191'], ['role', 'member'], ['name', '']]))
      ]
    ]),
    ...(chain ? { path: chain.path, seq: chain.seq, prev: fromHex(chain.prev) } : {})
  })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status, JSON.stringify(outcome)).toBe('valid')
  return outcome.envelopeHash as string
}

test('a roster lists its members, and they are queryable', async () => {
  const priv = secp256k1.utils.randomSecretKey()
  await roster(priv, 'The newsroom', [key('a'), key('b')])

  const listingA = await shell.groupsListing('eth-eip191', key('a'))
  expect(listingA.length).toBe(1)
  expect(listingA[0]!.name).toBe('The newsroom')
  expect((await shell.groupsListing('eth-eip191', key('c'))).length).toBe(0)
})

test('a new version replaces the roster: removal actually removes', async () => {
  // The reason the query resolves to the LATEST version. Someone written out
  // in version 2 is not a member, and a query that ignored that would keep
  // reporting a membership that was revoked.
  const priv = secp256k1.utils.randomSecretKey()
  const v0 = await roster(priv, 'The newsroom', [key('a'), key('b')])
  expect((await shell.groupsListing('eth-eip191', key('b'))).length).toBe(1)

  await roster(priv, 'The newsroom', [key('a')], { path: v0, seq: 1, prev: v0 })

  expect((await shell.groupsListing('eth-eip191', key('a'))).length, 'still listed').toBe(1)
  expect((await shell.groupsListing('eth-eip191', key('b'))).length, 'written out in v1').toBe(0)
})

test('the feed shows the current roster, not every version of it', async () => {
  const priv = secp256k1.utils.randomSecretKey()
  const v0 = await roster(priv, 'The newsroom', [key('a')])
  const v1 = await roster(priv, 'The newsroom', [key('a'), key('b')], { path: v0, seq: 1, prev: v0 })
  await roster(priv, 'The newsroom', [key('a'), key('b'), key('c')], { path: v0, seq: 2, prev: v1 })

  const groups = ((await shell.feed()) as { envelopeHash: string; type: string }[]).filter((r) => r.type === 'group')
  expect(groups.length, 'three versions, one row').toBe(1)
  expect(groups[0]!.envelopeHash).not.toBe(v0)
})

test('being in a group NEVER puts anyone in your tribe', async () => {
  // The whole point. A stranger publishes a roster naming themselves and you;
  // it must change nothing about who you trust.
  const stranger = secp256k1.utils.randomSecretKey()
  const me = (await shell.identity()).address
  await roster(stranger, 'Very Important People', [me, key('f')])

  expect(await shell.tribe(), 'a roster must not reach the tribe').toEqual([])

  // Even a roster published by someone you HAVE vouched for grants nothing to
  // the people it names — trust travels along vouches, not membership.
  const friendPriv = secp256k1.utils.randomSecretKey()
  const friendTag = await buildBundle(ethSigner(friendPriv), {
    type: 'nametag',
    program: new Uint8Array(GROUP),
    args: new Map([['name', 'Friend']])
  })
  const friendKey = ((await shell.ingest(friendTag)).author as { k: string }).k
  const started = await shell.newVouch('eth-eip191', friendKey)
  expect(started.id, String(started.error ?? '')).toBeTruthy()
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { lastPublish: unknown } }).__shell
    s.lastPublish = null
  })
  await shell.openThing(started.id as string)
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
  await shell.app.evaluate(async (electron) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    await wc!.executeJavaScript(`document.querySelector('[data-testid=confirm-approve]').click()`)
  })
  await expect.poll(async () => (await shell.tribe()).length, { timeout: 20_000 }).toBe(1)

  // The friend is in the tribe. Now they publish a roster naming a stranger.
  await roster(friendPriv, "Friend's circle", [key('e')])
  const tribe = await shell.tribe()
  expect(tribe.length, 'the roster added nobody').toBe(1)
  expect(tribe.some((t) => t.id === `eth-eip191:${key('e')}`)).toBe(false)
})

test('junk keys in a roster are program data, not members', async () => {
  const priv = secp256k1.utils.randomSecretKey()
  await roster(priv, 'Sloppy', [key('a'), 'not-a-key', '', 'z'.repeat(40)])
  expect((await shell.groupsListing('eth-eip191', key('a'))).length).toBe(1)
  expect((await shell.groupsListing('eth-eip191', 'z'.repeat(40))).length).toBe(0)
})

test('the roster says what being listed is worth', async () => {
  const priv = secp256k1.utils.randomSecretKey()
  const hash = await roster(priv, 'The newsroom', [key('a')])
  await shell.openThing(hash)
  const weight = await expect
    .poll(
      () =>
        shell.app.evaluate(async (electron) => {
          const s = (
            electron.app as unknown as { __shell: { modeState: () => { viewWcId: number | null } } }
          ).__shell.modeState()
          if (s?.viewWcId == null) return null
          const wc = electron.webContents.fromId(s.viewWcId)
          if (!wc || wc.isDestroyed()) return null
          return (await wc.executeJavaScript(
            `document.getElementById('group-weight')?.textContent ?? null`
          )) as never
        }) as Promise<string | null>,
      { timeout: 20_000 }
    )
    .not.toBeNull()
  void weight
  const text = (await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { modeState: () => { viewWcId: number | null } } }).__shell.modeState()
    const wc = electron.webContents.fromId(s!.viewWcId!)
    return (await wc!.executeJavaScript(`document.getElementById('group-weight').textContent`)) as never
  })) as string
  expect(text).toMatch(/not the same as agreeing/i)
  expect(text).toMatch(/never lets a roster reach your tribe/i)
})
