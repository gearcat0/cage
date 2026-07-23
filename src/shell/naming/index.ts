// ── Naming (brief phase 5) ───────────────────────────────────────────────────
//
// Turns a human name into two things: the author key a thing must be signed by
// to be "theirs" (identity), and a locator to fetch it (discovery). THE
// principle: the resolver is UNTRUSTED for the key; the signature is. A name is
// shown as `verified` only when the resolver's answer provably matches the
// admitted thing's (signature-proven) author key. A wrong/malicious resolver can
// fail, or point at a different key — but it can never attach a name to a thing
// whose author key does not match its own answer.

export class NamingError extends Error {
  override name = 'NamingError'
}

export type NameVerification =
  | { status: 'verified'; name: string }
  | { status: 'mismatch'; name: string; resolvedKey: string }
  | { status: 'unresolvable' }

export interface Resolver {
  /** Does this resolver handle names of this shape (for resolve / verifyName)? */
  handlesName(name: string): boolean
  /** Discovery: a name → a transport locator. Throws NamingError if it cannot. */
  resolve(name: string): Promise<string>
  /** Identity: a name → its author binding, or null if unresolvable. keyHex is
   *  the lowercase-hex key with no 0x prefix. */
  addressOf?(name: string): Promise<{ scheme: string; keyHex: string } | null>
  /** Reverse: the primary name for an author key, or null. The resolver MUST
   *  forward-confirm before returning a name. */
  reverseName?(scheme: string, keyHex: string): Promise<string | null>
}

/** Normalize a key to lowercase hex with no `0x` prefix, for comparison. */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/^0x/, '')
}

export class NamingService {
  private readonly resolvers: Resolver[] = []

  register(resolver: Resolver): this {
    this.resolvers.push(resolver)
    return this
  }

  /** Discovery: a name → a transport locator. Throws if no resolver handles it. */
  async resolve(name: string): Promise<string> {
    const resolver = this.resolvers.find((r) => r.handlesName(name))
    if (!resolver) throw new NamingError(`no resolver for name: ${name.slice(0, 48)}`)
    return resolver.resolve(name)
  }

  /** Whether any resolver handles this name shape. */
  handles(name: string): boolean {
    return this.resolvers.some((r) => r.handlesName(name))
  }

  /**
   * The primary VERIFIED name for an author key, for the trust header. Reverse-
   * resolves the key to a name, then requires the name to forward-resolve back
   * to the same key (the resolver does this internally). `unresolvable` if no
   * confirmed name is found.
   */
  async primaryName(scheme: string, keyHex: string): Promise<NameVerification> {
    const key = normalizeKey(keyHex)
    for (const r of this.resolvers) {
      if (!r.reverseName || !r.addressOf) continue
      let name: string | null
      try {
        name = await r.reverseName(scheme, key)
      } catch {
        continue
      }
      if (!name) continue
      // Forward-confirm: the name MUST resolve back to this exact key.
      const v = await this.verifyName(name, scheme, key)
      if (v.status === 'verified') return v
    }
    return { status: 'unresolvable' }
  }

  /**
   * Does `name` map to (scheme, keyHex)? `verified` iff the resolver's address
   * equals the key; `mismatch` if it resolves to a DIFFERENT key (an alarm);
   * `unresolvable` if no resolver can resolve it.
   */
  async verifyName(name: string, scheme: string, keyHex: string): Promise<NameVerification> {
    const key = normalizeKey(keyHex)
    const resolver = this.resolvers.find((r) => r.handlesName(name) && r.addressOf)
    if (!resolver || !resolver.addressOf) return { status: 'unresolvable' }
    let binding: { scheme: string; keyHex: string } | null
    try {
      binding = await resolver.addressOf(name)
    } catch {
      return { status: 'unresolvable' }
    }
    if (!binding) return { status: 'unresolvable' }
    const resolvedKey = normalizeKey(binding.keyHex)
    if (binding.scheme === scheme && resolvedKey === key) return { status: 'verified', name }
    return { status: 'mismatch', name, resolvedKey }
  }
}

// ── ENS client (injected into the ENS resolver) ──────────────────────────────
// Production supplies a viem-backed client (ens-viem.ts); tests supply an
// in-memory mock (mock-ens.ts). Addresses are 0x-prefixed hex; the resolver
// normalizes for comparison.

export interface EnsClient {
  /** ENS name → 0x-address, or null. */
  getAddress(name: string): Promise<string | null>
  /** address → primary ENS name, or null (reverse record; NOT yet confirmed). */
  getName(address: string): Promise<string | null>
  /** ENS text record value for `key`, or null. */
  getText(name: string, key: string): Promise<string | null>
}

export { DirectResolver } from './direct.js'
export { EnsResolver } from './ens.js'
export { NostrResolver } from './nostr.js'
