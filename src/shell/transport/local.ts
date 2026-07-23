import type { CasStore } from '../../main/store.js'
import { TransportError, type FetchLimits, type Transport } from './index.js'

// `bundle:<sha256-hex>` — content-addressed: fetch the bundle whose raw tar
// bytes hash to <sha256-hex>, from the local SEED store. The shell retains every
// admitted bundle here so it can re-serve it (the seed side of transport); later
// the same locator resolves to a peer. The TransportService verifies the fetched
// bytes hash to the name, so the name IS the integrity check.

export class SeedTransport implements Transport {
  constructor(private readonly seed: CasStore) {}

  supports(locator: string): boolean {
    return locator.startsWith('bundle:')
  }

  async fetch(locator: string, limits: FetchLimits): Promise<Uint8Array> {
    const hashHex = locator.slice('bundle:'.length).toLowerCase()
    const bytes = this.seed.readAll(hashHex)
    if (!bytes) throw new TransportError('bundle not found in the local seed store')
    if (bytes.length > limits.maxBytes) {
      throw new TransportError(`seeded bundle exceeds maxBytes (${bytes.length} > ${limits.maxBytes})`)
    }
    return bytes
  }
}
