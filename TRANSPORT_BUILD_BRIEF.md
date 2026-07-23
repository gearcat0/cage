# Build brief — transport

Phase 4. Phase 3 built the shell that admits, indexes, and mounts things from
**file / paste / drag**. Transport is how those same bytes arrive from
*anywhere* — a magnet link, a peer, a URL — without changing anything downstream.
The whole design already anticipates this: a bundle is self-contained and
verify-at-the-gate means the fetch is untrusted for content. This brief makes the
fetch real and keeps that property load-bearing.

**Depends on:** the merged shell (admission, library, mount) and the existing
`interface Transport` stub in `src/shell/transport/`.

**The one principle that governs everything here:** *the transport is untrusted
for content; admission is the only gate.* A transport hands the shell raw bytes.
It cannot make the shell admit anything — admission re-verifies every signature
and hash over the received bytes. So a malicious peer, a corrupted download, or a
buggy transport yields at worst a rejected bundle, never a compromise. What the
transport CAN do is exhaust resources (stream unbounded data, hang), so the fetch
path is **resource-bounded** even though it is content-untrusted.

---

## 1. The interface and the locator

A locator is a scheme-tagged string naming where/what to fetch. The transport
layer dispatches by scheme; adding a transport MUST NOT require touching
admission or the library.

```ts
interface Transport {
  supports(locator: string): boolean
  fetch(locator: string, limits: FetchLimits): Promise<Uint8Array>
}
```

v1 locators:

- `file:<absolute-path>` — read a bundle from local disk (drag-drop / "open
  file" already do this in-process; this is the same via a locator).
- `bundle:<sha256-hex>` — **content-addressed**: fetch the bundle whose tar bytes
  hash to `<sha256-hex>`. Served from the local seed store (below), and later
  from peers. The name IS the integrity check.
- `magnet:?xt=urn:btih:…` — BitTorrent via webtorrent (wired behind the
  interface; see §4).

Naming (`thing:<name>` → locator) is the *next* brief; it resolves a name to one
of these locators. Direct locators work with no resolver at all.

## 2. Resource bounds — the fetch is the boundary

The fetch pulls attacker-influenced bytes into the trusted process before
admission runs, so it MUST be bounded:

- **`maxBytes`** — refuse (and abort the download) once the fetched size exceeds
  the cap. Default = the bundle raw-size cap (256 MiB). A streaming transport
  (webtorrent) MUST stop downloading past the cap, not buffer-then-check.
- **`timeoutMs`** — a fetch that stalls (a dead magnet, a slow peer) MUST time
  out and be abandoned, freeing the transport, without wedging the shell.

A fetch that exceeds a bound is a clean `TransportError`, never a crash.

## 3. Content-addressed integrity (before admission)

For a **content-addressed** locator (`bundle:<hash>`), the service verifies
`sha256(fetched bytes) == <hash>` *before* handing the bytes to admission. This
is the "the locator names the exact bytes" guarantee: a transport that returns
the wrong bytes for a `bundle:<hash>` request is caught at the fetch layer, not
left to admission. (For `file:` and `magnet:` there is no content hash in the
locator — `magnet` has its own infohash integrity inside webtorrent — so
admission is the sole gate.)

## 4. webtorrent — wired, live path manual

`magnet:` routes to a `WebtorrentTransport` that **lazily imports** `webtorrent`
and downloads the bundle, enforcing `maxBytes` / `timeoutMs`. webtorrent is a
heavy WebRTC/DHT dependency and this environment has no peers, so:

- It is wired behind the interface — a magnet locator dispatches to it — but its
  live-network path is exercised **manually**, not in CI.
- If `webtorrent` is not installed (the default here), the transport fails with a
  clear, actionable error (install it to enable), never a crash. A test asserts
  a magnet locator routes to the webtorrent transport and degrades cleanly.
- Enabling it is `pnpm add webtorrent`; the code path is already there.

Seeding: an admitted bundle is retained in a **seed store** (content-addressed by
tar-hash) so the shell can re-serve it — `bundle:<hash>` fetches from it in
tests, and webtorrent seeds from it when enabled. Seeding a **sealed** bundle
re-serves its ciphertext (the paper-flyer forward property, §7); the seed store
holds the raw admitted bytes, which for sealed things are already encrypted.

## 5. Fetch → admit → library

`TransportService.fetch(locator, limits)` returns bounded bytes; the shell then
runs the *existing* ingest path (admission → library). Nothing about admission or
the library changes. A new shell hook + omnibar affordance let a user paste a
locator (magnet/bundle/file) instead of raw bytes.

On admit, the raw bundle is added to the seed store so it can be re-served.

## 6. Tests (deterministic, no network)

- **verify-at-the-gate battery** — the load-bearing property. A transport that
  returns HOSTILE bytes (garbage / a tampered bundle) → fetch-and-admit rejects
  (admission `invalid`) and the keyring survives; nothing enters the library. A
  transport that returns OVERSIZED bytes → fetch refused by the cap, nothing
  admitted. A transport that hangs → times out, shell survives.
- **content-addressed integrity** — `bundle:<hash>` whose bytes match → admitted;
  whose bytes DON'T match the hash → rejected at the fetch layer, before
  admission.
- **round-trip** — seed an admitted bundle, fetch it back by `bundle:<hash>`,
  admit → same envelope in the feed. `file:<path>` fetch → admit.
- **webtorrent wiring** — a `magnet:` locator routes to the webtorrent transport
  and, with webtorrent absent / no network, fails with a clear error (not a
  crash); no other transport claims it.

## 7. Definition of done

A `Transport` interface with dispatch by locator scheme; real `file:` and
content-addressed `bundle:` transports; a seed store that retains admitted
bundles; webtorrent wired behind the interface for `magnet:` with a clean
degrade when absent; the fetch path resource-bounded (size + timeout) and
content-addressed locators integrity-checked before admission; a verify-at-the-
gate test battery proving a hostile/oversized/hanging transport cannot compromise
or wedge the shell; the fetch→admit→library→seed flow wired end to end with a
shell hook and an omnibar affordance.

## 8. Out of scope (`// LATER:`)

Naming resolution (`thing:<name>` → locator) — the next brief. HTTP(S) transport.
webtorrent live-network testing and seeding-to-peers in CI. DHT privacy hardening.
Partial/streaming render before full fetch. Peer reputation / rate-limiting.
