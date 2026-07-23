# Build brief — naming

Phase 5, and the last piece before conformance. Transport answered *how* bytes
arrive; naming answers *whose* they are and *where to find them by a human name*.
It turns `alice.eth` into two things: the author key that a thing must be signed
by to be "hers" (identity), and a locator to fetch her latest thing (discovery).

**Depends on:** the merged shell (admission, library, mount, transport) and the
existing `interface Resolver` stub in `src/shell/naming/`.

**The principle, restated for naming:** *the resolver is untrusted for the KEY;
the signature is.* A name is only ever shown as **verified** when the resolver's
answer provably matches the admitted thing's (signature-proven) author key. A
malicious or wrong resolver can fail to resolve, or point at a different key —
but it can never make the shell attach a name to a thing whose author key does
not match the resolver's own answer. The key comes from the signature (admission
already proved it); naming only adds the human name on top, and only when it
checks out.

---

## 1. Two jobs, one service

`NamingService` does exactly two things, both dispatched to registered
resolvers by name/scheme:

```ts
// Discovery: a human name → a transport locator to fetch.
resolve(name: string): Promise<string /* locator */>

// Trust: the primary verified name for an author key (reverse + forward
// confirmed), for the per-thing header. Or `unresolvable`.
primaryName(authorScheme: string, authorKeyHex: string): Promise<NameVerification>

// Trust: does this name map to this author key? (forward direction, used when
// you fetched a thing BY a name and want to confirm you got the right author.)
verifyName(name: string, authorScheme: string, authorKeyHex: string): Promise<NameVerification>
```

```ts
type NameVerification =
  | { status: 'verified'; name: string }          // resolver's answer == the thing's key
  | { status: 'mismatch'; name: string; resolvedKey: string } // resolves to a DIFFERENT key — an alarm
  | { status: 'unresolvable' }                    // no name / cannot resolve
```

`verified` is the ONLY status that earns a name in trusted chrome. `mismatch`
is styled as a warning (the discovery layer handed you someone else's content
under a name), distinct from `unresolvable` (no name known — show the raw key).

## 2. ENS (primary, via viem)

ENS matches `eth-eip191`: an ENS name resolves to a 20-byte address, which is
exactly `author.k` for an eth-signed thing.

- **Identity / `addressOf`**: `getEnsAddress(name)` → address. Compared
  (normalized: 40-hex lowercase, no `0x`) against `author.k`.
- **Reverse / `primaryName`**: `getEnsName(address)` → name, then **forward-
  confirm** `getEnsAddress(name) == address` (the mandatory ENS pattern — a
  reverse record alone is spoofable). Only a confirmed round-trip is `verified`.
- **Discovery / `resolve`**: read an ENS **text record** (`thing`) holding a
  locator (`magnet:` / `bundle:` / …). `resolve("alice.eth")` → that locator,
  which transport then fetches. No record → unresolvable.

The ENS reads go through an injected `EnsClient` interface
(`getAddress` / `getName` / `getText`). Production supplies a **viem-backed**
client against an RPC (`ens-viem.ts`); it is exercised **manually**, not in CI.
Every test uses an in-memory **mock client** — so the whole trust property is
deterministic without a network, and viem's live path is the only untested part.

viem is loaded lazily (like webtorrent): the live ENS path degrades with a clear
"install viem" error rather than crashing if it is absent; the mock path never
touches it.

## 3. Direct locators pass through

`thing:` / `bundle:` / `magnet:` / `file:` are already locators — the
`DirectResolver` returns them unchanged from `resolve`, and has no name (so
`primaryName` for a raw-hash author is `unresolvable`). Direct-hash ingestion
keeps working with no resolver in the room — the most honest test that the core
holds without any chain.

## 4. Nostr — stubbed behind the interface

`npub…` / NIP-05 discovery + relay subscriptions are wired as a `NostrResolver`
that reports "not yet supported". Its slot proves the abstraction holds a second
naming system; the implementation is a later pass (relays = network + state).

## 5. Shell wiring

- The omnibar already fetches locators; it now also accepts a **name**. Input
  that no transport claims is handed to `naming.resolve` → a locator → transport
  → admission. (If it was a name, the admitted author is forward-verified against
  the name; a mismatch is surfaced, not silently accepted.)
- The per-thing trust header shows the author's **verified primary name** when
  `primaryName` confirms one, and the raw key (styled "unverified") otherwise.
  The name lives in chrome pixels the thing cannot reach — same as every trust
  signal.

## 6. Tests (deterministic, mock ENS — no network)

- **name↔key verification (the load-bearing property)** — with a mock resolver:
  `verified` iff the resolver's address equals the thing's author key; a resolver
  that returns a DIFFERENT address → `mismatch` (never shown as verified); an
  unknown name → `unresolvable`. The resolver is never trusted for the key.
- **ENS reverse + forward confirmation** — a reverse record that forward-confirms
  → `verified`; a reverse record whose forward resolution disagrees (spoof) →
  NOT verified.
- **discovery** — `resolve("alice.eth")` reads the text record → a locator →
  fetch → admit → the thing in the feed; a name with no record → unresolvable.
- **direct pass-through** — `resolve("bundle:<hash>")` returns it unchanged;
  `primaryName` for a direct/raw author is `unresolvable`.
- **shell trust header** — an admitted thing whose author has a confirmed ENS
  name shows it as verified; one without shows the raw key, unverified; a
  mismatched name is not shown as verified.
- **Nostr** — an `npub…` name routes to the Nostr resolver and degrades cleanly.

## 7. Definition of done

A `NamingService` with `resolve` (discovery) and `primaryName` / `verifyName`
(trust); ENS via an injected `EnsClient` with reverse+forward-confirmed name
verification and text-record discovery, viem-backed for live use and
mock-tested; direct locators passing through; Nostr stubbed; the shell resolving
names to locators for fetch and showing a **verified** name in the trust header
only when it provably matches the thing's author key; a deterministic test
battery proving a wrong/malicious resolver can never attach a name to the wrong
author.

## 8. Out of scope (`// LATER:`)

Nostr relay discovery + subscriptions; ENS key rotation / revocation (format
gap #3); watching a chain/relay for new things (the feed is still ingest-driven);
DNSSEC / other name systems; caching/TTL policy for resolutions.
