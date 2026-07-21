// ── Naming (stub, brief §5) ──────────────────────────────────────────────────
// Behind this interface sits ENS/Nostr discovery later. Direct-hash and
// direct-bundle ingestion work with NO resolver at all — which is also the most
// honest early test of whether the core experience holds without any chain or
// relay in the room.
//
// LATER (naming brief): ENS binding, Nostr discovery + subscriptions.

export interface Locator {
  scheme: string
  value: string
}

export interface Resolver {
  resolve(name: string): Promise<Locator>
}

export class ResolverError extends Error {
  override name = 'ResolverError'
}

/** Phase-3 resolver: none. Names do not resolve yet; ingestion is direct. */
export class StubResolver implements Resolver {
  async resolve(name: string): Promise<Locator> {
    throw new ResolverError(`naming is not yet supported; cannot resolve "${name}"`)
  }
}
