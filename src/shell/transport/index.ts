// ── Transport (stub, brief §5) ───────────────────────────────────────────────
// Behind this interface sits file/paste today and webtorrent later. A locator
// is a scheme-tagged string; a magnet locator resolves to "not yet supported".
// The whole "flyer" property already works without any of this: raw bundle
// bytes → admission → library, transport-agnostic and verify-at-the-gate.
//
// LATER (transport brief): webtorrent fetch/seed for `magnet:` locators.

export interface Transport {
  /** Fetch the raw bundle bytes for a locator, or throw if unsupported. */
  fetch(locator: string): Promise<Uint8Array>
  /** Whether this transport can handle the locator's scheme. */
  supports(locator: string): boolean
}

export class TransportError extends Error {
  override name = 'TransportError'
}

/** Phase-3 transport: only direct ingestion (file/paste/drag) — those hand the
 *  shell raw bytes, so there is no locator to fetch. Any real locator (magnet,
 *  ipfs, http) is "not yet supported". */
export class StubTransport implements Transport {
  supports(locator: string): boolean {
    return locator.startsWith('bytes:') // direct-bytes sentinel only
  }
  async fetch(locator: string): Promise<Uint8Array> {
    if (locator.startsWith('magnet:')) {
      throw new TransportError('magnet transport is not yet supported (webtorrent lands in a later phase)')
    }
    throw new TransportError(`no transport for locator: ${locator.slice(0, 32)}`)
  }
}
