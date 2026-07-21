import { hash, toHex } from '../../format/index.js'

// ── Transport (brief phase 4) ────────────────────────────────────────────────
//
// How bundle bytes arrive from anywhere — a file, a content-addressed seed, a
// magnet — without changing anything downstream. THE governing principle: the
// transport is UNTRUSTED FOR CONTENT; admission is the only gate. A transport
// hands the shell raw bytes; it cannot make the shell admit anything (admission
// re-verifies every signature and hash over the received bytes). What a
// transport CAN do is exhaust resources, so the fetch path is resource-bounded.

export class TransportError extends Error {
  override name = 'TransportError'
}

export interface FetchLimits {
  /** Refuse (and abort) once the fetched size exceeds this. */
  maxBytes: number
  /** Abandon a fetch that stalls past this. */
  timeoutMs: number
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = {
  maxBytes: 256 * 1024 * 1024, // matches the bundle raw-size cap
  timeoutMs: 30_000
}

export interface Transport {
  /** Whether this transport handles the locator's scheme. */
  supports(locator: string): boolean
  /** Fetch the raw bundle bytes, enforcing the limits (size + timeout). */
  fetch(locator: string, limits: FetchLimits): Promise<Uint8Array>
}

export interface ParsedLocator {
  scheme: string
  value: string
}

/** Split a locator into `scheme` (before the first ':') and `value` (after). */
export function parseLocator(locator: string): ParsedLocator {
  const i = locator.indexOf(':')
  if (i < 0) return { scheme: '', value: locator }
  return { scheme: locator.slice(0, i), value: locator.slice(i + 1) }
}

/** Dispatches a locator to a registered transport and enforces the fetch
 *  boundary: the size cap, and — for content-addressed locators — that the
 *  fetched bytes hash to the name BEFORE they reach admission. */
export class TransportService {
  private readonly transports: Transport[] = []
  private readonly limits: FetchLimits

  constructor(limits: FetchLimits = DEFAULT_FETCH_LIMITS) {
    this.limits = limits
  }

  register(transport: Transport): this {
    this.transports.push(transport)
    return this
  }

  supports(locator: string): boolean {
    return this.transports.some((t) => t.supports(locator))
  }

  /**
   * Fetch the bundle bytes for a locator. Enforces `maxBytes` and, for a
   * `bundle:<sha256-hex>` content-addressed locator, verifies the bytes hash to
   * the name — a transport returning the wrong bytes is caught here, before
   * admission. Throws TransportError on any bound/integrity failure.
   */
  async fetch(locator: string, limitsOverride?: Partial<FetchLimits>): Promise<Uint8Array> {
    const limits = { ...this.limits, ...limitsOverride }
    const transport = this.transports.find((t) => t.supports(locator))
    if (!transport) throw new TransportError(`no transport for locator: ${locator.slice(0, 48)}`)

    // Enforce the timeout as a SERVICE backstop — do not trust a transport to
    // self-bound. A transport that hangs must not wedge the shell.
    const bytes = await withTimeout(transport.fetch(locator, limits), limits.timeoutMs, locator)
    if (bytes.length > limits.maxBytes) {
      throw new TransportError(`fetched ${bytes.length} bytes exceeds maxBytes (${limits.maxBytes})`)
    }

    const { scheme, value } = parseLocator(locator)
    if (scheme === 'bundle') {
      const got = toHex(hash(bytes))
      if (got !== value.toLowerCase()) {
        throw new TransportError('content-addressed locator: fetched bytes do not match the hash')
      }
    }
    return bytes
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, locator: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TransportError(`fetch timed out: ${locator.slice(0, 40)}`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e as Error)
      }
    )
  })
}

export { FileTransport } from './file.js'
export { SeedTransport } from './local.js'
export { WebtorrentTransport } from './webtorrent.js'
