import {
  test,
  expect,
  launchShell,
  buildBundle,
  buildSealedBundle,
  buildTar,
  ethSigner,
  nostrSigner,
  secp256k1,
  schnorr,
  parseBundle,
  tarFromSource,
  type ShellHandle
} from './helpers.js'

// ── Admission: hostile-input battery + isolation (brief §1, §6) ──────────────
// Each case asserts the correct DISTINCT outcome AND that the keyring process
// survived (a subsequent valid admit still works). Admission runs the structural
// decode in an isolated utilityProcess; the crypto runs in the keyring process.

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell({
    extraEnv: {
      // Small caps so oversized / tar-bomb cases use tiny payloads.
      SHELL_MAX_BUNDLE_BYTES: String(64 * 1024),
      SHELL_MAX_TOTAL_BYTES: String(48 * 1024),
      SHELL_MAX_ENTRY_BYTES: String(32 * 1024),
      SHELL_WORKER_ALLOW_TEST_CRASH: '1',
      SHELL_WORKER_TIMEOUT_MS: '2000'
    }
  })
})
test.afterAll(async () => {
  await shell?.close()
})

/** After any hostile input, the keyring process must still admit a valid bundle. */
async function assertKeyringSurvives(): Promise<void> {
  const good = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()))
  const r = await shell.admit(good)
  expect(r.status).toBe('valid')
}

test.describe('admission outcomes', () => {
  test('valid: a well-formed public bundle is admitted', async () => {
    const priv = secp256k1.utils.randomSecretKey()
    const bundle = await buildBundle(ethSigner(priv), {
      type: 'note',
      attachments: { poster: new Uint8Array([1, 2, 3, 4]) }
    })
    const r = await shell.admit(bundle)
    expect(r.status).toBe('valid')
    expect(r.type).toBe('note')
    expect(r.sealed).toBe(false)
    expect(r.attachments).toEqual(['poster'])
    expect((r.author as { scheme: string }).scheme).toBe('eth-eip191')
  })

  test('invalid: a flipped signature bit (alarm)', async () => {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()))
    // Corrupt a byte in the envelope region (start of the tar's first entry data).
    bundle[520] ^= 0xff
    const r = await shell.admit(bundle)
    expect(r.status).toBe('invalid')
    await assertKeyringSurvives()
  })

  test('invalid: a tampered manifest (hash mismatch)', async () => {
    const priv = secp256k1.utils.randomSecretKey()
    const bundle = await buildBundle(ethSigner(priv), { type: 'note' })
    // Parse, corrupt a manifest byte precisely, re-tar: sha256(manifest) no
    // longer equals envelope.man, so §8.1 step 5 rejects.
    const src = parseBundle(bundle)
    src.manifest![3] ^= 0xff
    const r = await shell.admit(tarFromSource(src))
    expect(r.status).toBe('invalid')
    await assertKeyringSurvives()
  })

  test('invalid: a tampered program (hash mismatch)', async () => {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()))
    const src = parseBundle(bundle)
    src.program![0] ^= 0xff
    const r = await shell.admit(tarFromSource(src))
    expect(r.status).toBe('invalid')
  })

  test('invalid: a tampered attachment (hash mismatch, no partial admission)', async () => {
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
      attachments: { poster: new Uint8Array([1, 2, 3, 4]) }
    })
    const src = parseBundle(bundle)
    const key = [...src.blobs.keys()][0]!
    src.blobs.set(key, new Uint8Array([9, 9, 9, 9])) // wrong bytes for this hash
    const r = await shell.admit(tarFromSource(src))
    expect(r.status).toBe('invalid')
  })

  test('unverifiable: an unknown signature scheme (cannot check, not failed)', async () => {
    const signer = {
      scheme: 'zzz-unknown-scheme',
      pubkey: new Uint8Array(20).fill(3),
      async sign() {
        return new Uint8Array(65)
      }
    }
    const bundle = await buildBundle(signer)
    const r = await shell.admit(bundle)
    expect(r.status).toBe('unverifiable')
    expect(r.scheme).toBe('zzz-unknown-scheme')
    await assertKeyringSurvives()
  })

  test('not-for-me: a sealed bundle addressed to someone else (neutral)', async () => {
    const author = nostrSigner(secp256k1.utils.randomSecretKey())
    const strangerPub = schnorr.getPublicKey(secp256k1.utils.randomSecretKey())
    const bundle = await buildSealedBundle(author, [strangerPub])
    const r = await shell.admit(bundle)
    expect(r.status).toBe('not-for-me')
    await assertKeyringSurvives()
  })

  test('valid: a sealed bundle addressed to us unseals and admits', async () => {
    const author = nostrSigner(secp256k1.utils.randomSecretKey())
    const me = await shell.identity()
    const myNostrPub = Uint8Array.from(me.nostrPubkey.match(/../g)!.map((h) => parseInt(h, 16)))
    const bundle = await buildSealedBundle(author, [myNostrPub])
    const r = await shell.admit(bundle)
    expect(r.status).toBe('valid')
    expect(r.sealed).toBe(true)
  })

  test('invalid + bounded: an oversized bundle is refused', async () => {
    // Exceed SHELL_MAX_BUNDLE_BYTES (64 KiB) with a single big entry.
    const bundle = buildTar({ 'envelope.cbor': new Uint8Array(80 * 1024) })
    const r = await shell.admit(bundle)
    expect(r.status).toBe('invalid')
    await assertKeyringSurvives()
  })

  test('invalid + bounded: a tar-bomb (small archive, huge expansion) is refused', async () => {
    // Many entries whose total exceeds SHELL_MAX_TOTAL_BYTES (48 KiB).
    const files: Record<string, Uint8Array> = { 'envelope.cbor': new Uint8Array(8 * 1024) }
    for (let i = 0; i < 12; i++) files[`blobs/${'0'.repeat(64).slice(0, 63)}${i}`] = new Uint8Array(8 * 1024)
    const bundle = buildTar(files)
    const r = await shell.admit(bundle)
    expect(r.status).toBe('invalid')
    await assertKeyringSurvives()
  })

  test('invalid: non-canonical CBOR that decodes but is not canonical', async () => {
    // envelope.cbor = a map with a non-shortest integer key (0x1801 = int 1).
    // Structurally decodes; canonical validation rejects it.
    const nonCanonical = Uint8Array.from([0xa1, 0x18, 0x01, 0x01]) // {1(as 2 bytes): 1}
    const bundle = buildTar({ 'envelope.cbor': nonCanonical })
    const r = await shell.admit(bundle)
    expect(r.status).toBe('invalid')
    await assertKeyringSurvives()
  })

  test('invalid: a bundle with no envelope.cbor', async () => {
    const bundle = buildTar({ program: new Uint8Array([1, 2, 3]) })
    const r = await shell.admit(bundle)
    expect(r.status).toBe('invalid')
  })
})

test.describe('worker isolation', () => {
  test('a worker that dies mid-admission is survived; the bundle is rejected', async () => {
    const before = await shell.identity()

    // The worker recognizes a sentinel and process.exit(1)s mid-decode.
    const crashExit = new TextEncoder().encode('THINGCRASH:exit\n')
    const r1 = await shell.admit(crashExit)
    expect(r1.status).toBe('invalid')
    expect(String(r1.reason)).toMatch(/isolation|exited|decode/i)

    // The keyring process (this one) is untouched: identity unchanged, and a
    // valid bundle still admits.
    const after = await shell.identity()
    expect(after.address).toBe(before.address)
    await assertKeyringSurvives()
  })

  test('a worker that hangs mid-admission is killed on timeout; main survives', async () => {
    const crashHang = new TextEncoder().encode('THINGCRASH:hang\n')
    const r = await shell.admit(crashHang)
    expect(r.status).toBe('invalid')
    expect(String(r.reason)).toMatch(/isolation|timed out|decode/i)
    await assertKeyringSurvives()
  })
})
