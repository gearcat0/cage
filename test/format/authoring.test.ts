import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ethSigner, ethAddress } from './helpers.js'
import { admitBundle, parseBundle, packBundle, buildBundle, cosignBundle, hash, toHex } from '../../src/format/index.js'

// Authoring is the mirror of admission: buildBundle's output must re-admit as
// `valid`. These are the properties the shell's compose flow relies on.

const hex = (b: Uint8Array): string => toHex(b)

describe('authoring — buildBundle / packBundle', () => {
  const priv = secp256k1.utils.randomSecretKey()
  const program = new TextEncoder().encode('<!doctype html><meta charset=utf-8><h1>hello</h1>')

  it('a self-contained HTML program (no attachments) re-admits as valid', async () => {
    const tar = await buildBundle(ethSigner(priv), { program, type: 'page' })
    const r = admitBundle(parseBundle(tar))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(r.manifest.type).toBe('page')
    expect(hex(r.envelope.author.k)).toBe(hex(ethAddress(priv)))
    expect(r.envelope.author.s).toBe('eth-eip191')
    expect(hex(hash(r.program))).toBe(hex(r.manifest.prog))
    expect(r.attachments.size).toBe(0)
  })

  it('attachments are carried, hashed, and verified on admission', async () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    const tar = await buildBundle(ethSigner(priv), {
      program,
      type: 'gallery',
      attachments: new Map([['pic.png', { bytes: img, mime: 'image/png' }]])
    })
    const r = admitBundle(parseBundle(tar))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect([...r.attachments.keys()]).toEqual(['pic.png'])
    expect(hex(r.attachments.get('pic.png')!)).toBe(hex(img))
    expect(r.manifest.att.get('pic.png')!.m).toBe('image/png')
  })

  it('packBundle / parseBundle round-trip preserves every part', async () => {
    const tar = await buildBundle(ethSigner(priv), {
      program,
      type: 'note',
      attachments: new Map([['a.bin', { bytes: new Uint8Array([9, 9, 9]) }]])
    })
    const src = parseBundle(tar)
    const repacked = packBundle({
      envelope: src.envelope,
      manifest: src.manifest!,
      program: src.program!,
      blobs: src.blobs
    })
    expect(hex(hash(repacked))).toBe(hex(hash(tar)))
  })

  it('a tampered program in an authored bundle is rejected (the gate is the same)', async () => {
    const tar = await buildBundle(ethSigner(priv), { program, type: 'page' })
    const src = parseBundle(tar)
    src.program![0] ^= 0xff
    const bad = packBundle({ envelope: src.envelope, manifest: src.manifest!, program: src.program!, blobs: src.blobs })
    const r = admitBundle(parseBundle(bad))
    expect(r.status).toBe('invalid')
  })
})

// ── Co-signing ───────────────────────────────────────────────────────────────
// The DOCUMENT is the manifest; an envelope is one signature over it. So N
// signatories are N envelopes sharing one `man` hash, each independently
// verifiable. The rejected alternative was a `sigs[]` array inside the
// envelope: every added signature would change the envelope hash, so the
// document's identity would shift as it was signed.

describe('co-signing — cosignBundle', () => {
  const alice = secp256k1.utils.randomSecretKey()
  const bob = secp256k1.utils.randomSecretKey()
  const program = new TextEncoder().encode('<!doctype html><p>the agreement</p>')

  const contract = async (): Promise<Uint8Array> =>
    buildBundle(ethSigner(alice), { program, type: 'contract', args: new Map([['title', 'Lease']]), created: 1000 })

  it('a second signature keeps the manifest hash and gets its own envelope hash', async () => {
    const first = parseBundle(await contract())
    const second = parseBundle(
      await cosignBundle(ethSigner(bob), { manifestBytes: first.manifest!, program, created: 2000 })
    )

    // Same document...
    expect(hex(hash(second.manifest!))).toBe(hex(hash(first.manifest!)))
    expect(hex(second.manifest!)).toBe(hex(first.manifest!)) // byte for byte
    // ...different signature, and therefore a different thing.
    expect(hex(hash(second.envelope))).not.toBe(hex(hash(first.envelope)))

    const r = admitBundle(parseBundle(await cosignBundle(ethSigner(bob), { manifestBytes: first.manifest!, program })))
    expect(r.status).toBe('valid')
    if (r.status !== 'valid') return
    expect(hex(r.envelope.author.k)).toBe(hex(ethAddress(bob)))
  })

  it('signs the manifest bytes VERBATIM, never a re-encode', async () => {
    // The bytes are what the first signer signed, so they are what the second
    // signer must sign. A rebuild from decoded parts would be a different
    // document the moment any encoding detail differed.
    const first = parseBundle(await contract())
    const signed = parseBundle(await cosignBundle(ethSigner(bob), { manifestBytes: first.manifest!, program }))
    expect(Array.from(signed.manifest!)).toEqual(Array.from(first.manifest!))
  })

  it('both signatures verify independently, and neither is privileged', async () => {
    const first = parseBundle(await contract())
    const a = admitBundle(first)
    const b = admitBundle(parseBundle(await cosignBundle(ethSigner(bob), { manifestBytes: first.manifest!, program })))
    expect(a.status).toBe('valid')
    expect(b.status).toBe('valid')
    if (a.status !== 'valid' || b.status !== 'valid') return
    // Nothing marks one as the original: order is not in the format, and the
    // shell must not invent it from `created`, which is a claim.
    expect(hex(a.envelope.man)).toBe(hex(b.envelope.man))
    expect(hex(a.envelope.author.k)).not.toBe(hex(b.envelope.author.k))
  })

  it('refuses to build a bundle that could never be admitted', async () => {
    const first = parseBundle(await contract())
    const wrong = new TextEncoder().encode('<!doctype html><p>a different agreement</p>')
    // You cannot sign a document with the text swapped out: that is not a
    // co-signature, it is a forgery, and it is refused before any bytes exist.
    await expect(
      cosignBundle(ethSigner(bob), { manifestBytes: first.manifest!, program: wrong })
    ).rejects.toThrow(/does not match the manifest/)
  })

  it('carries attachments, and refuses when one is missing or altered', async () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
    const withAtt = parseBundle(
      await buildBundle(ethSigner(alice), {
        program,
        type: 'contract',
        attachments: new Map([['exhibit-a.png', { bytes: img, mime: 'image/png' }]])
      })
    )
    const blobs = new Map([[hex(hash(img)), img]])
    const ok = admitBundle(
      parseBundle(await cosignBundle(ethSigner(bob), { manifestBytes: withAtt.manifest!, program, blobs }))
    )
    expect(ok.status).toBe('valid')

    await expect(cosignBundle(ethSigner(bob), { manifestBytes: withAtt.manifest!, program })).rejects.toThrow(
      /missing attachment exhibit-a\.png/
    )
    // A blob filed under the right name but with the wrong bytes is caught by
    // the hash, not trusted by its key.
    const tampered = new Map([[hex(hash(img)), new Uint8Array([1, 2, 3])]])
    await expect(
      cosignBundle(ethSigner(bob), { manifestBytes: withAtt.manifest!, program, blobs: tampered })
    ).rejects.toThrow(/does not match its hash/)
  })
})
