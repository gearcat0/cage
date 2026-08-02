import { keccak_256 } from '@noble/hashes/sha3.js'

// ── Ethereum address display ─────────────────────────────────────────────────
// Addresses are STORED and compared as bare lowercase hex (the format's own
// convention — envelope author keys, feed rows, shell.identity). Checksumming
// is a DISPLAY concern only: EIP-55 mixed case is what wallets show and what
// users compare against MetaMask, and its case pattern catches typos when a
// human copies an address by hand.

/** EIP-55: `0x` + mixed-case hex, where a nibble is uppercased when the
 *  corresponding nibble of keccak256(lowercase-hex) is >= 8. Input may be
 *  bare or 0x-prefixed, any case. Non-address input is returned unchanged
 *  (nostr pubkeys are 32 bytes and must never be dressed up as addresses). */
export function toChecksumAddress(hex: string): string {
  const clean = hex.trim().replace(/^0[xX]/, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(clean)) return hex
  const digest = keccak_256(new TextEncoder().encode(clean))
  let out = '0x'
  for (let i = 0; i < 40; i++) {
    // Nibble i of the digest: high nibble of byte i/2 for even i, low for odd.
    const nibble = i % 2 === 0 ? digest[i >> 1]! >> 4 : digest[i >> 1]! & 0x0f
    const ch = clean[i]!
    out += nibble >= 8 ? ch.toUpperCase() : ch
  }
  return out
}

/** Elided checksummed address for tight spots: `0xf39Fd6…2266`. Anything that
 *  is not a 20-byte address falls back to plain elision of the input. */
export function shortAddress(hex: string, n = 6): string {
  const full = toChecksumAddress(hex)
  if (!full.startsWith('0x')) return full.length > 2 * n ? `${full.slice(0, n)}…${full.slice(-4)}` : full
  return `0x${full.slice(2, 2 + n)}…${full.slice(-4)}`
}
