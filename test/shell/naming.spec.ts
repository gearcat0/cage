import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  test,
  expect,
  launchShell,
  buildBundle,
  ethSigner,
  ethAddress,
  secp256k1,
  type ShellHandle
} from './helpers.js'

// ── Naming (brief phase 5) ───────────────────────────────────────────────────
// A name is shown as verified ONLY when it provably maps to the admitted thing's
// author key. ENS is mocked via SHELL_ENS_MOCK (deterministic, no network).

const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

let shell: ShellHandle
let tmp: string
let alicePriv: Uint8Array
let aliceAddr: string
let evilAddr: string

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'naming-'))

  // alice.eth ↔ alicePriv's address (a matching binding).
  alicePriv = secp256k1.utils.randomSecretKey()
  aliceAddr = hexOf(ethAddress(alicePriv))
  const aliceBundle = await buildBundle(ethSigner(alicePriv), { type: 'alice-thing' })
  const alicePath = join(tmp, 'alice.thing')
  writeFileSync(alicePath, aliceBundle)

  // evil.eth's `thing` record points at a bundle signed by a DIFFERENT key —
  // evil.eth forward-resolves to alice's address, but the content is by evilKey.
  const evilKey = secp256k1.utils.randomSecretKey()
  evilAddr = hexOf(ethAddress(evilKey))
  const evilBundle = await buildBundle(ethSigner(evilKey), { type: 'evil-thing' })
  const evilPath = join(tmp, 'evil.thing')
  writeFileSync(evilPath, evilBundle)

  const mock = {
    forward: { 'alice.eth': `0x${aliceAddr}`, 'evil.eth': `0x${aliceAddr}` },
    reverse: { [`0x${aliceAddr}`]: 'alice.eth' },
    text: {
      'alice.eth': { thing: `file:${alicePath}` },
      'evil.eth': { thing: `file:${evilPath}` }
    }
  }
  shell = await launchShell({ extraEnv: { SHELL_ENS_MOCK: JSON.stringify(mock) } })
})

test.afterAll(async () => {
  await shell?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

test('fetch by name: resolve alice.eth → locator → admit, forward-verified', async () => {
  const r = await shell.fetchLocator('alice.eth')
  expect(r.status).toBe('valid')
  expect(r.type).toBe('alice-thing')
  // The admitted author is confirmed to be alice.eth.
  const nv = r.nameVerification as { status: string; name?: string }
  expect(nv.status).toBe('verified')
  expect(nv.name).toBe('alice.eth')
})

test('the trust header shows a VERIFIED name for an author with a confirmed ENS name', async () => {
  const ingested = await shell.fetchLocator('alice.eth')
  const header = await shell.openThing(ingested.envelopeHash as string)
  expect(header.name).toBe('alice.eth')
  expect(header.nameStatus).toBe('verified')
  expect(header.authorKey).toBe(aliceAddr)
})

test('an author with no ENS name shows the raw key (unverified), not a name', async () => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'anon' })
  const r = await shell.ingest(bundle)
  const header = await shell.openThing(r.envelopeHash as string)
  expect(header.name).toBeNull()
  expect(header.nameStatus).toBe('unresolvable')
})

test('MISMATCH: a name whose content is by a different author is NOT shown as verified', async () => {
  // evil.eth resolves to alice's address, but its `thing` is signed by evilKey.
  const r = await shell.fetchLocator('evil.eth')
  expect(r.status).toBe('valid') // the bundle itself is validly signed...
  const nv = r.nameVerification as { status: string }
  expect(nv.status).toBe('mismatch') // ...but it is NOT by evil.eth's claimed key
  // And its trust header shows the raw key, not "evil.eth".
  const header = await shell.openThing(r.envelopeHash as string)
  expect(header.name).toBeNull()
  expect(header.authorKey).toBe(evilAddr)
})

test('an npub / NIP-05 name degrades cleanly (Nostr not yet supported)', async () => {
  const r = await shell.fetchLocator('npub1nostrnamedoesnotexist')
  expect(r.status).toBe('invalid')
  expect(String(r.reason)).toMatch(/naming|nostr/i)
})
