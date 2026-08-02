import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { HDKey } from '@scure/bip32'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

// ── HD identity derivation (MetaMask-compatible) ─────────────────────────────
// Pure module — NO electron imports, so vitest can exercise it directly.
// Testers bring Ethereum wallets: a BIP-39 phrase derives accounts along the
// MetaMask path m/44'/60'/0'/0/{index}; the shell persists ONLY the chosen
// account's derived key (the mnemonic never touches disk — a funds-bearing
// seed must not rest under our at-rest encryption, which on machines without
// an OS keychain is obfuscation, not protection).
//
// Only Uint8Arrays cross the @scure/@noble package boundary — never curve or
// HDKey objects — so version drift between the pinned deps stays byte-safe.

export interface DerivedAccount {
  index: number
  privkey: Uint8Array
  /** Lowercase 40-hex, NO 0x prefix — the shell's address convention. */
  address: string
}

/** MetaMask's default Ethereum derivation path for account `index`. */
export const derivationPath = (index: number): string => `m/44'/60'/0'/0/${index}`

/** Phrases arrive typed or pasted: trim, lowercase, collapse whitespace. */
export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(' ')
}

export function isValidMnemonic(input: string): boolean {
  return validateMnemonic(normalizeMnemonic(input), wordlist)
}

/** A fresh 12-word phrase (128 bits) for the in-app "new identity" flow. */
export function generateMnemonic12(): string {
  return generateMnemonic(wordlist, 128)
}

/** keccak256(uncompressed_pubkey[1:])[-20:], hex. Deliberately duplicated
 *  from the keyring's private helper — that module imports electron and this
 *  one must stay pure. */
export function ethAddressHex(privkey: Uint8Array): string {
  const uncompressed = secp256k1.Point.fromBytes(secp256k1.getPublicKey(privkey, true)).toBytes(false)
  const digest = keccak_256(uncompressed.subarray(1))
  let s = ''
  for (const b of digest.subarray(digest.length - 20)) s += b.toString(16).padStart(2, '0')
  return s
}

/** Derive the first `count` accounts of a phrase along the MetaMask path.
 *  Throws on an invalid phrase or an underivable index (astronomically rare). */
export function mnemonicToAccounts(mnemonic: string, count: number, passphrase = ''): DerivedAccount[] {
  const normalized = normalizeMnemonic(mnemonic)
  if (!validateMnemonic(normalized, wordlist)) throw new Error('invalid mnemonic')
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized, passphrase))
  const accounts: DerivedAccount[] = []
  for (let index = 0; index < count; index++) {
    const child = root.derive(derivationPath(index))
    if (!child.privateKey) throw new Error(`underivable index ${index}`)
    const privkey = new Uint8Array(child.privateKey)
    accounts.push({ index, privkey, address: ethAddressHex(privkey) })
  }
  return accounts
}

/** Strict private-key parse: optional 0x, exactly 64 hex chars, 0 < k < n. */
export function validatePrivkeyHex(hex: string): { ok: true; privkey: Uint8Array } | { ok: false; error: string } {
  const clean = hex.trim().replace(/^0[xX]/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    return { ok: false, error: 'A private key is 64 hex characters (0x prefix optional).' }
  }
  const privkey = new Uint8Array(32)
  for (let i = 0; i < 32; i++) privkey[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  try {
    secp256k1.getPublicKey(privkey, true) // throws on 0 or k >= n
  } catch {
    return { ok: false, error: 'Not a valid secp256k1 private key (out of range).' }
  }
  return { ok: true, privkey }
}
