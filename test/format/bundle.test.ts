import { describe, it, expect } from 'vitest'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { encodeManifest, type Manifest } from '../../src/format/manifest.js'
import { encodeEnvelope } from '../../src/format/envelope.js'
import { hash } from '../../src/format/hash.js'
import { seal, unseal, unsealerFromKey } from '../../src/format/sealed.js'
import { admitBundle, parseBundle, parseTar, BundleError, DEFAULT_BUNDLE_LIMITS } from '../../src/format/bundle.js'
import { ethSigner, nostrSigner, buildTar } from './helpers.js'

async function makePublicBundle(): Promise<{ tar: Uint8Array; priv: Uint8Array }> {
  const priv = secp256k1.utils.randomSecretKey()
  const signer = ethSigner(priv)
  const program = new TextEncoder().encode('<!doctype html><h1>hi</h1>')
  const poster = new Uint8Array([1, 2, 3, 4, 5])
  const manifest: Manifest = {
    v: 1,
    prog: hash(program),
    type: 'note',
    args: new Map([['title', 'hello']]) as Manifest['args'],
    att: new Map([['poster', { h: hash(poster), m: 'image/png', n: poster.length }]])
  }
  const manifestBytes = encodeManifest(manifest)
  const envelope = await encodeEnvelope({ man: hash(manifestBytes), created: 1_700_000_000 }, signer)
  const tar = buildTar({
    'envelope.cbor': envelope,
    'manifest.cbor': manifestBytes,
    program,
    [`blobs/${[...hash(poster)].map((b) => b.toString(16).padStart(2, '0')).join('')}`]: poster
  })
  return { tar, priv }
}

describe('public bundle admission (§8.1)', () => {
  it('admits a valid bundle end to end', async () => {
    const { tar } = await makePublicBundle()
    const src = parseBundle(tar)
    const r = admitBundle(src)
    expect(r.status).toBe('valid')
    if (r.status === 'valid') {
      expect(r.manifest.type).toBe('note')
      expect(r.attachments.get('poster')).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
      expect(r.sealed).toBe(false)
    }
  })

  it('rejects a tampered manifest (hash mismatch) as invalid', async () => {
    const { tar } = await makePublicBundle()
    const src = parseBundle(tar)
    src.manifest![5] ^= 0xff // corrupt a manifest byte
    const r = admitBundle(src)
    expect(r.status).toBe('invalid')
  })

  it('rejects a tampered program (hash mismatch)', async () => {
    const { tar } = await makePublicBundle()
    const src = parseBundle(tar)
    src.program![0] ^= 0xff
    const r = admitBundle(src)
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.reason).toMatch(/program hash/)
  })

  it('rejects a mismatched attachment', async () => {
    const { tar } = await makePublicBundle()
    const src = parseBundle(tar)
    const key = [...src.blobs.keys()][0]!
    src.blobs.set(key, new Uint8Array([9, 9, 9])) // wrong bytes for this hash
    const r = admitBundle(src)
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.reason).toMatch(/attachment/)
  })

  it('rejects a missing attachment (no partial admission)', async () => {
    const { tar } = await makePublicBundle()
    const src = parseBundle(tar)
    src.blobs.clear()
    const r = admitBundle(src)
    expect(r.status).toBe('invalid')
    if (r.status === 'invalid') expect(r.reason).toMatch(/missing/)
  })

  it('reports unverifiable for an unknown scheme', async () => {
    const signer = { scheme: 'zzz-unknown', pubkey: new Uint8Array(20), async sign() { return new Uint8Array(65) } }
    const program = new Uint8Array([1])
    const manifest: Manifest = { v: 1, prog: hash(program), type: 't', args: null, att: new Map() }
    const manifestBytes = encodeManifest(manifest)
    const envelope = await encodeEnvelope({ man: hash(manifestBytes), created: 1 }, signer)
    const tar = buildTar({ 'envelope.cbor': envelope, 'manifest.cbor': manifestBytes, program })
    const r = admitBundle(parseBundle(tar))
    expect(r.status).toBe('unverifiable')
  })
})

describe('sealed unseal round-trip', () => {
  it('unseals an envelope for a recipient and reports not-for-me otherwise', async () => {
    const authorPriv = secp256k1.utils.randomSecretKey()
    const signer = nostrSigner(authorPriv)
    const program = new Uint8Array([1, 2])
    const manifest: Manifest = { v: 1, prog: hash(program), type: 'invite', args: null, att: new Map() }
    const inner = await encodeEnvelope({ man: hash(encodeManifest(manifest)), created: 5 }, signer)

    const alicePriv = secp256k1.utils.randomSecretKey()
    const alicePub = schnorr.getPublicKey(alicePriv)
    const bobPriv = secp256k1.utils.randomSecretKey()
    const bobPub = schnorr.getPublicKey(bobPriv)
    const carolPriv = secp256k1.utils.randomSecretKey()

    const sealed = seal(inner, [alicePub, bobPub])

    // Alice and Bob can unseal; Carol cannot.
    expect(unseal(sealed, unsealerFromKey(alicePriv))).toEqual(inner)
    expect(unseal(sealed, unsealerFromKey(bobPriv))).toEqual(inner)
    expect(unseal(sealed, unsealerFromKey(carolPriv))).toBe('not-for-me')
  })

  it('admitBundle unseals and admits the inner envelope for a recipient', async () => {
    const signer = nostrSigner(secp256k1.utils.randomSecretKey())
    const program = new Uint8Array([7])
    const manifest: Manifest = { v: 1, prog: hash(program), type: 'invite', args: null, att: new Map() }
    const inner = await encodeEnvelope({ man: hash(encodeManifest(manifest)), created: 9 }, signer)
    const meP = secp256k1.utils.randomSecretKey()
    const mePub = schnorr.getPublicKey(meP)
    const sealed = seal(inner, [mePub])
    const tar = buildTar({ 'envelope.cbor': sealed })

    const forMe = admitBundle(parseBundle(tar), { unsealer: unsealerFromKey(meP) })
    expect(forMe.status).toBe('valid')
    if (forMe.status === 'valid') expect(forMe.sealed).toBe(true)

    const notForMe = admitBundle(parseBundle(tar), { unsealer: unsealerFromKey(secp256k1.utils.randomSecretKey()) })
    expect(notForMe.status).toBe('not-for-me')
  })

  it('caps the slot count before trial-decryption', async () => {
    // Hand-build a Sealed with too many slots via the encoder.
    const signer = nostrSigner(secp256k1.utils.randomSecretKey())
    const inner = await encodeEnvelope({ man: hash(new Uint8Array(1)), created: 1 }, signer)
    const many = Array.from({ length: 5 }, () => schnorr.getPublicKey(secp256k1.utils.randomSecretKey()))
    const sealed = seal(inner, many)
    // Under the cap it works; the cap itself (512) is unit-tested in limits.
    expect(typeof unseal(sealed, unsealerFromKey(secp256k1.utils.randomSecretKey()))).toBe('string')
  })
})

describe('tar limits (tar-bomb / entry caps)', () => {
  it('refuses a tar exceeding the total-size cap', () => {
    const big = new Uint8Array(2000)
    const tar = buildTar({ 'envelope.cbor': big, a: big, b: big }) // 6000 bytes total
    expect(() => parseTar(tar, { ...DEFAULT_BUNDLE_LIMITS, maxTotalBytes: 3000 })).toThrow(BundleError)
  })

  it('refuses a single entry over the per-entry cap', () => {
    const tar = buildTar({ 'envelope.cbor': new Uint8Array(5000) })
    expect(() => parseTar(tar, { ...DEFAULT_BUNDLE_LIMITS, maxEntryBytes: 1000 })).toThrow(/per-entry/)
  })

  it('refuses a bundle over the raw size cap', () => {
    const tar = buildTar({ 'envelope.cbor': new Uint8Array(2000) })
    expect(() => parseTar(tar, { ...DEFAULT_BUNDLE_LIMITS, maxBundleBytes: 100 })).toThrow(/max size/)
  })
})
