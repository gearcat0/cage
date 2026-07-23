import { describe, it, expect } from 'vitest'
import {
  TransportService,
  TransportError,
  parseLocator,
  type FetchLimits,
  type Transport
} from '../../src/shell/transport/index.js'
import { hash, toHex } from '../../src/format/index.js'

// The TransportService is the fetch BOUNDARY: it dispatches by scheme, enforces
// the size cap and timeout as a backstop (a transport is not trusted to
// self-bound), and verifies content-addressed locators before admission.

class FakeTransport implements Transport {
  constructor(
    private readonly scheme: string,
    private readonly impl: (locator: string, limits: FetchLimits) => Promise<Uint8Array>
  ) {}
  supports(locator: string): boolean {
    return locator.startsWith(`${this.scheme}:`)
  }
  fetch(locator: string, limits: FetchLimits): Promise<Uint8Array> {
    return this.impl(locator, limits)
  }
}

const small: FetchLimits = { maxBytes: 1024, timeoutMs: 500 }

describe('parseLocator', () => {
  it('splits scheme and value', () => {
    expect(parseLocator('bundle:abc')).toEqual({ scheme: 'bundle', value: 'abc' })
    expect(parseLocator('magnet:?xt=urn:btih:z')).toEqual({ scheme: 'magnet', value: '?xt=urn:btih:z' })
    expect(parseLocator('nope')).toEqual({ scheme: '', value: 'nope' })
  })
})

describe('TransportService', () => {
  it('errors when no transport supports the locator', async () => {
    const svc = new TransportService(small)
    await expect(svc.fetch('unknown:x')).rejects.toThrow(TransportError)
  })

  it('content-addressed: accepts bytes that hash to the name', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const hex = toHex(hash(bytes))
    const svc = new TransportService(small).register(new FakeTransport('bundle', async () => bytes))
    expect(await svc.fetch(`bundle:${hex}`)).toEqual(bytes)
  })

  it('content-addressed: REJECTS bytes that do not hash to the name (before admission)', async () => {
    const svc = new TransportService(small).register(
      new FakeTransport('bundle', async () => new Uint8Array([9, 9, 9]))
    )
    // The locator names a different hash than the bytes produce.
    await expect(svc.fetch(`bundle:${'0'.repeat(64)}`)).rejects.toThrow(/do not match the hash/)
  })

  it('enforces the size cap (fetched bytes over maxBytes)', async () => {
    const svc = new TransportService(small).register(
      new FakeTransport('big', async () => new Uint8Array(small.maxBytes + 1))
    )
    await expect(svc.fetch('big:x')).rejects.toThrow(/exceeds maxBytes/)
  })

  it('enforces the timeout as a backstop when a transport hangs', async () => {
    const svc = new TransportService(small).register(
      new FakeTransport('slow', () => new Promise<Uint8Array>(() => {})) // never resolves
    )
    await expect(svc.fetch('slow:x')).rejects.toThrow(/timed out/)
  })

  it('propagates a transport error as-is', async () => {
    const svc = new TransportService(small).register(
      new FakeTransport('bad', async () => {
        throw new TransportError('boom')
      })
    )
    await expect(svc.fetch('bad:x')).rejects.toThrow(/boom/)
  })
})
