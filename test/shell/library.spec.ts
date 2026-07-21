import {
  test,
  expect,
  launchShell,
  buildBundle,
  buildSealedBundle,
  ethSigner,
  nostrSigner,
  secp256k1,
  type ShellHandle
} from './helpers.js'

// ── Library (brief §4): index + CAS, received-at ordering, fork detection ────

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

const hashOf = (o: Record<string, unknown>): string => o.envelopeHash as string

test('ingest admits a valid bundle into the feed', async () => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'note' })
  const r = await shell.ingest(bundle)
  expect(r.status).toBe('valid')
  const feed = await shell.feed()
  expect(feed.some((row) => row.envelopeHash === hashOf(r))).toBe(true)
  const row = feed.find((x) => x.envelopeHash === hashOf(r))!
  expect(row.type).toBe('note')
  expect(row.sealed).toBe(false)
})

test('the feed orders by received-at, not by the author-claimed `created`', async () => {
  // A is ingested first but claims a FAR-FUTURE `created`; B is ingested later
  // with a smaller `created`. Received-order (B before A) must win.
  const signer = ethSigner(secp256k1.utils.randomSecretKey())
  const a = await buildBundle(signer, { type: 'ordered-a', created: 9_000_000_000 })
  const b = await buildBundle(signer, { type: 'ordered-b', created: 1 })
  const ra = await shell.ingest(a)
  await new Promise((r) => setTimeout(r, 20))
  const rb = await shell.ingest(b)
  const feed = await shell.feed()
  const idxA = feed.findIndex((x) => x.envelopeHash === hashOf(ra))
  const idxB = feed.findIndex((x) => x.envelopeHash === hashOf(rb))
  expect(idxB).toBeLessThan(idxA) // B (received later) is newer in the feed
})

test('re-ingesting the same bundle is idempotent (no duplicate row)', async () => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'dup' })
  const r1 = await shell.ingest(bundle)
  const before = (await shell.feed()).length
  const r2 = await shell.ingest(bundle)
  expect(hashOf(r2)).toBe(hashOf(r1))
  expect((await shell.feed()).length).toBe(before)
})

test('fork detection: same (author, path, seq), different hash → both flagged', async () => {
  const signer = ethSigner(secp256k1.utils.randomSecretKey())
  // Two DIFFERENT things (different type → different manifest → different
  // envelope hash) claiming the same position in the author's history.
  const one = await buildBundle(signer, { type: 'fork-a', path: 'event/bbq', seq: 1 })
  const two = await buildBundle(signer, { type: 'fork-b', path: 'event/bbq', seq: 1 })
  const r1 = await shell.ingest(one)
  const r2 = await shell.ingest(two)
  expect(r2.status).toBe('valid')
  const feed = await shell.feed()
  const row1 = feed.find((x) => x.envelopeHash === hashOf(r1))!
  const row2 = feed.find((x) => x.envelopeHash === hashOf(r2))!
  // The second collides with the first at (author,path,seq): BOTH are surfaced
  // as a fork, never silently deduped.
  expect(row2.isFork).toBe(true)
  expect(row1.isFork).toBe(true)
})

test('a sealed thing is decrypted, mountable, and never written to disk (§7.1)', async () => {
  const MAGIC = 'CAGE_SEALED_CONTENT_MAGIC_4b91ef'
  const author = nostrSigner(secp256k1.utils.randomSecretKey())
  const me = await shell.identity()
  const myNostrPub = Uint8Array.from(me.nostrPubkey.match(/../g)!.map((h) => parseInt(h, 16)))

  // The sealed program AND an attachment both carry the magic marker.
  const program = new TextEncoder().encode(`<!doctype html><h1>${MAGIC}</h1>`)
  const poster = new TextEncoder().encode(`poster-${MAGIC}`)
  const before = shell.casBlobs().length
  const sealed = await buildSealedBundle(author, [myNostrPub], {
    type: 'sealed-event',
    program,
    attachments: { poster }
  })
  const r = await shell.ingest(sealed)
  expect(r.status).toBe('valid')
  expect(r.sealed).toBe(true)
  // The sealed content is fully recovered — the attachment is present.
  expect(r.attachments).toEqual(['poster'])

  // Nothing sealed hit the persistent CAS...
  expect(shell.casBlobs().length).toBe(before)
  // ...and the decrypted plaintext is NOWHERE on disk (userData tree scan).
  expect(shell.scanUserData(new TextEncoder().encode(MAGIC))).toEqual([])

  // Yet it is mountable: opening it returns the trust header (served from the
  // ephemeral in-memory store).
  const header = await shell.openThing(hashOf(r))
  expect(header.type).toBe('sealed-event')
  expect(header.sealed).toBe(true)
  // Still nothing on disk after mounting + serving.
  expect(shell.scanUserData(new TextEncoder().encode(MAGIC))).toEqual([])
})

test('mount: opening a public thing returns its trust header and marks it read', async () => {
  const signer = ethSigner(secp256k1.utils.randomSecretKey())
  const bundle = await buildBundle(signer, { type: 'mountable' })
  const r = await shell.ingest(bundle)
  const header = await shell.openThing(hashOf(r))
  expect(header.type).toBe('mountable')
  expect(header.authorScheme).toBe('eth-eip191')
  expect(header.envelopeHash).toBe(hashOf(r))
  // Opening marks it read in the feed.
  const feed = await shell.feed()
  expect(feed.find((x) => x.envelopeHash === hashOf(r))!.read).toBe(true)
})
