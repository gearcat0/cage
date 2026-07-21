# src/format — the thing format (reference implementation)

The implementation of the format spec (`gearcat0/format`,
`FORMAT_SPEC_DRAFT.md`). It lives inside this repo for now so the whole system
builds and tests together; it is written to be extracted into its own package
(`@yourproject/format`) later with a `git mv` — nothing here imports from the
shell or the cage.

The **spec** is the separate `gearcat0/format` repo (spec only, no code). When
the implementation surfaces a discrepancy in the spec, it is fixed by a PR
against that repo's `FORMAT_SPEC_DRAFT.md`.

## Modules

| Module | Responsibility |
|---|---|
| `cbor.ts` | Strict **canonical** CBOR (§2.2): reject-not-normalize. |
| `limits.ts` / `hash.ts` | §2.3 decode limits + 512 slot cap; SHA-256 helpers. |
| `manifest.ts` / `envelope.ts` | Decode/encode (§4, §5); domain-separated `signing_input`; the `Signer` interface. |
| `schemes.ts` / `verify.ts` | Verifier registry; real `eth-eip191` + `nostr-schnorr`; `ssh-ed25519` a documented slot → `unverifiable`. |
| `nip44.ts` / `sealed.ts` | NIP-44 v2 wraps; `seal`/`unseal` (§7) with an injected `Unsealer` (format never holds key bytes). |
| `bundle.ts` | Tar parse (tar-bomb caps) + `admitBundle` (§8.1), four distinct outcomes, hashes over **received** bytes. |

Crypto: `@noble/*`. Canonical CBOR is hand-written (off-the-shelf CBOR libs use
RFC 7049 length-first key ordering, not RFC 8949 §4.2.1 bytewise — §2.2 warns
about this). Tests: `test/format/`.

## Known deviations from the spec (to reconcile)

- **Sealed content admits signature-only.** The spec was ambiguous about where a
  sealed thing's manifest/program/attachments live; the proposed resolution is
  `gearcat0/format#2` (new §7.1). Once it merges, wire up sealed-member
  decryption in `bundle.ts` (`admitBundle`). Reading sealed *identity* works
  today; sealed *content* does not.
- **Outer `ct` padding.** §7 says "reuse NIP-44's padding scheme"; `sealed.ts`
  currently pads the inner envelope to a 256-byte bucket instead of NIP-44's
  `calc_padded_len`. Conform before interop matters.
- **`ssh-ed25519`** verification is unimplemented (the scheme is a documented
  registry slot → `unverifiable`).
- **§11 conformance vectors** are not built yet.
