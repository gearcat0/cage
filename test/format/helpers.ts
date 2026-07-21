import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { Signer } from '../../src/format/envelope.js'

// Test-only signers and a tar builder. These mirror what the shell keyring does.

export function ethAddress(priv: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv, true)).toBytes(false)
  const addr = keccak_256(uncompressed.subarray(1))
  return addr.subarray(addr.length - 20)
}

export function ethSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'eth-eip191',
    pubkey: ethAddress(priv),
    async sign(signingInput) {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${signingInput.length}`)
      const buf = new Uint8Array(prefix.length + signingInput.length)
      buf.set(prefix, 0)
      buf.set(signingInput, prefix.length)
      const digest = keccak_256(buf)
      const recd = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0]! + 27
      return out
    }
  }
}

export function nostrSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'nostr-schnorr',
    pubkey: schnorr.getPublicKey(priv),
    async sign(signingInput) {
      return schnorr.sign(sha256(signingInput), priv)
    }
  }
}

/** Build an uncompressed ustar archive from name -> bytes. */
export function buildTar(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const [name, data] of Object.entries(files)) {
    const header = new Uint8Array(512)
    const enc = new TextEncoder()
    header.set(enc.encode(name).subarray(0, 100), 0)
    header.set(enc.encode('0000644\0'), 100) // mode
    header.set(enc.encode('0000000\0'), 108) // uid
    header.set(enc.encode('0000000\0'), 116) // gid
    header.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124) // size
    header.set(enc.encode('00000000000\0'), 136) // mtime
    header[156] = 0x30 // typeflag '0'
    header.set(enc.encode('ustar\0'), 257)
    header.set(enc.encode('00'), 263)
    // checksum: sum of header bytes with checksum field treated as spaces
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (const b of header) sum += b
    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data, 0)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024)) // two zero blocks
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.length
  }
  return out
}
