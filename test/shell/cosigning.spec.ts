import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  test,
  expect,
  launchShell,
  buildBundle,
  ethSigner,
  ethAddress,
  secp256k1,
  parseBundle,
  cosignBundle,
  type ShellHandle
} from './helpers.js'

// ── Co-signing ───────────────────────────────────────────────────────────────
// A contract with two parties and two witnesses: one document, four signatures.
//
// The DOCUMENT is the manifest; an envelope is one signature over it. Nothing
// in the format changed to allow this — a manifest has no author and no nonce,
// so several envelopes can share one `man` hash, each independently verified.
// The rejected alternative was a `sigs[]` array inside the envelope: every
// added signature would change the envelope hash, so the document's identity
// would shift as it was signed.
//
// What is pinned here is mostly the honesty. "2 of 4 signed" is not a validity
// score, being NAMED is not consent and not a signature, and a signature the
// document never asked for is still real and must not be hidden.

const CONTRACT = readFileSync(join(__dirname, '..', '..', 'samples', 'contract.html'))
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

const hexKey = (priv: Uint8Array): string =>
  Array.from(ethAddress(priv))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** A contract naming `signers`, authored and signed by `priv`. */
async function contract(
  priv: Uint8Array,
  signers: { key: string; role: string; name?: string }[],
  title = 'Lease agreement'
): Promise<{ envelopeHash: string; manifestHash: string; bundle: Uint8Array }> {
  const args = new Map<string, unknown>([
    ['title', title],
    ['body', 'The tenant shall keep the premises in good repair.'],
    [
      'signers',
      signers.map(
        (sg) =>
          new Map<string, string>([
            ['key', sg.key],
            ['scheme', 'eth-eip191'],
            ['role', sg.role],
            ['name', sg.name ?? '']
          ])
      )
    ]
  ])
  const bundle = await buildBundle(ethSigner(priv), { type: 'contract', program: new Uint8Array(CONTRACT), args })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status, JSON.stringify(outcome)).toBe('valid')
  const rows = (await shell.feed()) as { envelopeHash: string; manifestHash: string }[]
  const row = rows.find((r) => r.envelopeHash === outcome.envelopeHash)!
  return { envelopeHash: row.envelopeHash, manifestHash: row.manifestHash, bundle }
}

/** Somebody else signs the document: a second envelope over the SAME manifest
 *  bytes, taken verbatim from the original bundle. */
async function cosignAs(priv: Uint8Array, doc: { bundle: Uint8Array }): Promise<Uint8Array> {
  const parts = parseBundle(doc.bundle)
  if (!parts.manifest || !parts.program) throw new Error('the contract bundle is missing its manifest or program')
  return cosignBundle(ethSigner(priv), { manifestBytes: parts.manifest, program: parts.program })
}

test('four signatures over one document: same manifest, four envelopes', async () => {
  const parties = [secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey()]
  const witnesses = [secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey()]
  const named = [
    { key: hexKey(parties[0]!), role: 'party', name: 'Landlord' },
    { key: hexKey(parties[1]!), role: 'party', name: 'Tenant' },
    { key: hexKey(witnesses[0]!), role: 'witness' },
    { key: hexKey(witnesses[1]!), role: 'witness' }
  ]
  const doc = await contract(parties[0]!, named)

  // Signed by the drafter only, so far.
  let facts = await shell.document(doc.manifestHash)
  expect(facts.cosignable).toBe(true)
  expect(facts.namedCount).toBe(4)
  expect(facts.namedSignedCount).toBe(1)

  // The other three sign the SAME manifest bytes, each producing their own
  // envelope. This is the whole feature.
  for (const priv of [parties[1]!, witnesses[0]!, witnesses[1]!]) {
    const bundle = await cosignAs(priv, doc)
    expect((await shell.ingest(bundle)).status).toBe('valid')
  }

  facts = await shell.document(doc.manifestHash)
  expect(facts.signedCount).toBe(4)
  expect(facts.namedSignedCount).toBe(4)
  expect(facts.unnamedSignedCount).toBe(0)
  // Four distinct signers, four distinct envelopes, one document.
  expect(new Set(facts.signatures.map((s) => s.authorKey)).size).toBe(4)
  expect(new Set(facts.signatures.map((s) => s.envelopeHash)).size).toBe(4)
})

test('the document appears ONCE in the feed however many have signed it', async () => {
  const a = secp256k1.utils.randomSecretKey()
  const b = secp256k1.utils.randomSecretKey()
  const doc = await contract(a, [
    { key: hexKey(a), role: 'party' },
    { key: hexKey(b), role: 'party' }
  ])
  await shell.ingest(await cosignAs(b, doc))

  const rows = (await shell.feed()) as { envelopeHash: string; manifestHash: string }[]
  expect(rows.filter((r) => r.manifestHash === doc.manifestHash).length, 'one document, one row').toBe(1)
  // The library still holds both signatures — the feed collapses the view, it
  // does not throw anything away.
  expect((await shell.document(doc.manifestHash)).signedCount).toBe(2)
})

test('an ordinary Copy still gets its own feed row', async () => {
  // Regression guard for the collapse above. A copy also shares a manifest
  // hash (a manifest has no author and no nonce), so the collapse MUST be
  // scoped to documents that name signatories, or Copy would silently vanish.
  await shell.compose(NAMETAG.toString('base64'), 'nametag')
  const rows = (await shell.feed()) as { envelopeHash: string }[]
  const before = rows.length
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(rows[0]!.envelopeHash)})`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=header-copy]')`), (v) => v, 'copy')
  await chromeEval(`document.querySelector('[data-testid=header-copy]').click()`)
  await poll(() => shell.feed(), (f) => (f as unknown[]).length === before + 1, 'the copy to appear')
})

test('Copy is refused on a document that names signatories', async () => {
  // Copy rebuilds the same program/type/args, which over a named document IS a
  // co-signature. Doing that silently would put the human's key on a contract
  // they only meant to duplicate.
  const a = secp256k1.utils.randomSecretKey()
  const doc = await contract(a, [{ key: hexKey(a), role: 'party' }])
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(doc.envelopeHash)})`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=header-copy]')`), (v) => v, 'copy')
  await chromeEval(`document.querySelector('[data-testid=header-copy]').click()`)
  // The refusal surfaces as a message, and nothing is signed.
  await new Promise((r) => setTimeout(r, 600))
  expect((await shell.document(doc.manifestHash)).signedCount, 'Copy must not have signed it').toBe(1)
  const feedRows = (await shell.feed()) as { manifestHash: string }[]
  expect(feedRows.filter((r) => r.manifestHash === doc.manifestHash).length).toBe(1)
})

test('being NAMED is not a signature, and an unnamed signature is still real', async () => {
  const drafter = secp256k1.utils.randomSecretKey()
  const invited = secp256k1.utils.randomSecretKey()
  const stranger = secp256k1.utils.randomSecretKey()
  const doc = await contract(drafter, [
    { key: hexKey(drafter), role: 'party' },
    { key: hexKey(invited), role: 'party', name: 'Never signed' }
  ])

  // The invited party is named but has not signed: named ≠ signed.
  let facts = await shell.document(doc.manifestHash)
  expect(facts.namedCount).toBe(2)
  expect(facts.namedSignedCount).toBe(1)
  expect(facts.namedSigners.find((n) => n.key === hexKey(invited))?.signed).toBe(false)

  // Someone the document never named signs it anyway. That signature is as
  // valid as any other — it is reported, marked, and never dropped.
  await shell.ingest(await cosignAs(stranger, doc))
  facts = await shell.document(doc.manifestHash)
  expect(facts.signedCount).toBe(2)
  expect(facts.namedSignedCount, 'the invited party still has not signed').toBe(1)
  expect(facts.unnamedSignedCount).toBe(1)
  const uninvited = facts.signatures.find((sg) => sg.authorKey === hexKey(stranger))!
  expect(uninvited.named).toBe(false)
})

test('the header counts signatures without ever scoring the document', async () => {
  const me = await shell.identity()
  const other = secp256k1.utils.randomSecretKey()
  const doc = await contract(other, [
    { key: hexKey(other), role: 'party' },
    { key: me.address, role: 'party' },
    { key: hexKey(secp256k1.utils.randomSecretKey()), role: 'witness' }
  ])

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(doc.envelopeHash)})`)
  const badge = await poll(
    () =>
      chromeEval<{ text: string | null; title: string | null } | null>(
        `(() => {
          const b = document.querySelector('[data-testid=header-signatures]')
          return b ? { text: b.textContent, title: b.getAttribute('title') } : null
        })()`
      ),
    (v) => v !== null,
    'the signature badge'
  )
  expect(badge!.text).toBe('1 of 3 signed')
  // Never a tick, never a percentage, and it says outright what it is not.
  expect(badge!.text).not.toContain('✓')
  expect(badge!.text).not.toContain('%')
  expect(badge!.title).toMatch(/not a measure of how valid/i)

  // The modal separates the fact (who signed) from the claim (who is named).
  await chromeEval(`document.querySelector('[data-testid=header-signatures]').click()`)
  const text = await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=signatures-modal]')?.textContent ?? null`),
    (t) => t !== null,
    'the signatures modal'
  )
  expect(text).toMatch(/does not prove they read it/i)
  expect(text).toMatch(/not a verdict/i)
  expect(await chromeEval<number>(`document.querySelectorAll('[data-testid=signature-missing]').length`)).toBe(2)
})

test('co-signing goes through a confirm that says what signing means', async () => {
  const me = await shell.identity()
  const other = secp256k1.utils.randomSecretKey()
  const doc = await contract(other, [
    { key: hexKey(other), role: 'party' },
    { key: me.address, role: 'party', name: 'You' }
  ])

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(doc.envelopeHash)})`)
  await poll(
    () => chromeEval<boolean>(`!!document.querySelector('[data-testid=header-cosign]')`),
    (v) => v,
    'the co-sign button'
  )
  await chromeEval(`document.querySelector('[data-testid=header-cosign]').click()`)

  const dialog = await poll(
    () => chromeEval<string | null>(`document.querySelector('.evm-modal')?.textContent ?? null`),
    (t) => t !== null && t.includes('signature'),
    'the co-sign confirm'
  )
  expect(dialog).toMatch(/cannot be withdrawn/i)
  // The document names this key — stated as the drafter's claim, not as consent
  // already given.
  const named = await chromeEval<string | null>(
    `document.querySelector('[data-testid=cosign-named]')?.getAttribute('data-named') ?? null`
  )
  expect(named).toBe('1')
  expect(dialog).toMatch(/has never bound you/i)

  // Nothing is signed until the human approves.
  expect((await shell.document(doc.manifestHash)).signedByMe).toBe(false)
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)

  const after = await poll(
    () => shell.document(doc.manifestHash),
    (f) => f.signedByMe === true,
    'the co-signature to land'
  )
  expect(after.signedCount).toBe(2)
  expect(after.namedSignedCount).toBe(2)
  expect(after.signatures.some((sg) => sg.authorKey === me.address)).toBe(true)
})

test('rejecting the confirm signs nothing', async () => {
  const me = await shell.identity()
  const other = secp256k1.utils.randomSecretKey()
  const doc = await contract(other, [
    { key: hexKey(other), role: 'party' },
    { key: me.address, role: 'party' }
  ])
  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(doc.envelopeHash)})`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=header-cosign]')`), (v) => v, 'co-sign')
  await chromeEval(`document.querySelector('[data-testid=header-cosign]').click()`)
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-reject]')`), (v) => v, 'confirm')
  await chromeEval(`document.querySelector('[data-testid=confirm-reject]').click()`)

  await new Promise((r) => setTimeout(r, 500))
  const facts = await shell.document(doc.manifestHash)
  expect(facts.signedByMe).toBe(false)
  expect(facts.signedCount).toBe(1)
})

test('you cannot sign the same document twice', async () => {
  const me = await shell.identity()
  const other = secp256k1.utils.randomSecretKey()
  const doc = await contract(other, [{ key: me.address, role: 'party' }])

  const first = await shell.cosign(doc.envelopeHash)
  expect(first.status).toBe('pending')
  await poll(() => chromeEval<boolean>(`!!document.querySelector('[data-testid=confirm-approve]')`), (v) => v, 'confirm')
  await chromeEval(`document.querySelector('[data-testid=confirm-approve]').click()`)
  await poll(() => shell.document(doc.manifestHash), (f) => f.signedByMe, 'the signature')

  const again = await shell.cosign(doc.envelopeHash)
  expect(again.status).toBe('invalid')
  expect(String(again.reason)).toMatch(/already signed/i)
})

test('an ordinary thing is not a document awaiting signatures', async () => {
  // The co-signing vocabulary appears ONLY where signatories are declared.
  // Otherwise every nametag in the library would look like an unsigned contract.
  await shell.compose(NAMETAG.toString('base64'), 'nametag')
  const row = ((await shell.feed()) as { envelopeHash: string; manifestHash: string }[])[0]!
  expect((await shell.document(row.manifestHash)).cosignable).toBe(false)

  await chromeEval(`window.__shellChrome.openThing(${JSON.stringify(row.envelopeHash)})`)
  await poll(
    () => chromeEval<string | null>(`document.querySelector('[data-testid=header-author]')?.textContent ?? null`),
    () => true,
    'the header'
  )
  expect(await chromeEval<number>(`document.querySelectorAll('[data-testid=header-signatures]').length`)).toBe(0)
  expect(await chromeEval<number>(`document.querySelectorAll('[data-testid=header-cosign]').length`)).toBe(0)
})

test('a document with the text changed is a different document, not an amendment', async () => {
  // Immutability, from the signer's side: you cannot alter what you signed, and
  // you cannot sign an altered copy "as well". The manifest hash IS the
  // document, so a changed word produces a separate document with its own,
  // separate signatures.
  const a = secp256k1.utils.randomSecretKey()
  const named = [{ key: hexKey(a), role: 'party' }]
  const original = await contract(a, named, 'Lease agreement')
  const altered = await contract(a, named, 'Lease agreement (revised)')

  expect(altered.manifestHash).not.toBe(original.manifestHash)
  expect((await shell.document(original.manifestHash)).signedCount).toBe(1)
  expect((await shell.document(altered.manifestHash)).signedCount).toBe(1)
  // Signing the revision does not add a signature to the original.
  const b = secp256k1.utils.randomSecretKey()
  await shell.ingest(await cosignAs(b, altered))
  expect((await shell.document(original.manifestHash)).signedCount, 'the original is untouched').toBe(1)
  expect((await shell.document(altered.manifestHash)).signedCount).toBe(2)
})

test('junk signatories are program data, not parties', async () => {
  const a = secp256k1.utils.randomSecretKey()
  const doc = await contract(a, [
    { key: hexKey(a), role: 'party' },
    { key: 'not-a-key', role: 'party' },
    { key: '', role: 'witness' },
    { key: 'z'.repeat(40), role: 'witness' }
  ])
  const facts = await shell.document(doc.manifestHash)
  expect(facts.namedCount, 'only the one real key counts as a party').toBe(1)
})
