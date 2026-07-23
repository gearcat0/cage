import { describe, it, expect } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { ethSigner, ethAddress } from './helpers.js'
import { admitBundle, parseBundle, packBundle, buildBundle, hash, toHex } from '../../src/format/index.js'

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
