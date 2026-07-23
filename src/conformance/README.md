# @yourproject/conformance

The interop suite. It is what lets a **second implementation prove it agrees**
with this one — byte for byte, outcome for outcome — so that a thing signed,
sealed, or rejected by one implementation is signed, sealed, or rejected
identically by the next. Format spec §11 requires it before publish.

Conformance has two halves:

- **The format half — portable data.** Deterministic test vectors in
  [`vectors/*.json`](./vectors): candidate bytes plus the expected outcome, one
  per rule the format defines. Any implementation in any language runs these.
  **This package is that half.**
- **The cage half — a live harness.** Whether an untrusted thing can break out
  of the renderer sandbox is not expressible as data; it needs a running
  browser. That half is the Playwright escape battery (`test/shell/*.spec.ts`),
  indexed at the end of this file. A second *cage* implementation runs that
  harness; a second *format* implementation runs these vectors.

## Running the vectors

In TypeScript, implement `ConformanceTarget` (the small set of format operations
the suite drives) and hand it to `runAll`:

```ts
import { formatTarget, loadVectors, runAll } from '@yourproject/conformance'

const results = runAll(formatTarget, loadVectors())
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? failed : 'all vectors pass')
```

`formatTarget` is this repo's implementation wired up as the reference. A second
implementation supplies its own target with the same six methods
(`sha256`, `decodeCanonical`, `decodeManifest`, `verifyEnvelope`, `parseTar`,
`admit`, `chainInfo`) and runs the identical vectors. In another language, read
`vectors/*.json` directly — the shapes below are the whole contract.

The reference is held to its own suite in `test/format/conformance.test.ts`
(one test per vector), which is both a self-consistency proof and a regression
guard: any behavioural drift flips a vector.

## Regenerating

```
pnpm gen:vectors                 # regenerate the deterministic vectors
FORCE_SEALED=1 pnpm gen:vectors  # also regenerate the sealed set
```

Everything except the sealed set is **deterministic** — fixed test keys, RFC-6979
ECDSA, zero-aux-rand BIP-340 Schnorr — so regeneration is byte-identical and any
diff is a real behavioural change worth reviewing. The sealed set uses fresh
random content keys / nonces / ephemeral keys (as production sealing must), so it
is generated once and **frozen**; the runner verifies the frozen bytes, which is
deterministic regardless. `generate.ts` is the only file here that holds private
keys or signs — the shipped runner only ever *verifies*.

## The vectors

All bytes are lowercase hex. Hashes are lowercase-hex sha256 (no `sha256:`
prefix). Keys are lowercase hex, no `0x`.

### `canonical.json` (13) — canonical CBOR (§2.2)
`{ name, hex, expect: "accept" | "reject", note? }`. `accept` decodes as
canonical; `reject` must be refused (**rejected, never normalized**). Covers the
RFC 7049-vs-8949 key-order trap (bytewise, not length-first), non-shortest
integers, unsorted/duplicate keys, floats, tags, indefinite lengths,
`undefined`, trailing bytes, and non-NFC text.

### `hashing.json` (4) — sha256 (§2.1)
`{ name, hex, sha256 }`. `sha256(hex) === sha256`, including a program blob and a
canonical manifest so cross-level hashing agrees.

### `envelopes.json` (4) — signature verification (§6)
`{ name, hex, expect: { status, scheme?, authorScheme?, authorKeyHex? } }`.
`verifyEnvelope(hex)` must reach `status` — `valid` for `eth-eip191` and
`nostr-schnorr`, `unverifiable` for an unknown scheme (e.g. `ssh-ed25519`),
`invalid` for a flipped signature bit. `unverifiable` ("cannot check") is a
distinct outcome from `invalid` ("failed a check").

### `bundles.json` (8) — admission (§8.1)
`{ name, tarHex, expect: { status, scheme?, envelopeHashHex?, manHashHex?, progHashHex?, attHashHex? } }`.
Parse the tar and run admission. Good bundles (eth + nostr) are `valid` with the
exact hashes at every level; the bad set is `invalid` (flipped signature,
manifest-hash mismatch, tampered `type` with intact `prog`, attachment-hash
mismatch, non-canonical manifest that decodes but is refused) or `unverifiable`
(unknown scheme). Any hash or signature failure rejects the **whole** bundle —
no partial admission.

### `chain.json` (3) — chain linkage (§5.3)
`{ name, envelopesHex[], expect: "linear" | "fork" | "gap" }`. Envelopes of one
`(author, path)`. A **fork** is two envelopes at the same `seq` with different
hashes; a **gap** is non-contiguous `seq`; otherwise, with every `prev` linking
the prior `seq`, the chain is **linear**. The classifier is `classifyChain` — a
reference for the fork/gap detection the shell library performs.

### `sealed.json` (1) — sealed bundles (§7 / §7.1)
`{ name, tarHex, recipients: [{ privHex, authorScheme, authorKeyHex }], notForMe: [privHex] }`.
A bundle sealed to three recipients. Each recipient key admits it as `valid` and
`sealed` with the inner author; a non-recipient key, **and no key at all**, get
`not-for-me` (recipients are never listed — you learn nothing without a key that
unwraps a slot).

### `limits.json` (8) — decode limits (§2.3)
`{ name, op, hex, limits?, unsealerPrivHex?, expect }`. `op` picks the entry
point (`decodeCanonical` / `decodeManifest` / `parseTar` / `admit`); `limits`
tightens a cap so the input stays small. `expect` is `{ throws: true }` (the op
refuses outright) or `{ status, reasonIncludes? }`. Covers `maxDepth`,
`maxEntries`, `maxStringBytes`, `maxAttachments`, the tar caps (`maxEntries`,
`maxEntryBytes`, `maxTotalBytes`), and the sealed-slot cap (`MAX_SEALED_SLOTS`),
which must fire **before** any trial-decryption.

> **Caller-applied caps.** `maxManifestBytes` and `maxEnvelopeBytes` (§2.3) bound
> the *raw* manifest / envelope byte length and are enforced by the embedding
> caller (the shell applies them before decode), not inside the decoder — so they
> have no decoder-level vector here. A conforming host MUST still enforce them.

## The cage half — the escape battery (indexed)

A second *cage* implementation must survive this Playwright battery
(`test/shell/*.spec.ts`), run with `pnpm test:cage`. It is not portable data — it
requires a live Electron renderer — so it is indexed here rather than encoded as
JSON:

- **admission.spec.ts** — the four admission outcomes end to end, tar-bomb /
  oversize refusal, and worker death/hang isolation (structural decode in a
  utilityProcess that holds no keys).
- **chrome.spec.ts** — N6: a thing cannot forge or overpaint the trusted chrome
  (proven at the pixel level).
- **keyring.spec.ts** — the private key never appears on disk in plaintext;
  identity persists across restarts.
- **library.spec.ts** — received-at ordering, idempotent re-ingest, fork
  detection, and a sealed thing decrypted in memory yet **never** written to disk.
- **transport.spec.ts** — content-addressed re-fetch, and verify-at-the-gate: a
  transport delivering hostile bytes is rejected by admission.
- **naming.spec.ts** — a name is shown as verified only when it provably maps to
  the thing's signature-proven author key.
