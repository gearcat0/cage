// ── Conformance vector generator ─────────────────────────────────────────────
//
//   pnpm gen:vectors          regenerate the deterministic vectors
//   FORCE_SEALED=1 pnpm gen:vectors   also regenerate sealed.json
//
// Everything except the sealed set is DETERMINISTIC: fixed test keys + RFC-6979
// ECDSA + zero-aux-rand Schnorr, so re-running reproduces byte-identical vectors
// and any diff is a real behavioural change. The sealed set uses fresh random
// content keys / nonces / ephemeral keys (as production sealing must), so it is
// generated ONCE and frozen; the runner verifies the frozen bytes, which is
// deterministic. This file is a dev tool — NOT part of the shipped runner, and
// the only place in the package that holds private keys or signs.

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  encode,
  encodeManifest,
  encodeEnvelope,
  hash,
  toHex,
  fromHex,
  sealEnvelope,
  sealMember,
  type Signer,
  type Manifest,
  type CborKey,
  type CborValue
} from '../format/index.js'
import { formatTarget } from './target.js'
import type {
  CanonicalVector,
  HashVector,
  EnvelopeVector,
  BundleVector,
  ChainVector,
  SealedVector,
  LimitVector
} from './runner.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'vectors')

// ── Fixed test keys (test-only; conformance vectors publish their keys) ───────

const fixed = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const ETH_PRIV = fixed(0x01)
const NOSTR_PRIV = fixed(0x02)
const R1 = fixed(0x11)
const R2 = fixed(0x12)
const R3 = fixed(0x13)
const R4 = fixed(0x14) // not a recipient

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const cat = (...parts: (Uint8Array | number[])[]): Uint8Array => {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

function ethAddress(priv: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(priv, true)).toBytes(false)
  const addr = keccak_256(uncompressed.subarray(1))
  return addr.subarray(addr.length - 20)
}

function ethSigner(priv: Uint8Array, corrupt = false): Signer {
  return {
    scheme: 'eth-eip191',
    pubkey: ethAddress(priv),
    async sign(signingInput) {
      const prefix = utf8(`\x19Ethereum Signed Message:\n${signingInput.length}`)
      const digest = keccak_256(cat(prefix, signingInput))
      const recd = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0]! + 27
      if (corrupt) out[10] ^= 0x01 // flip one bit of r — still 65 bytes, still canonical CBOR
      return out
    }
  }
}

function nostrSigner(priv: Uint8Array): Signer {
  return {
    scheme: 'nostr-schnorr',
    pubkey: schnorr.getPublicKey(priv),
    // Zero aux-rand → deterministic BIP-340 signature (allowed by the spec).
    async sign(signingInput) {
      return schnorr.sign(sha256(signingInput), priv, new Uint8Array(32))
    }
  }
}

/** A signer whose scheme has no verifier → the envelope is `unverifiable`. */
function unknownSigner(scheme: string): Signer {
  return { scheme, pubkey: new Uint8Array(32).fill(0xaa), async sign() { return new Uint8Array(64) } }
}

// ── Tar builder (uncompressed ustar) ─────────────────────────────────────────

function buildTar(files: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const [name, data] of Object.entries(files)) {
    const header = new Uint8Array(512)
    header.set(utf8(name).subarray(0, 100), 0)
    header.set(utf8('0000644\0'), 100)
    header.set(utf8('0000000\0'), 108)
    header.set(utf8('0000000\0'), 116)
    header.set(utf8(data.length.toString(8).padStart(11, '0') + '\0'), 124)
    header.set(utf8('00000000000\0'), 136)
    header[156] = 0x30
    header.set(utf8('ustar\0'), 257)
    header.set(utf8('00'), 263)
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (const b of header) sum += b
    header.set(utf8(sum.toString(8).padStart(6, '0') + '\0 '), 148)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data, 0)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(1024))
  return cat(...blocks)
}

// ── Bundle building ──────────────────────────────────────────────────────────

interface BuildOpts {
  type?: string
  args?: CborValue
  program?: Uint8Array
  attachments?: Record<string, Uint8Array>
  created?: number
  path?: string
  seq?: number
  prev?: Uint8Array
}

async function buildEnvelope(signer: Signer, manifestBytes: Uint8Array, opts: BuildOpts): Promise<Uint8Array> {
  const env: Parameters<typeof encodeEnvelope>[0] = { man: hash(manifestBytes), created: opts.created ?? 1_700_000_000 }
  if (opts.path !== undefined) env.path = opts.path
  if (opts.seq !== undefined) env.seq = opts.seq
  if (opts.prev !== undefined) env.prev = opts.prev
  return encodeEnvelope(env, signer)
}

function buildManifest(opts: BuildOpts): { manifest: Manifest; bytes: Uint8Array; blobFiles: Record<string, Uint8Array> } {
  const program = opts.program ?? utf8('<!doctype html><h1>thing</h1>')
  const att = new Map<string, { h: Uint8Array; m: string; n: number }>()
  const blobFiles: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(opts.attachments ?? {})) {
    att.set(name, { h: hash(bytes), m: 'application/octet-stream', n: bytes.length })
    blobFiles[`blobs/${toHex(hash(bytes))}`] = bytes
  }
  const manifest: Manifest = { v: 1, prog: hash(program), type: opts.type ?? 'note', args: opts.args ?? null, att }
  return { manifest, bytes: encodeManifest(manifest), blobFiles }
}

async function buildBundle(signer: Signer, opts: BuildOpts = {}): Promise<Uint8Array> {
  const program = opts.program ?? utf8('<!doctype html><h1>thing</h1>')
  const { bytes: manifestBytes, blobFiles } = buildManifest(opts)
  const envelope = await buildEnvelope(signer, manifestBytes, opts)
  return buildTar({ 'envelope.cbor': envelope, 'manifest.cbor': manifestBytes, program, ...blobFiles })
}

// ── Category builders ────────────────────────────────────────────────────────

function canonicalVectors(): CanonicalVector[] {
  return [
    { name: 'canonical map {1:1,2:2}', hex: 'a201010202', expect: 'accept' },
    { name: 'NFC text "é" (U+00E9)', hex: '62c3a9', expect: 'accept' },
    {
      name: 'RFC 8949 key order: {100:0,-1:0} sorted bytewise (100 first)',
      note: 'encoded key 100=0x1864 sorts before -1=0x20 bytewise',
      hex: 'a2186400' + '2000',
      expect: 'accept'
    },
    { name: 'unsorted map keys {2:2,1:1}', hex: 'a202020101', expect: 'reject' },
    { name: 'non-shortest uint (5 as one-byte arg)', hex: '1805', expect: 'reject' },
    { name: 'duplicate map key {1:1,1:2}', hex: 'a201010102', expect: 'reject' },
    { name: 'float (half-precision 1.0)', hex: 'f93c00', expect: 'reject' },
    { name: 'CBOR tag 0 over text "a"', hex: 'c06161', expect: 'reject' },
    { name: 'indefinite-length array', hex: '9f01ff', expect: 'reject' },
    { name: '`undefined` simple value', hex: 'f7', expect: 'reject' },
    { name: 'trailing bytes after top-level item', hex: '0101', expect: 'reject' },
    { name: 'non-NFC text (decomposed "é" = e + U+0301)', hex: '6365cc81', expect: 'reject' },
    {
      name: 'RFC 7049 key order: {-1:0,100:0} sorted length-first (the trap)',
      note: 'length-first would put -1 (len1) before 100 (len2); bytewise (8949) does not',
      hex: 'a2200018' + '6400',
      expect: 'reject'
    }
  ]
}

function hashingVectors(ethBundleParts: { manifestBytes: Uint8Array; program: Uint8Array }): HashVector[] {
  const mk = (name: string, bytes: Uint8Array): HashVector => ({ name, hex: toHex(bytes), sha256: toHex(hash(bytes)) })
  return [
    mk('empty', new Uint8Array(0)),
    mk('ascii "hello"', utf8('hello')),
    mk("a bundle's program blob", ethBundleParts.program),
    mk("a bundle's canonical manifest bytes", ethBundleParts.manifestBytes)
  ]
}

async function envelopeVectors(): Promise<EnvelopeVector[]> {
  const ethMan = encodeManifest({ v: 1, prog: hash(utf8('p')), type: 'note', args: null, att: new Map() })
  const ethEnv = await buildEnvelope(ethSigner(ETH_PRIV), ethMan, {})
  const nostrEnv = await buildEnvelope(nostrSigner(NOSTR_PRIV), ethMan, {})
  const sshEnv = await buildEnvelope(unknownSigner('ssh-ed25519'), ethMan, {})
  const flipped = await buildEnvelope(ethSigner(ETH_PRIV, true), ethMan, {})
  return [
    {
      name: 'eth-eip191 valid',
      hex: toHex(ethEnv),
      expect: { status: 'valid', authorScheme: 'eth-eip191', authorKeyHex: toHex(ethAddress(ETH_PRIV)) }
    },
    {
      name: 'nostr-schnorr valid',
      hex: toHex(nostrEnv),
      expect: { status: 'valid', authorScheme: 'nostr-schnorr', authorKeyHex: toHex(schnorr.getPublicKey(NOSTR_PRIV)) }
    },
    { name: 'ssh-ed25519 unverifiable (unknown scheme)', hex: toHex(sshEnv), expect: { status: 'unverifiable', scheme: 'ssh-ed25519' } },
    { name: 'flipped signature bit invalid', hex: toHex(flipped), expect: { status: 'invalid' } }
  ]
}

async function bundleVectors(): Promise<{ vectors: BundleVector[]; ethParts: { manifestBytes: Uint8Array; program: Uint8Array } }> {
  const program = utf8('<!doctype html><h1>good</h1>')
  const attach = utf8('attachment payload')
  const goodOpts: BuildOpts = { type: 'note', program, attachments: { 'a.txt': attach } }

  const ethGood = await buildBundle(ethSigner(ETH_PRIV), goodOpts)
  const nostrGood = await buildBundle(nostrSigner(NOSTR_PRIV), goodOpts)

  // Expected hashes come from admitting our own good bundle — expected == actual
  // by construction, then re-verified by the committed test.
  const ethAdmit = formatTarget.admit(ethGood)
  const nostrAdmit = formatTarget.admit(nostrGood)

  const goodExpect = (a: ReturnType<typeof formatTarget.admit>) => ({
    status: 'valid' as const,
    envelopeHashHex: a.envelopeHashHex!,
    manHashHex: a.manHashHex!,
    progHashHex: a.progHashHex!,
    attHashHex: a.attHashHex!
  })

  // Flipped signature bit.
  const flipped = await buildBundle(ethSigner(ETH_PRIV, true), goodOpts)

  // Manifest hash mismatch: keep the signed envelope, swap in a different manifest.
  const { bytes: goodMan, blobFiles } = buildManifest(goodOpts)
  const goodEnv = await buildEnvelope(ethSigner(ETH_PRIV), goodMan, goodOpts)
  const otherMan = encodeManifest({ v: 1, prog: hash(program), type: 'evil', args: null, att: new Map() })
  const manMismatch = buildTar({ 'envelope.cbor': goodEnv, 'manifest.cbor': otherMan, program, ...blobFiles })

  // Tampered `type`, intact `prog`: same program, only the display type differs.
  const tamperedTypeMan = encodeManifest({
    v: 1,
    prog: hash(program),
    type: 'system-critical',
    args: null,
    att: (() => {
      const m = new Map<string, { h: Uint8Array; m: string; n: number }>()
      m.set('a.txt', { h: hash(attach), m: 'application/octet-stream', n: attach.length })
      return m
    })()
  })
  const tamperedType = buildTar({ 'envelope.cbor': goodEnv, 'manifest.cbor': tamperedTypeMan, program, ...blobFiles })

  // Attachment hash mismatch: corrupt the blob bytes, keep its manifest hash + name.
  const corrupt = Uint8Array.from(attach)
  corrupt[0] ^= 0xff
  const attMismatch = buildTar({
    'envelope.cbor': goodEnv,
    'manifest.cbor': goodMan,
    program,
    [`blobs/${toHex(hash(attach))}`]: corrupt
  })

  // Non-canonical manifest that decodes but must be rejected: keys emitted 2,1,3,4.
  const prog = hash(program)
  const nonCanonMan = cat([0xa4], [0x02], [0x58, 0x20], prog, [0x01, 0x01], [0x03, 0x64], utf8('note'), [0x04, 0xf6])
  const nonCanonEnv = await buildEnvelope(ethSigner(ETH_PRIV), nonCanonMan, { program })
  const nonCanon = buildTar({ 'envelope.cbor': nonCanonEnv, 'manifest.cbor': nonCanonMan, program })

  // Unknown scheme id.
  const unknown = await buildBundle(unknownSigner('x-unknown-2099'), goodOpts)

  const vectors: BundleVector[] = [
    { name: 'eth-eip191 good bundle', tarHex: toHex(ethGood), expect: goodExpect(ethAdmit) },
    { name: 'nostr-schnorr good bundle', tarHex: toHex(nostrGood), expect: goodExpect(nostrAdmit) },
    { name: 'flipped signature bit', tarHex: toHex(flipped), expect: { status: 'invalid' } },
    { name: 'manifest hash mismatch', tarHex: toHex(manMismatch), expect: { status: 'invalid' } },
    { name: 'tampered type, intact prog', tarHex: toHex(tamperedType), expect: { status: 'invalid' } },
    { name: 'attachment hash mismatch', tarHex: toHex(attMismatch), expect: { status: 'invalid' } },
    { name: 'non-canonical manifest (decodes, rejected)', tarHex: toHex(nonCanon), expect: { status: 'invalid' } },
    { name: 'unknown scheme id', tarHex: toHex(unknown), expect: { status: 'unverifiable', scheme: 'x-unknown-2099' } }
  ]
  return { vectors, ethParts: { manifestBytes: goodMan, program } }
}

async function chainVectors(): Promise<ChainVector[]> {
  const man = encodeManifest({ v: 1, prog: hash(utf8('p')), type: 'post', args: null, att: new Map() })
  const signer = ethSigner(ETH_PRIV)
  const mk = (seq: number, prev: Uint8Array | undefined, created: number) =>
    buildEnvelope(signer, man, { path: 'blog', seq, prev, created })

  const e0 = await mk(0, undefined, 100)
  const e1 = await mk(1, hash(e0), 101)
  const e2 = await mk(2, hash(e1), 102)

  // Fork: a competing seq-1 (different `created` → different hash), same prev.
  const e1b = await mk(1, hash(e0), 999)

  // Gap: seq 2 whose prev points at a seq-1 that is not present.
  const e2gap = await mk(2, hash(e1), 102)

  return [
    { name: 'linear seq 0→1→2', envelopesHex: [toHex(e0), toHex(e1), toHex(e2)], expect: 'linear' },
    { name: 'fork at seq 1', envelopesHex: [toHex(e0), toHex(e1), toHex(e1b)], expect: 'fork' },
    { name: 'gap (seq 0 then 2)', envelopesHex: [toHex(e0), toHex(e2gap)], expect: 'gap' }
  ]
}

async function sealedVectors(): Promise<SealedVector[]> {
  const program = utf8('<!doctype html><h1>sealed</h1>')
  const attach = utf8('secret attachment')
  const { manifest } = buildManifest({ type: 'invite', program, attachments: { 's.bin': attach } })
  const manifestBytes = encodeManifest(manifest)
  const inner = await buildEnvelope(ethSigner(ETH_PRIV), manifestBytes, { program, created: 5 })

  const recipients = [R1, R2, R3].map((k) => schnorr.getPublicKey(k))
  const { sealed, ck } = sealEnvelope(inner, recipients)
  const files: Record<string, Uint8Array> = {
    'envelope.cbor': sealed,
    'manifest.enc': sealMember(manifestBytes, ck),
    'program.enc': sealMember(program, ck),
    [`blobs/${toHex(hash(attach))}`]: sealMember(attach, ck)
  }
  const tar = buildTar(files)
  const authorKeyHex = toHex(ethAddress(ETH_PRIV))
  return [
    {
      name: 'sealed to 3 recipients',
      tarHex: toHex(tar),
      recipients: [R1, R2, R3].map((k) => ({ privHex: toHex(k), authorScheme: 'eth-eip191', authorKeyHex })),
      notForMe: [toHex(R4)]
    }
  ]
}

function limitVectors(): LimitVector[] {
  const nest = (n: number): CborValue => (n === 0 ? 0 : [nest(n - 1)])
  const bigArray = new Array(6).fill(0) as CborValue[]
  const attMap = (n: number): Uint8Array => {
    const m: Manifest = {
      v: 1,
      prog: hash(utf8('p')),
      type: 'note',
      args: null,
      att: new Map(Array.from({ length: n }, (_, i) => [`f${i}`, { h: hash(utf8(`f${i}`)), m: 'application/octet-stream', n: 1 }]))
    }
    return encodeManifest(m)
  }
  const bigFileTar = (name: string, size: number, count = 1): Uint8Array => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < count; i++) files[`f${i}/${name}`] = new Uint8Array(size).fill(0x41)
    return buildTar(files)
  }
  const manyEntryTar = (count: number): Uint8Array => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < count; i++) files[`e${i}`] = utf8('x')
    return buildTar(files)
  }
  // A sealed envelope with 513 (> MAX_SEALED_SLOTS) structurally-valid slots — the
  // slot cap must fire BEFORE any trial-decryption.
  const slots: CborValue[] = Array.from({ length: 513 }, () => new Map<CborKey, CborValue>([[1, new Uint8Array(32)], [2, new Uint8Array(48)]]))
  const overSlots = encode(new Map<CborKey, CborValue>([[1, 1], [2, slots], [3, new Uint8Array(24)], [4, new Uint8Array(16)]]))
  const overSlotsTar = buildTar({ 'envelope.cbor': overSlots })

  return [
    { name: 'maxDepth (nesting past the cap)', op: 'decodeCanonical', hex: toHex(encode(nest(5))), limits: { maxDepth: 3 }, expect: { throws: true } },
    { name: 'maxEntries (array longer than the cap)', op: 'decodeCanonical', hex: toHex(encode(bigArray)), limits: { maxEntries: 4 }, expect: { throws: true } },
    { name: 'maxStringBytes (byte string past the cap)', op: 'decodeCanonical', hex: toHex(encode(new Uint8Array(16))), limits: { maxStringBytes: 8 }, expect: { throws: true } },
    { name: 'maxAttachments (manifest att map past the cap)', op: 'decodeManifest', hex: toHex(attMap(3)), limits: { maxAttachments: 2 }, expect: { throws: true } },
    { name: 'tar maxEntries (too many entries)', op: 'parseTar', hex: toHex(manyEntryTar(5)), limits: { maxEntries: 3 }, expect: { throws: true } },
    { name: 'tar maxEntryBytes (one entry past the per-entry cap)', op: 'parseTar', hex: toHex(bigFileTar('big', 200)), limits: { maxEntryBytes: 100 }, expect: { throws: true } },
    { name: 'tar maxTotalBytes (entries sum past the cap)', op: 'parseTar', hex: toHex(bigFileTar('m', 80, 2)), limits: { maxTotalBytes: 100 }, expect: { throws: true } },
    {
      name: 'sealed maxSlots (513 > MAX_SEALED_SLOTS, capped before crypto)',
      op: 'admit',
      hex: toHex(overSlotsTar),
      unsealerPrivHex: toHex(R1),
      expect: { status: 'invalid', reasonIncludes: 'too many slots' }
    }
  ]
}

// ── Emit ─────────────────────────────────────────────────────────────────────

function writeVectors(name: string, data: unknown): void {
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, null, 2) + '\n')
  console.log(`  wrote ${name}.json`)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  console.log('generating conformance vectors →', OUT)

  const canonical = canonicalVectors()
  const envelopes = await envelopeVectors()
  const { vectors: bundles, ethParts } = await bundleVectors()
  const hashing = hashingVectors(ethParts)
  const chain = await chainVectors()
  const limits = limitVectors()

  writeVectors('canonical', canonical)
  writeVectors('hashing', hashing)
  writeVectors('envelopes', envelopes)
  writeVectors('bundles', bundles)
  writeVectors('chain', chain)
  writeVectors('limits', limits)

  const sealedPath = join(OUT, 'sealed.json')
  if (!existsSync(sealedPath) || process.env.FORCE_SEALED === '1') {
    writeVectors('sealed', await sealedVectors())
  } else {
    console.log('  kept sealed.json (frozen; set FORCE_SEALED=1 to regenerate)')
  }

  // Sanity: round-trip fromHex on a value to catch an accidental odd-length hex.
  fromHex(canonical[0]!.hex)
  console.log('done.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
