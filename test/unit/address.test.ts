import { describe, it, expect } from 'vitest'
import { shortAddress, toChecksumAddress } from '../../src/shell/address.js'

describe('toChecksumAddress (EIP-55)', () => {
  it('matches the EIP-55 reference vectors', () => {
    for (const vector of [
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
    ]) {
      expect(toChecksumAddress(vector.toLowerCase())).toBe(vector)
      expect(toChecksumAddress(vector)).toBe(vector) // idempotent
      expect(toChecksumAddress(vector.slice(2).toLowerCase())).toBe(vector) // bare hex in
    }
  })

  it('checksums the hardhat account 0 address the way wallets show it', () => {
    expect(toChecksumAddress('f39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe(
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
    )
  })

  it('leaves non-addresses alone (e.g. 32-byte nostr pubkeys)', () => {
    const nostr = 'a'.repeat(64)
    expect(toChecksumAddress(nostr)).toBe(nostr)
    expect(toChecksumAddress('not hex')).toBe('not hex')
    expect(toChecksumAddress('')).toBe('')
  })
})

describe('shortAddress', () => {
  it('elides a checksummed address around the 0x prefix', () => {
    expect(shortAddress('f39fd6e51aad88f6f4ce6ab8827279cfffb92266')).toBe('0xf39Fd6…2266')
  })

  it('falls back to plain elision for non-addresses', () => {
    expect(shortAddress('a'.repeat(64))).toBe('aaaaaa…aaaa')
  })
})
