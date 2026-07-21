import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  test,
  expect,
  launchShell,
  buildBundle,
  buildTar,
  ethSigner,
  secp256k1,
  bundleTarHash,
  type ShellHandle
} from './helpers.js'

// ── Transport (brief phase 4) ────────────────────────────────────────────────
// Bytes arrive from anywhere; admission is still the only gate. These prove the
// fetch path is real, resource-bounded, and content-untrusted.

let shell: ShellHandle
let tmp: string
test.beforeAll(async () => {
  shell = await launchShell()
  tmp = mkdtempSync(join(tmpdir(), 'transport-'))
})
test.afterAll(async () => {
  await shell?.close()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function assertKeyringSurvives(): Promise<void> {
  const r = await shell.ingest(await buildBundle(ethSigner(secp256k1.utils.randomSecretKey())))
  expect(r.status).toBe('valid')
}

test('seed round-trip: an admitted bundle is re-fetchable by bundle:<hash>', async () => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'seeded' })
  const tarHash = bundleTarHash(bundle)

  const ingested = await shell.ingest(bundle)
  expect(ingested.status).toBe('valid')
  // The raw admitted bundle was retained in the seed store...
  expect(await shell.seedHas(tarHash)).toBe(true)

  // ...and fetching it back by its content-addressed locator admits the SAME
  // envelope (idempotent — already in the library).
  const fetched = await shell.fetchLocator(`bundle:${tarHash}`)
  expect(fetched.status).toBe('valid')
  expect(fetched.envelopeHash).toBe(ingested.envelopeHash)
})

test('bundle:<hash> for an unknown hash fails cleanly (not in seed store)', async () => {
  const r = await shell.fetchLocator(`bundle:${'0'.repeat(64)}`)
  expect(r.status).toBe('invalid')
  expect(String(r.reason)).toMatch(/transport|not found/i)
  await assertKeyringSurvives()
})

test('file: fetches a bundle from disk and admits it', async () => {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'from-file' })
  const path = join(tmp, 'a.thing')
  writeFileSync(path, bundle)
  const r = await shell.fetchLocator(`file:${path}`)
  expect(r.status).toBe('valid')
  expect(r.type).toBe('from-file')
})

test('verify-at-the-gate: a transport delivering HOSTILE bytes is rejected by admission', async () => {
  // A file: fetch returns whatever bytes are on disk — admission is the gate.
  const garbage = buildTar({ 'envelope.cbor': new Uint8Array(64).fill(0xff) })
  const path = join(tmp, 'hostile.thing')
  writeFileSync(path, garbage)
  const r = await shell.fetchLocator(`file:${path}`)
  expect(r.status).toBe('invalid')
  // Nothing was admitted, and the keyring process is untouched.
  await assertKeyringSurvives()
})

test('magnet: routes to the webtorrent transport and degrades cleanly when absent', async () => {
  const r = await shell.fetchLocator('magnet:?xt=urn:btih:0000000000000000000000000000000000000000')
  expect(r.status).toBe('invalid')
  // webtorrent is not installed in CI — a clear, actionable error, not a crash.
  expect(String(r.reason)).toMatch(/webtorrent/i)
  await assertKeyringSurvives()
})

test('an oversized fetch is refused by the size cap (end to end)', async () => {
  // A dedicated shell with a tiny fetch cap; a bundle over it is refused.
  const capped = await launchShell({ extraEnv: { SHELL_MAX_FETCH_BYTES: '2048' } })
  try {
    const big = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      type: 'big',
      attachments: { blob: new Uint8Array(8192) }
    })
    const path = join(tmp, 'big.thing')
    writeFileSync(path, big)
    const r = await capped.fetchLocator(`file:${path}`)
    expect(r.status).toBe('invalid')
    expect(String(r.reason)).toMatch(/maxBytes|exceed/i)
  } finally {
    await capped.close()
  }
})
