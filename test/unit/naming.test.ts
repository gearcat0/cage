import { describe, it, expect } from 'vitest'
import {
  NamingService,
  DirectResolver,
  EnsResolver,
  NostrResolver,
  NamingError
} from '../../src/shell/naming/index.js'
import { createMockEnsClient, type MockEnsData } from '../../src/shell/naming/mock-ens.js'

// The load-bearing property: a name is `verified` ONLY when the resolver's
// address equals the thing's (signature-proven) author key. The resolver is
// never trusted for the key. All deterministic via a mock ENS client.

const ADDR = 'aabbccddeeff00112233445566778899aabbccdd' // 40-hex
const OTHER = '1111111111111111111111111111111111111111'

function svc(data: MockEnsData): NamingService {
  return new NamingService()
    .register(new DirectResolver())
    .register(new EnsResolver(createMockEnsClient(data)))
    .register(new NostrResolver())
}

describe('verifyName (forward: does the name map to this key?)', () => {
  it('verified when the resolver address equals the author key', async () => {
    const s = svc({ forward: { 'alice.eth': `0x${ADDR}` } })
    expect(await s.verifyName('alice.eth', 'eth-eip191', ADDR)).toEqual({ status: 'verified', name: 'alice.eth' })
  })

  it('MISMATCH when the resolver address differs from the author key (alarm)', async () => {
    // alice.eth resolves to OTHER, but the thing is signed by ADDR.
    const s = svc({ forward: { 'alice.eth': `0x${OTHER}` } })
    const v = await s.verifyName('alice.eth', 'eth-eip191', ADDR)
    expect(v.status).toBe('mismatch')
    if (v.status === 'mismatch') expect(v.resolvedKey).toBe(OTHER)
  })

  it('unresolvable for an unknown name', async () => {
    const s = svc({})
    expect(await s.verifyName('nobody.eth', 'eth-eip191', ADDR)).toEqual({ status: 'unresolvable' })
  })

  it('is not fooled by scheme: an ENS address never verifies a nostr-schnorr key', async () => {
    const s = svc({ forward: { 'alice.eth': `0x${ADDR}` } })
    const v = await s.verifyName('alice.eth', 'nostr-schnorr', ADDR)
    expect(v.status).toBe('mismatch') // resolves, but wrong scheme
  })
})

describe('primaryName (reverse: the confirmed name for a key)', () => {
  it('verified when reverse resolves AND forward-confirms back to the key', async () => {
    const s = svc({
      forward: { 'alice.eth': `0x${ADDR}` },
      reverse: { [`0x${ADDR}`]: 'alice.eth' }
    })
    expect(await s.primaryName('eth-eip191', ADDR)).toEqual({ status: 'verified', name: 'alice.eth' })
  })

  it('REJECTS a spoofed reverse record whose forward resolution disagrees', async () => {
    // The reverse record claims bob.eth, but bob.eth forward-resolves to OTHER,
    // not ADDR — so the round-trip fails and no name is returned.
    const s = svc({
      forward: { 'bob.eth': `0x${OTHER}` },
      reverse: { [`0x${ADDR}`]: 'bob.eth' }
    })
    expect(await s.primaryName('eth-eip191', ADDR)).toEqual({ status: 'unresolvable' })
  })

  it('unresolvable when there is no reverse record', async () => {
    const s = svc({ forward: { 'alice.eth': `0x${ADDR}` } })
    expect(await s.primaryName('eth-eip191', ADDR)).toEqual({ status: 'unresolvable' })
  })
})

describe('discovery (resolve: name -> locator)', () => {
  it('reads the ENS `thing` text record as a locator', async () => {
    const s = svc({ text: { 'alice.eth': { thing: 'bundle:deadbeef' } } })
    expect(await s.resolve('alice.eth')).toBe('bundle:deadbeef')
  })

  it('errors when a name has no `thing` record', async () => {
    const s = svc({})
    await expect(s.resolve('alice.eth')).rejects.toThrow(NamingError)
  })
})

describe('direct locators + Nostr', () => {
  it('passes direct locators through resolve unchanged', async () => {
    const s = svc({})
    expect(await s.resolve('bundle:abc123')).toBe('bundle:abc123')
    expect(await s.resolve('magnet:?xt=urn:btih:z')).toBe('magnet:?xt=urn:btih:z')
    expect(await s.resolve('file:/tmp/x')).toBe('file:/tmp/x')
  })

  it('a raw locator author has no primary name', async () => {
    const s = svc({})
    expect(await s.primaryName('eth-eip191', ADDR)).toEqual({ status: 'unresolvable' })
  })

  it('routes npub / NIP-05 names to the Nostr resolver, which degrades cleanly', async () => {
    const s = svc({})
    await expect(s.resolve('npub1xyz')).rejects.toThrow(/Nostr naming is not yet supported/)
    await expect(s.resolve('alice@example.com')).rejects.toThrow(/Nostr naming is not yet supported/)
  })

  it('handles() reports whether any resolver claims a name', async () => {
    const s = svc({})
    expect(s.handles('alice.eth')).toBe(true)
    expect(s.handles('bundle:abc')).toBe(true)
    expect(s.handles('just some text')).toBe(false)
  })
})
