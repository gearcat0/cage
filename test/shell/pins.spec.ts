import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, jsToCbor, type ShellHandle } from './helpers.js'

// ── Pointers the shell seeds survive the program ─────────────────────────────
// Every one of these goes through the REAL sample program's editor, because
// that is where the bug lived: "Write a post" seeded `inGroup`, the article
// program's first draft replaced args whole, and the post was silently no
// longer in the forum. The specs that existed read the seed straight back out
// of the draft and never typed a character.

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell.close()
})

const person = (): { priv: Uint8Array } => ({ priv: secp256k1.utils.randomSecretKey() })

async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

/** Run JS inside the EDIT cage of whatever is open, once it exists. */
async function editEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const s = (electron.app as unknown as { __shell: { modeState: () => { editWcId: number | null } | null } }).__shell
    for (let i = 0; i < 80; i++) {
      const id = s.modeState()?.editWcId
      const wc = id != null ? electron.webContents.fromId(id) : null
      if (wc && !wc.isDestroyed() && !wc.isLoading()) return (await wc.executeJavaScript(code)) as never
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('no edit cage')
  }, js)
}

/** Type into a field of the program's own editor, the way a person does. */
const type = (selector: string, value: string): Promise<string> =>
  editEval<string>(`(() => {
    const t = document.querySelector(${JSON.stringify(selector)})
    if (!t) return 'missing ' + ${JSON.stringify(selector)}
    t.value = ${JSON.stringify(value)}
    t.dispatchEvent(new Event(t.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    return 'ok'
  })()`)

const draftArgs = async (id: string): Promise<Record<string, unknown>> =>
  ((await shell.drafts()).find((d) => d.id === id)?.args ?? {}) as Record<string, unknown>

/** Publish what is open through the real confirm dialog; returns its hash. */
async function publish(): Promise<string> {
  const before = (await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { lastPublish: { envelopeHash?: string } | null } }).__shell
    return (s.lastPublish?.envelopeHash ?? null) as never
  })) as string | null
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { publishDraft: () => unknown } }).__shell
    return s.publishDraft() as never
  })
  await expect
    .poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), { timeout: 20_000 })
    .toBe(true)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  let hash = ''
  await expect
    .poll(
      async () => {
        const p = (await shell.app.evaluate(async (electron) => {
          const s = (
            electron.app as unknown as { __shell: { lastPublish: { status?: string; envelopeHash?: string } | null } }
          ).__shell
          return s.lastPublish as never
        })) as { status?: string; envelopeHash?: string } | null
        if (p?.status === 'valid' && p.envelopeHash && p.envelopeHash !== before) hash = p.envelopeHash
        return hash !== ''
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  return hash
}

async function forumKeptBy(founder: { priv: Uint8Array }, moderators: string[] = []): Promise<string> {
  const r = await shell.ingest(
    await buildBundle(ethSigner(founder.priv), {
      type: 'group',
      args: jsToCbor({
        name: 'Tools',
        purpose: '',
        notes: '',
        members: moderators.map((key) => ({ key, scheme: 'eth-eip191', role: 'moderator', name: 'me' }))
      })
    })
  )
  expect(r.status).toBe('valid')
  return String(r.envelopeHash)
}

test('a post written in a forum is IN the forum once the article editor has had it', async () => {
  const forum = await forumKeptBy(person())
  const started = await shell.newForumPost(forum)
  await shell.openThing(started.id!)
  expect(await type('#edit-title', 'Which torque wrench?')).toBe('ok')
  await expect.poll(async () => (await draftArgs(started.id!)).title, { timeout: 10_000 }).toBe('Which torque wrench?')
  // The article program knows nothing about inGroup. The shell does.
  expect((await draftArgs(started.id!)).inGroup).toBe(forum)

  const hash = await publish()
  const listing = await shell.forumListing(forum)
  expect(listing.rows.map((r) => r.envelopeHash)).toContain(hash)
})

test('a reply to a forum post stays in the forum, and still answers the post', async () => {
  const forum = await forumKeptBy(person())
  const post = await shell.ingest(
    await buildBundle(ethSigner(person().priv), { type: 'article', args: jsToCbor({ title: 'p', inGroup: forum }) })
  )
  const reply = await shell.newComment(String(post.envelopeHash))
  await shell.openThing(reply.id!)
  expect(await type('#edit-body', 'The 3/8 one.')).toBe('ok')
  await expect.poll(async () => (await draftArgs(reply.id!)).body, { timeout: 10_000 }).toBe('The 3/8 one.')
  const args = await draftArgs(reply.id!)
  expect(args.replyTo).toBe(post.envelopeHash)
  expect(args.inGroup).toBe(forum)
})

test('a verdict written through the attestation editor is still a verdict', async () => {
  const me = (await shell.identity()).address.replace(/^0x/, '').toLowerCase()
  const forum = await forumKeptBy(person(), [me])
  const spam = await shell.ingest(
    await buildBundle(ethSigner(person().priv), { type: 'article', args: jsToCbor({ title: 'BUY GOLD', inGroup: forum }) })
  )
  const started = await shell.newVerdict(String(spam.envelopeHash), forum, 'hide')
  expect(started.id, String(started.error ?? '')).toBeTruthy()
  await shell.openThing(started.id!)
  expect(await type('#edit-note', 'Off topic and selling something.')).toBe('ok')
  await expect.poll(async () => (await draftArgs(started.id!)).note, { timeout: 10_000 }).toBe('Off topic and selling something.')
  const args = await draftArgs(started.id!)
  expect(args).toMatchObject({ attests: spam.envelopeHash, inGroup: forum, verdict: 'hide' })

  await publish()
  const row = (await shell.forumListing(forum)).rows.find((r) => r.envelopeHash === spam.envelopeHash)!
  expect((row.verdict as { verdict: string }).verdict).toBe('hide')
})

test('a program cannot retarget what the human clicked on', async () => {
  const target = await shell.ingest(await buildBundle(ethSigner(person().priv), { type: 'note', args: jsToCbor({ title: 'a' }) }))
  const other = 'cd'.repeat(32)
  const reply = await shell.newComment(String(target.envelopeHash))
  await shell.openThing(reply.id!)
  await editEval(`window.bridge.emit('draft', { type: 'comment', args: { replyTo: ${JSON.stringify(other)}, body: 'moved' } })`)
  await expect.poll(async () => (await draftArgs(reply.id!)).body, { timeout: 10_000 }).toBe('moved')
  expect((await draftArgs(reply.id!)).replyTo).toBe(target.envelopeHash)
})

test('a pointer the human TYPED is theirs to change', async () => {
  // No seed, so nothing is pinned: an attestation started from New lets you
  // type the target, and lets you change your mind about it.
  const started = await shell.newDraft('starter:attestation')
  await shell.openThing(started.id!)
  const first = 'aa'.repeat(32)
  const second = 'bb'.repeat(32)
  expect(await type('#edit-attests', first)).toBe('ok')
  await expect.poll(async () => (await draftArgs(started.id!)).attests, { timeout: 10_000 }).toBe(first)
  expect(await type('#edit-attests', second)).toBe('ok')
  await expect.poll(async () => (await draftArgs(started.id!)).attests, { timeout: 10_000 }).toBe(second)
})

// ── The moderator's controls ─────────────────────────────────────────────────
// Verdicts were verified, honoured and displayed, and nothing in the app could
// issue one. The controls appear only where a verdict would count, and a click
// starts a DRAFT: nothing is signed until Publish and the confirm.

test('a moderator gets Hide and Endorse; pressing one starts a verdict draft, signed only on Publish', async () => {
  const me = (await shell.identity()).address.replace(/^0x/, '').toLowerCase()
  const forum = await forumKeptBy(person(), [me])
  const post = await shell.ingest(
    await buildBundle(ethSigner(person().priv), { type: 'article', args: jsToCbor({ title: 'Ten tools', inGroup: forum }) })
  )
  await chromeEval(`window.__shellChrome.openForum(${JSON.stringify(forum)})`)
  await expect
    .poll(() => chromeEval<number>("document.querySelectorAll('[data-testid=forum-mod-hide]').length"), { timeout: 15_000 })
    .toBe(1)
  expect(await chromeEval<number>("document.querySelectorAll('[data-testid=forum-mod-endorse]').length")).toBe(1)
  expect(await chromeEval<string>("document.querySelector('[data-testid=forum-mod-hide]').title")).toMatch(/deletes nothing/i)

  const draftsBefore = (await shell.drafts()).length
  await chromeEval("document.querySelector('[data-testid=forum-mod-endorse]').click()")
  await expect.poll(async () => (await shell.drafts()).length, { timeout: 15_000 }).toBe(draftsBefore + 1)
  const draft = (await shell.drafts()).find((d) => (d.args as { attests?: string } | null)?.attests === post.envelopeHash)!
  expect(draft.type).toBe('attestation')
  expect(draft.args).toMatchObject({ attests: post.envelopeHash, inGroup: forum, verdict: 'endorse' })
  // A click is not a verdict: nothing was signed, and the post is unjudged.
  expect((await shell.forumListing(forum)).rows.find((r) => r.envelopeHash === post.envelopeHash)!.verdict).toBeNull()

  // The draft opened for them; saying why and publishing makes it one.
  // Wait for the click's own open to land: until THIS draft's editor is the one
  // mounted, the previous test's letter is, and a note typed now goes into ITS
  // editor. Do not open it again to force the issue -- a second open landing
  // while the first was still mounting left two edit cages on the Ubuntu
  // runner, and the note went into the one whose drafts main rejects.
  await expect
    .poll(() => editEval<string | null>("document.querySelector('#attests-fixed code')?.title ?? null"), { timeout: 15_000 })
    .toBe(post.envelopeHash)
  expect(await type('#edit-note', 'Useful and on topic.')).toBe('ok')
  await expect.poll(async () => (await draftArgs(draft.id)).note, { timeout: 10_000 }).toBe('Useful and on topic.')
  await publish()
  const judged = (await shell.forumListing(forum)).rows.find((r) => r.envelopeHash === post.envelopeHash)!
  expect((judged.verdict as { verdict: string }).verdict).toBe('endorse')

  // Ruled on: the controls are gone from that row, and the badge is there.
  await chromeEval(`window.__shellChrome.openForum(${JSON.stringify(forum)})`)
  await expect
    .poll(() => chromeEval<number>("document.querySelectorAll('[data-testid=forum-mod]').length"), { timeout: 15_000 })
    .toBe(0)
})

test('someone the roster does not name sees no moderator controls', async () => {
  // The previous test left its forum window open; count rows in THIS one only.
  await chromeEval("document.querySelectorAll('.evm-modal-overlay').forEach((o) => o.remove())")
  const forum = await forumKeptBy(person()) // no moderators at all
  await shell.ingest(
    await buildBundle(ethSigner(person().priv), { type: 'article', args: jsToCbor({ title: 'p', inGroup: forum }) })
  )
  await chromeEval(`window.__shellChrome.openForum(${JSON.stringify(forum)})`)
  await expect
    .poll(() => chromeEval<number>("document.querySelectorAll('[data-testid=forum-post]').length"), { timeout: 15_000 })
    .toBe(1)
  expect(await chromeEval<number>("document.querySelectorAll('[data-testid=forum-mod]').length")).toBe(0)
})
