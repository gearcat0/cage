# Build brief — `@yourproject/conformance` (phase 6)

## Why

A protocol with one implementation has no interop — it has a reference and a
hope. Conformance is the artifact that turns "our code does X" into "X is the
rule, and here is how you prove your code does it too." Format spec §11 names it
required before publish. This phase builds the **format half**: the deterministic
vectors a second implementation runs to prove it decodes, hashes, verifies,
admits, chains, seals, and bounds **byte-for-byte identically**.

## The principle

**Vectors are data, not code.** The interop contract is the JSON — candidate
bytes plus the expected outcome — not any one language's runner. A second
implementation must be able to consume `vectors/*.json` with nothing from this
repo. The TypeScript runner (`runAll` over a `ConformanceTarget`) is a
convenience for TS implementers and the mechanism by which the reference holds
*itself* to the suite; it is not the contract.

**Reject, never normalize.** The canonical-CBOR vectors are the sharp edge: a
decoder that silently normalized non-canonical input would hash differently from
the sender and turn an encoder bug into a signature forgery. Every non-canonical
input is an `expect: "reject"`.

**The reference passes its own suite.** `test/format/conformance.test.ts` runs
the whole battery against our format package — self-consistency proof and
regression guard in one. Behavioural drift flips a vector.

## Scope

- **`ConformanceTarget`** — the minimal surface interop exercises (`sha256`,
  `decodeCanonical`, `decodeManifest`, `verifyEnvelope`, `parseTar`, `admit`,
  `chainInfo`), plus `formatTarget` wiring our implementation to it.
- **The runner** — pure `(target, vectors) → results`, one result per vector,
  with the §5.3 chain classifier (`classifyChain`) as shared reference logic.
- **The vectors** (`vectors/*.json`, 41 across seven categories) covering every
  §11 bullet: canonical CBOR (incl. the RFC 7049-vs-8949 key-order trap), the
  hash chain at every level, per-scheme verification + the known-bad set, chain
  linear/fork/gap, a bundle sealed to three recipients + not-for-me, and one
  vector per §2.3 limit.
- **The generator** (`generate.ts`) — deterministic (fixed keys, RFC-6979,
  zero-aux-rand Schnorr) so regeneration is byte-identical and reviewable; the
  sealed set is frozen-once (real random sealing). The only file here that signs.
- **The README** — the second-implementation guide (the JSON schema is the whole
  contract) and an index of the **cage half**: the Playwright escape battery,
  which is inherently host-specific and stays a live harness, not portable data.

## Out of scope (later)

- Packaging the escape battery as a portable cross-cage harness (today it is
  Electron-specific and indexed, not exported).
- Vectors for scheme extensions not yet implemented (`ssh-ed25519` verification —
  its slot proves the registry, but it stays `unverifiable` until built) and for
  the caller-applied raw-size caps (`maxManifestBytes` / `maxEnvelopeBytes`),
  which are enforced by the embedding host, not the decoder.
- A published npm artifact + a CI job that runs the vectors against a second
  (non-TS) implementation once one exists.

## Test battery

`test/format/conformance.test.ts`: one test per vector, plus a guard that all
seven categories are present and non-empty. Passing means the reference agrees
with its own frozen description of the format.
