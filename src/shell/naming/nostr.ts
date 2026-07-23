import { NamingError, type Resolver } from './index.js'

// Nostr naming (npub… / NIP-05) — wired behind the interface, not implemented.
// Its slot proves the abstraction holds a second naming system; relay discovery
// and subscriptions are a later pass (network + state).
// LATER (naming, part 2): NIP-05 verification, relay discovery + subscriptions.

export class NostrResolver implements Resolver {
  handlesName(name: string): boolean {
    return name.startsWith('npub1') || /^[^@\s]+@[^@\s]+$/.test(name) // npub or NIP-05 (user@host)
  }

  async resolve(name: string): Promise<string> {
    throw new NamingError(`Nostr naming is not yet supported: ${name.slice(0, 32)}`)
  }
}
