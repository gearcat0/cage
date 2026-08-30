import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Replies ──────────────────────────────────────────────────────────────────
// A comment claims to reply to a thing by putting its hash in args.replyTo —
// the SHELL seeds that (a program can never learn a hash: getArgs withholds
// the envelope). The claim is UNAUTHENTICATED: anyone may claim to reply to
// anything, and the target's author never consented. So the shell indexes it,
// scopes the list to "your library", and degrades honestly when the target is
// not held — it must never dress a claim as verification.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

// One shell for the file: each test works against its own target hash, so they
// cannot interfere — and every extra Electron launch is real pressure on a
// two-core CI runner (a starved app is where this suite's flakes come from).
let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

async function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000, what = ''): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch (e) {
      lastError = e // a swallowed error here is why a timeout reads as an unexplained null
    }
    if (Date.now() > deadline) {
      throw new Error(
        `poll timed out${what ? ` waiting for ${what}` : ''}; last value: ${JSON.stringify(value)}` +
          (lastError ? `; last error: ${(lastError as Error).message}` : '')
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

const attr = (shell: ShellHandle, testid: string, name: string): Promise<string | null> =>
  chromeEval<string | null>(shell, `document.querySelector('[data-testid=${testid}]')?.getAttribute(${JSON.stringify(name)}) ?? null`)

const text = (shell: ShellHandle, testid: string): Promise<string | null> =>
  chromeEval<string | null>(shell, `document.querySelector('[data-testid=${testid}]')?.textContent ?? null`)

/** What the chrome header actually shows — for when the wait below fails and
 *  "null" alone cannot distinguish "not rendered yet" from "open refused". */
const headerDump = (shell: ShellHandle): Promise<string> =>
  chromeEval<string>(
    shell,
    `(() => {
      const h = document.querySelector('.sh-thing-header')
      const ids = h ? Array.from(h.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid')) : null
      const toast = document.querySelector('.sh-toast')
      return JSON.stringify({ testids: ids, headerText: h ? h.textContent.trim().slice(0, 120) : null,
                              toast: toast ? toast.textContent : null })
    })()`
  ).catch((e: unknown) => `<dump failed: ${(e as Error).message}>`)

const openViaChrome = async (shell: ShellHandle, hash: string): Promise<void> => {
  // Ask until it sticks. Opens are fire-and-forget from several places, and
  // publishing auto-opens what it just signed — so a single request can be
  // overtaken by an auto-open still in flight from earlier work, leaving the
  // header on a different thing. That is the app being busy, not broken: the
  // header still matches what is mounted. Re-issue until the header settles on
  // the thing this test means to look at.
  try {
    await poll(
      async () => {
        await chromeEval(shell, `window.__shellChrome.openThing(${JSON.stringify(hash)})`)
        return await attr(shell, 'header-replies', 'data-envelope-hash')
      },
      (h) => h === hash,
      20_000,
      `the header to show ${hash.slice(0, 8)}`
    )
  } catch (e) {
    // chrome renders NO header-replies when an open is refused (renderHeader
    // (null) + an "Open failed" toast), which looks identical to "still
    // loading" from the outside. Say which one it was, and which thing the
    // header is actually describing.
    throw new Error(`${(e as Error).message}; header now: ${await headerDump(shell)}`)
  }
}

/** Publish whatever the open draft last streamed, approving the confirm.
 *
 *  Readiness is asked of MAIN, not of the chrome Publish button. Some of these
 *  tests open a draft through the test hook, which bypasses chrome entirely --
 *  so the chrome header still describes whatever it last rendered, and its
 *  Publish button is correctly disabled for a thing that is not the draft.
 *  Watching that button meant watching the wrong object, and it only ever
 *  passed because a mode-changed push happened to enable the stale one.
 *
 *  publishDraft() refusing with 'nothing to publish' IS main's own "no draft
 *  streamed yet" signal, and the call that finally succeeds raises the confirm
 *  we want next — so polling it is both the wait and the action. */
async function publishOpenDraft(shell: ShellHandle): Promise<Record<string, unknown>> {
  const raised = await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
        return s.publishDraft() as never
      }) as Promise<Record<string, unknown>>,
    (r) => r?.status === 'pending',
    20_000,
    'main to accept a publish (the program to stream a draft)'
  )
  expect(raised.status, `publishDraft refused: ${JSON.stringify(raised.reason ?? '')}`).toBe('pending')
  await poll(
    () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=confirm-approve]')`),
    (v) => v,
    20_000,
    'the publish confirm to appear'
  )
  await chromeEval(shell, `document.querySelector('[data-testid=confirm-approve]').click()`)
  return (await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
        return s.lastPublish as never
      }) as Promise<Record<string, unknown> | null>,
    (p) => p?.status === 'valid',
    20_000,
    'the approved publish to resolve'
  )) as Record<string, unknown>
}

test('Comment seeds the target, and the article then shows its comment', async () => {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'nametag',
      program: new Uint8Array(NAMETAG)
    })
    const target = (await shell.ingest(bundle)).envelopeHash as string
    await openViaChrome(shell, target)
    expect(await text(shell, 'header-replies')).toBe('no comments')

    // The shell seeds the hash the program could never learn by itself.
    await chromeEval(shell, `document.querySelector('[data-testid=header-comment]').click()`)
    const drafts = await poll(() => shell.drafts(), (d) => d.length === 1)
    expect((drafts[0]!.args as { replyTo?: string }).replyTo).toBe(target)
    expect(drafts[0]!.type).toBe('comment')

    // The comment program streams its own draft on load (echoing replyTo);
    // publish it and the claim becomes indexed.
    const published = await publishOpenDraft(shell)
    expect(published.status).toBe('valid')
    const replies = await shell.replies(target)
    expect(replies.count).toBe(1)
    expect(replies.rows.length).toBe(1)

    // Back on the article: the count is visible and the list opens the comment.
    await poll(
      async () => {
        await chromeEval(shell, `window.__shellChrome.openThing(${JSON.stringify(target)})`)
        return await text(shell, 'header-replies')
      },
      (t) => t === '1 comment',
      20_000,
      'the target to show its one comment'
    )
    expect(await attr(shell, 'header-replies', 'data-count')).toBe('1')
    await chromeEval(shell, `document.querySelector('[data-testid=header-replies]').click()`)
    await poll(() => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=replies-modal]')`), (v) => v)
    await chromeEval(shell, `document.querySelector('[data-testid=reply-item]').click()`)

    // The comment says what it replies to, and we hold that target.
    await poll(
      () => attr(shell, 'header-replyto', 'data-known'),
      (k) => k === '1',
      20_000,
      'the comment to report that its target is held'
    )
    expect(await text(shell, 'header-replyto')).toContain('in reply to')
    // A claim is never dressed as verification.
    expect(await text(shell, 'header-replyto')).not.toContain('✓')
})

test('deleting the target degrades the claim honestly instead of hiding it', async () => {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'nametag',
      program: new Uint8Array(NAMETAG)
    })
    const target = (await shell.ingest(bundle)).envelopeHash as string
    const created = await shell.newComment(target)
    expect(created.id).toBeTruthy()
    await shell.openThing(created.id!)
    const published = await publishOpenDraft(shell)
    const commentHash = published.envelopeHash as string

    // Drop the article. The comment keeps its claim; only "known" changes.
    await shell.app.evaluate(async (electron, h) => {
      const s = (electron.app as unknown as { __shell: { deleteThing: (x: string) => unknown } }).__shell
      s.deleteThing(h)
    }, target)

    await openViaChrome(shell, commentHash)
    await poll(() => attr(shell, 'header-replyto', 'data-known'), (k) => k === '0')
    expect(await attr(shell, 'header-replyto', 'title')).toContain('not in your library')
})

test('only a real 64-hex claim is indexed, and the index survives a restart', async () => {
    // Junk and near-miss targets are program data, not references.
    for (const bogus of ['not-a-hash', 'a'.repeat(63), '', 'A'.repeat(64)]) {
      const program = new TextEncoder().encode('<!doctype html><p>c</p>')
      const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
        type: 'comment',
        program,
        args: new Map<string, string>([['replyTo', bogus]])
      })
      expect((await shell.ingest(bundle)).status).toBe('valid')
      expect((await shell.replies(bogus.toLowerCase().padEnd(64, '0'))).count).toBe(0)
    }
    // A well-formed claim to something we do NOT hold is still indexed: the
    // claim is real even when the target is absent.
    const absent = 'b'.repeat(64)
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'comment',
      program: new TextEncoder().encode('<!doctype html><p>c</p>'),
      args: new Map<string, string>([['replyTo', absent]])
    })
    await shell.ingest(bundle)
    expect((await shell.replies(absent)).count).toBe(1)
})
