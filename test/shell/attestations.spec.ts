import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Attestations ─────────────────────────────────────────────────────────────
// N people putting a signature behind a statement about one thing.
//
// The signature is real: it proves WHO said something. The statement is not —
// anyone may attest to anything, the target's author never agreed, and five
// attestations do not make a thing true. So what is pinned here is as much
// about what the shell must NOT say as what it counts.

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

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what = '', timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) {
      throw new Error(
        `poll timed out${what ? ` waiting for ${what}` : ''}; last value: ${JSON.stringify(value)}` +
          (last ? `; last error: ${(last as Error).message}` : '')
      )
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Publish whatever the open draft last streamed, approving the confirm. */
async function publishOpenDraft(): Promise<Record<string, unknown>> {
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
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v, 'the confirm')
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  return (await poll(
    () =>
      shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
        return s.lastPublish as never
      }) as Promise<Record<string, unknown> | null>,
    (p) => p?.status === 'valid',
    'the publish to resolve'
  )) as Record<string, unknown>
}

const ingestNametag = async (): Promise<string> => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'nametag',
    program: new Uint8Array(NAMETAG)
  })
  return (await shell.ingest(bundle)).envelopeHash as string
}

test('several people can attest to one thing, and each signature stands alone', async () => {
  const target = await ingestNametag()
  expect((await shell.attestations(target)).count).toBe(0)

  // Three attestations by three different keys, built and admitted directly —
  // the point is N signers, and each is its own signed thing.
  const signers = [1, 2, 3].map(() => ethSigner(secp256k1.utils.randomSecretKey()))
  const authors: string[] = []
  for (const [i, signer] of signers.entries()) {
    const bundle = await buildBundle(signer, {
      type: 'attestation',
      program: new TextEncoder().encode('<!doctype html><p>a</p>'),
      args: new Map<string, string>([
        ['attests', target],
        ['statement', 'Accurately reproduced from the original source'],
        ['note', `checked by ${i}`]
      ])
    })
    const outcome = await shell.ingest(bundle)
    expect(outcome.status).toBe('valid')
    authors.push((outcome.author as { k: string }).k)
  }

  const got = await shell.attestations(target)
  expect(got.count).toBe(3)
  expect(got.rows.length).toBe(3)
  // Each carries its own author: the list is WHO said it, never a score.
  expect(new Set(got.rows.map((r) => r.authorKey)).size).toBe(3)
  for (const a of authors) expect(got.rows.some((r) => r.authorKey === a)).toBe(true)

  // Attestations are counted separately from comments — they are different
  // claims and must not be conflated.
  expect((await shell.replies(target)).count).toBe(0)
})

test('the shell seeds the target, and the header counts without vouching', async () => {
  const target = await ingestNametag()
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(target)})`)
  await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=header-attestations]')?.textContent ?? null`),
    (t) => t === 'no attestations',
    'the header to show no attestations yet'
  )

  // Attest seeds the hash the program could never learn by itself.
  await chromeEval(`document.querySelector('[data-testid=header-attest]').click()`)
  const drafts = await poll(() => shell.drafts(), (d) => d.length === 1, 'the attestation draft')
  expect((drafts[0]!.args as { attests?: string }).attests).toBe(target)
  expect(drafts[0]!.type).toBe('attestation')

  const published = await publishOpenDraft()
  expect(published.status).toBe('valid')
  expect((await shell.attestations(target)).count).toBe(1)

  // Back on the target: the count is visible, and the wording claims nothing.
  await poll(
    async () => {
      await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(target)})`)
      return chromeEval<string | null>(
        `document.querySelector('[data-testid=header-attestations]')?.textContent ?? null`
      )
    },
    (t) => t === '1 attestation',
    'the count to reach the header'
  )

  // The list says who, and explicitly declines to say it makes anything true.
  await chromeEval(`document.querySelector('[data-testid=header-attestations]').click()`)
  const modalText = await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=attestations-modal]')?.textContent ?? null`),
    (t) => t !== null,
    'the attestations modal'
  )
  expect(modalText).toContain('proves who said it')
  expect(modalText).not.toContain('✓') // reserved for signatures and verified names
  expect(modalText).toMatch(/not that it is true/i)
})

test('an attestation about a thing you do not hold says so', async () => {
  // A well-formed claim to something absent is still indexed — the claim is
  // real even when the target is not here.
  const absent = 'c'.repeat(64)
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'attestation',
    program: new TextEncoder().encode('<!doctype html><p>a</p>'),
    args: new Map<string, string>([
      ['attests', absent],
      ['statement', 'I have read this']
    ])
  })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status).toBe('valid')
  expect((await shell.attestations(absent)).count).toBe(1)

  // Opening it: the header carries the claim and marks the target as not held.
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(outcome.envelopeHash)})`)
  const known = await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=header-attests]')?.getAttribute('data-known') ?? null`),
    (v) => v === '0',
    'the header to report the target as not held'
  )
  expect(known).toBe('0')
  const title = await chromeEval<string | null>(
    `document.querySelector('[data-testid=header-attests]')?.getAttribute('title') ?? null`
  )
  expect(title).toContain('not in your library')
})

test('junk targets are program data, not references', async () => {
  for (const bogus of ['not-a-hash', 'd'.repeat(63), '', 'D'.repeat(64)]) {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'attestation',
      program: new TextEncoder().encode('<!doctype html><p>a</p>'),
      args: new Map<string, string>([['attests', bogus]])
    })
    expect((await shell.ingest(bundle)).status).toBe('valid')
    expect((await shell.attestations(bogus.toLowerCase().padEnd(64, '0'))).count).toBe(0)
  }
})
