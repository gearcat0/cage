// ── Conformance runner — checks a target against the vectors ─────────────────
//
// Pure logic: (target, vectors) -> results. No I/O. Each category has a runner
// that interprets its vectors against the ConformanceTarget and yields one
// Result per vector. `runAll` aggregates. A second implementation calls exactly
// this over exactly the committed ./vectors/*.json.

import { fromHex, toHex, type DecodeLimits, type BundleLimits } from '../format/index.js'
import type { ConformanceTarget } from './target.js'

export interface Result {
  category: string
  name: string
  ok: boolean
  detail?: string
}

// ── Vector shapes (mirror ./vectors/*.json) ──────────────────────────────────

export interface CanonicalVector {
  name: string
  note?: string
  /** The candidate CBOR, hex. */
  hex: string
  /** `accept` = decodes as canonical; `reject` = decoder must refuse (non-canonical or structurally illegal). */
  expect: 'accept' | 'reject'
}

export interface HashVector {
  name: string
  hex: string
  /** Expected lowercase-hex sha256 of `hex`. */
  sha256: string
}

export interface EnvelopeVector {
  name: string
  hex: string
  expect: {
    status: 'valid' | 'invalid' | 'unverifiable'
    scheme?: string
    authorScheme?: string
    authorKeyHex?: string
  }
}

export interface BundleVector {
  name: string
  tarHex: string
  expect: {
    status: 'valid' | 'invalid' | 'unverifiable' | 'not-for-me'
    scheme?: string
    envelopeHashHex?: string
    manHashHex?: string
    progHashHex?: string
    attHashHex?: Record<string, string>
  }
}

export interface ChainVector {
  name: string
  /** Envelopes of ONE (author, path), in any order. */
  envelopesHex: string[]
  expect: 'linear' | 'fork' | 'gap'
}

export interface SealedVector {
  name: string
  tarHex: string
  /** Each recipient key must admit the bundle as its inner author. */
  recipients: { privHex: string; authorScheme: string; authorKeyHex: string }[]
  /** Keys that are NOT recipients — each must be `not-for-me`. */
  notForMe: string[]
}

export interface LimitVector {
  name: string
  /** Which operation the input is fed to. */
  op: 'decodeCanonical' | 'decodeManifest' | 'parseTar' | 'admit'
  hex: string
  limits?: Partial<DecodeLimits & BundleLimits>
  /** For `admit`: a recipient key (sealed-slots cap is checked mid-admission). */
  unsealerPrivHex?: string
  /** `throw` (op refuses outright) or an admission `status` with a reason substring. */
  expect: { throws: true } | { status: string; reasonIncludes?: string }
  note?: string
}

export interface VectorSet {
  canonical: CanonicalVector[]
  hashing: HashVector[]
  envelopes: EnvelopeVector[]
  bundles: BundleVector[]
  chain: ChainVector[]
  sealed: SealedVector[]
  limits: LimitVector[]
}

// ── §5.3 chain linkage — the reference classifier ────────────────────────────
// A fork = two envelopes at the same seq with different hashes. A gap = the seqs
// present are not contiguous from the lowest. Otherwise, if every link's `prev`
// points at the previous seq's envelope, the chain is linear.

export function classifyChain(target: ConformanceTarget, envelopesHex: string[]): 'linear' | 'fork' | 'gap' {
  const links = envelopesHex.map((h) => target.chainInfo(fromHex(h)))
  const bySeq = new Map<number, Set<string>>()
  for (const l of links) {
    const seq = l.seq ?? 0
    const set = bySeq.get(seq) ?? new Set<string>()
    set.add(l.selfHex)
    bySeq.set(seq, set)
  }
  for (const set of bySeq.values()) if (set.size > 1) return 'fork'

  const seqs = [...bySeq.keys()].sort((a, b) => a - b)
  for (let i = 1; i < seqs.length; i++) if (seqs[i]! !== seqs[i - 1]! + 1) return 'gap'

  // Contiguous and no duplicates — require each `prev` to link the prior seq.
  const selfOf = new Map<number, string>()
  for (const l of links) selfOf.set(l.seq ?? 0, l.selfHex)
  for (let i = 1; i < seqs.length; i++) {
    const cur = links.find((l) => (l.seq ?? 0) === seqs[i])!
    if (cur.prevHex !== selfOf.get(seqs[i]! - 1)) return 'fork'
  }
  return 'linear'
}

// ── Category runners ─────────────────────────────────────────────────────────

const threw = (fn: () => void): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

export function runCanonical(target: ConformanceTarget, vectors: CanonicalVector[]): Result[] {
  return vectors.map((v) => {
    const rejected = threw(() => target.decodeCanonical(fromHex(v.hex)))
    const ok = v.expect === 'reject' ? rejected : !rejected
    return { category: 'canonical', name: v.name, ok, detail: ok ? undefined : `expected ${v.expect}` }
  })
}

export function runHashing(target: ConformanceTarget, vectors: HashVector[]): Result[] {
  return vectors.map((v) => {
    const got = toHex(target.sha256(fromHex(v.hex)))
    const ok = got === v.sha256
    return { category: 'hashing', name: v.name, ok, detail: ok ? undefined : `got ${got}` }
  })
}

export function runEnvelopes(target: ConformanceTarget, vectors: EnvelopeVector[]): Result[] {
  return vectors.map((v) => {
    let detail: string | undefined
    let ok = false
    try {
      const r = target.verifyEnvelope(fromHex(v.hex))
      ok = r.status === v.expect.status
      if (ok && v.expect.scheme !== undefined) ok = r.scheme === v.expect.scheme
      if (ok && v.expect.authorScheme !== undefined) ok = r.authorScheme === v.expect.authorScheme
      if (ok && v.expect.authorKeyHex !== undefined) ok = r.authorKeyHex === v.expect.authorKeyHex
      if (!ok) detail = `got ${JSON.stringify(r)}`
    } catch (e) {
      detail = `threw ${(e as Error).message}`
    }
    return { category: 'envelopes', name: v.name, ok, detail }
  })
}

export function runBundles(target: ConformanceTarget, vectors: BundleVector[]): Result[] {
  return vectors.map((v) => {
    let detail: string | undefined
    let ok = false
    try {
      const r = target.admit(fromHex(v.tarHex))
      ok = r.status === v.expect.status
      const e = v.expect
      if (ok && e.scheme !== undefined) ok = r.scheme === e.scheme
      if (ok && e.envelopeHashHex !== undefined) ok = r.envelopeHashHex === e.envelopeHashHex
      if (ok && e.manHashHex !== undefined) ok = r.manHashHex === e.manHashHex
      if (ok && e.progHashHex !== undefined) ok = r.progHashHex === e.progHashHex
      if (ok && e.attHashHex !== undefined) {
        ok = JSON.stringify(r.attHashHex ?? {}) === JSON.stringify(e.attHashHex)
      }
      if (!ok) detail = `got ${JSON.stringify({ status: r.status, reason: r.reason, envelopeHashHex: r.envelopeHashHex })}`
    } catch (e) {
      detail = `threw ${(e as Error).message}`
    }
    return { category: 'bundles', name: v.name, ok, detail }
  })
}

export function runChain(target: ConformanceTarget, vectors: ChainVector[]): Result[] {
  return vectors.map((v) => {
    let got: string
    try {
      got = classifyChain(target, v.envelopesHex)
    } catch (e) {
      return { category: 'chain', name: v.name, ok: false, detail: `threw ${(e as Error).message}` }
    }
    const ok = got === v.expect
    return { category: 'chain', name: v.name, ok, detail: ok ? undefined : `got ${got}` }
  })
}

export function runSealed(target: ConformanceTarget, vectors: SealedVector[]): Result[] {
  const out: Result[] = []
  for (const v of vectors) {
    const tar = fromHex(v.tarHex)
    v.recipients.forEach((rc, i) => {
      let ok = false
      let detail: string | undefined
      try {
        const r = target.admit(tar, { unsealerPrivHex: rc.privHex })
        ok = r.status === 'valid' && r.sealed === true && r.authorScheme === rc.authorScheme && r.authorKeyHex === rc.authorKeyHex
        if (!ok) detail = `got ${JSON.stringify({ status: r.status, sealed: r.sealed, authorKeyHex: r.authorKeyHex })}`
      } catch (e) {
        detail = `threw ${(e as Error).message}`
      }
      out.push({ category: 'sealed', name: `${v.name} — recipient #${i}`, ok, detail })
    })
    // No unsealer at all → not-for-me (we cannot even see who it is for).
    {
      let ok = false
      let detail: string | undefined
      try {
        const r = target.admit(tar)
        ok = r.status === 'not-for-me'
        if (!ok) detail = `got ${r.status}`
      } catch (e) {
        detail = `threw ${(e as Error).message}`
      }
      out.push({ category: 'sealed', name: `${v.name} — no unsealer`, ok, detail })
    }
    v.notForMe.forEach((privHex, i) => {
      let ok = false
      let detail: string | undefined
      try {
        const r = target.admit(tar, { unsealerPrivHex: privHex })
        ok = r.status === 'not-for-me'
        if (!ok) detail = `got ${r.status}`
      } catch (e) {
        detail = `threw ${(e as Error).message}`
      }
      out.push({ category: 'sealed', name: `${v.name} — not-for-me #${i}`, ok, detail })
    })
  }
  return out
}

export function runLimits(target: ConformanceTarget, vectors: LimitVector[]): Result[] {
  return vectors.map((v) => {
    const bytes = fromHex(v.hex)
    let ok = false
    let detail: string | undefined
    if ('throws' in v.expect) {
      ok = threw(() => {
        if (v.op === 'decodeCanonical') target.decodeCanonical(bytes, v.limits)
        else if (v.op === 'decodeManifest') target.decodeManifest(bytes, v.limits)
        else if (v.op === 'parseTar') target.parseTar(bytes, v.limits)
        else target.admit(bytes, { limits: v.limits, unsealerPrivHex: v.unsealerPrivHex })
      })
      if (!ok) detail = 'expected the op to reject, but it accepted'
    } else {
      try {
        const r = target.admit(bytes, { limits: v.limits, unsealerPrivHex: v.unsealerPrivHex })
        ok = r.status === v.expect.status
        if (ok && v.expect.reasonIncludes) ok = Boolean(r.reason?.includes(v.expect.reasonIncludes))
        if (!ok) detail = `got ${JSON.stringify({ status: r.status, reason: r.reason })}`
      } catch (e) {
        detail = `threw ${(e as Error).message}`
      }
    }
    return { category: 'limits', name: v.name, ok, detail }
  })
}

export function runAll(target: ConformanceTarget, vectors: VectorSet): Result[] {
  return [
    ...runCanonical(target, vectors.canonical),
    ...runHashing(target, vectors.hashing),
    ...runEnvelopes(target, vectors.envelopes),
    ...runBundles(target, vectors.bundles),
    ...runChain(target, vectors.chain),
    ...runSealed(target, vectors.sealed),
    ...runLimits(target, vectors.limits)
  ]
}
