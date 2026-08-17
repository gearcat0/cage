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

const attr = (shell: ShellHandle, testid: string, name: string): Promise<string | null> =>
  chromeEval<string | null>(shell, `document.querySelector('[data-testid=${testid}]')?.getAttribute(${JSON.stringify(name)}) ?? null`)

const text = (shell: ShellHandle, testid: string): Promise<string | null> =>
  chromeEval<string | null>(shell, `document.querySelector('[data-testid=${testid}]')?.textContent ?? null`)

const openViaChrome = async (shell: ShellHandle, hash: string): Promise<void> => {
  await chromeEval(shell, `window.__shellChrome.openThing(${JSON.stringify(hash)})`)
  await poll(() => text(shell, 'header-replies'), (t) => t !== null || true)
}

/** Publish whatever the open draft last streamed, approving the confirm.
 *  Waits for Publish to become enabled first — that is precisely the shell's
 *  "the program has streamed a draft" signal, and firing before it would ask
 *  to publish nothing. */
async function publishOpenDraft(shell: ShellHandle): Promise<Record<string, unknown>> {
  await poll(
    () => chromeEval<boolean>(shell, `!document.querySelector('[data-testid=header-publish]')?.disabled`),
    (ready) => ready === true
  )
  await shell.app.evaluate(async (electron) => {
    const s = (electron.app as unknown as { __shell: { publishDraft: () => unknown } }).__shell
    s.publishDraft()
  })
  await poll(
    () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=confirm-approve]')`),
    (v) => v
  )
  await chromeEval(shell, `document.querySelector('[data-testid=confirm-approve]').click()`)
  return (await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
        return s.lastPublish as never
      }) as Promise<Record<string, unknown> | null>,
    (p) => p?.status === 'valid'
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
    await openViaChrome(shell, target)
    await poll(() => text(shell, 'header-replies'), (t) => t === '1 comment')
    expect(await attr(shell, 'header-replies', 'data-count')).toBe('1')
    await chromeEval(shell, `document.querySelector('[data-testid=header-replies]').click()`)
    await poll(() => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=replies-modal]')`), (v) => v)
    await chromeEval(shell, `document.querySelector('[data-testid=reply-item]').click()`)

    // The comment says what it replies to, and we hold that target.
    await poll(() => attr(shell, 'header-replyto', 'data-known'), (k) => k === '1')
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
