import { describe, it, expect } from 'vitest'
import {
  derivationPath,
  ethAddressHex,
  generateMnemonic12,
  isValidMnemonic,
  mnemonicToAccounts,
  normalizeMnemonic,
  validatePrivkeyHex
} from '../../src/shell/keyring/hd.js'

// The universally known hardhat/anvil test mnemonic and its first accounts —
// independent vectors pinning our path iteration against MetaMask behavior.
const HARDHAT = 'test test test test test test test test test test test junk'
const HARDHAT_0 = 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const HARDHAT_1 = '70997970c51812dc3a010c7d01b50e0d17dc79c8'
const HARDHAT_0_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const SECP_N = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
const SECP_N_MINUS_1 = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'

describe('mnemonicToAccounts', () => {
  it('derives the MetaMask path (hardhat vectors)', () => {
    const [a0, a1] = mnemonicToAccounts(HARDHAT, 2)
    expect(a0.index).toBe(0)
    expect(a0.address).toBe(HARDHAT_0)
    expect(a1.index).toBe(1)
    expect(a1.address).toBe(HARDHAT_1)
    // The derived key at index 0 is the well-known hardhat key.
    expect([...a0.privkey].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(HARDHAT_0_KEY)
  })

  it('address always matches the derived key', () => {
    const accounts = mnemonicToAccounts(HARDHAT, 7)
    expect(accounts.length).toBe(7)
    for (const a of accounts) expect(a.address).toBe(ethAddressHex(a.privkey))
    expect(accounts.map((a) => a.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('accepts messy casing/whitespace and rejects invalid phrases', () => {
    const messy = '  Test test TEST test\ttest test\n test test test test test JUNK  '
    expect(normalizeMnemonic(messy)).toBe(HARDHAT)
    expect(isValidMnemonic(messy)).toBe(true)
    expect(mnemonicToAccounts(messy, 1)[0]!.address).toBe(HARDHAT_0)
    expect(isValidMnemonic('test '.repeat(12))).toBe(false) // bad checksum
    expect(isValidMnemonic(HARDHAT.split(' ').slice(0, 11).join(' '))).toBe(false) // 11 words
    expect(() => mnemonicToAccounts('not a phrase', 1)).toThrow(/invalid mnemonic/)
  })
})

describe('generateMnemonic12', () => {
  it('yields distinct valid 12-word phrases', () => {
    const a = generateMnemonic12()
    const b = generateMnemonic12()
    expect(a.split(' ').length).toBe(12)
    expect(isValidMnemonic(a)).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('validatePrivkeyHex', () => {
  it('accepts optional 0x and mixed case', () => {
    for (const form of [HARDHAT_0_KEY, `0x${HARDHAT_0_KEY}`, `0X${HARDHAT_0_KEY.toUpperCase()}`, `  ${HARDHAT_0_KEY} `]) {
      const r = validatePrivkeyHex(form)
      expect(r.ok).toBe(true)
      if (r.ok) expect(ethAddressHex(r.privkey)).toBe(HARDHAT_0)
    }
  })

  it('rejects wrong lengths, non-hex, and out-of-range scalars', () => {
    for (const bad of [
      HARDHAT_0_KEY.slice(0, 63),
      HARDHAT_0_KEY + '0',
      'zz' + HARDHAT_0_KEY.slice(2),
      '0'.repeat(64), // zero
      SECP_N // the group order itself
    ]) {
      expect(validatePrivkeyHex(bad).ok).toBe(false)
    }
    expect(validatePrivkeyHex(SECP_N_MINUS_1).ok).toBe(true) // n-1 is the last valid scalar
  })
})

describe('derivationPath', () => {
  it('is the MetaMask default', () => {
    expect(derivationPath(0)).toBe("m/44'/60'/0'/0/0")
    expect(derivationPath(12)).toBe("m/44'/60'/0'/0/12")
  })
})
