# Build brief — the bridge

Phase 2. This fleshes out the shell↔thing bridge from its phase-1 stub
(`getArgs` returning test JSON, `emit` logging) into the real interface defined
by the format spec. It is a small surface — four methods — so this brief is
mostly about getting four decisions right and enumerating the cage changes they
force.

**Depends on:** `FORMAT_SPEC_DRAFT.md` (manifest, attachment table, admission).
**Does not build:** signing, sealing, the keyring, ENS/naming, transport, the
feed, or file-picking. Those are later. When something here proves the format
spec impractical, note it — we update the spec rather than working around it.

The invariant from phase 1 is unchanged and dominates every decision below: **the
thing is untrusted code with nothing worth stealing and nowhere to send it.** The
bridge must not become the "somewhere to send it." Every method either hands the
thing data it already came with, or accepts a *request* that grants nothing until
a human confirms it in trusted chrome.

---

## The contract

Four methods on the frozen `bridge` object in the preload. Nothing else.

```ts
bridge.getArgs(): ThingArgs            // sync — render on first paint
bridge.getBlob(name: string): string | null   // sync — returns a thing:// URL
bridge.viewerInfo(): ViewerInfo        // sync — coarse, non-identifying
bridge.emit(channel: string, data: unknown): void   // fire-and-forget request
```

`getArgs`, `getBlob`, and `viewerInfo` are synchronous because a thing renders
from them on first paint, and none of them moves large data (see `getBlob`
below — it returns a *URL*, not bytes). `emit` is fire-and-forget.

### `getArgs()` → a decoded, read-only view. NOT raw CBOR. NOT the envelope.

This is the decision most worth scrutinising, so here is the reasoning explicitly.

The shell has **already** decoded and validated the manifest during admission
(spec §8.1 step 6) before any byte reached the cage. Handing the thing raw CBOR
would force a *second* CBOR decoder to live inside untrusted program code, and
require the two decoders to agree byte-for-byte — reintroducing the
canonicalization surface the format works hard to contain, inside the one place
we least want it. The thing gains nothing from raw bytes: it is not verifying
signatures (that happened shell-side, before render), so it has no use for the
wrapper.

So the shell hands the thing a structured-cloned view:

```ts
interface ThingArgs {
  type: string                 // manifest.type — a display hint (see below)
  args: unknown                // manifest.args — program-defined, opaque
  attachments: AttInfo[]       // names + metadata, NOT bytes, NOT hashes
}
interface AttInfo { name: string; mime: string; size: number }
```

What is **deliberately withheld**:

- **The envelope — author, signature, timestamp, path/seq.** The thing must never
  render an identity claim, because a thing that draws "signed by alice.eth" can
  lie. Verified author and signature status live in chrome pixels the thing
  cannot touch (phase 1's unspoofable strip). If a later program needs to lay out
  around an author line, we revisit — but the default is that identity is
  chrome's exclusive job. `getArgs` is the wrong channel for it.
- **`prog`** — the thing *is* the program; it does not need its own hash.
- **Attachment hashes** — the thing addresses blobs by name via `getBlob`, never
  by hash. Withholding hashes keeps the thing from constructing its own content
  claims.

`type` is passed through but is a hint only: per spec §4 it MUST NOT be trusted,
and the thing has no authority anyway. It is there so a program that renders more
than one type can branch.

Practical note for the format spec: `manifest.args` is CBOR `any`, so a manifest
could carry maps with integer keys or byte strings, which structured-clone
surfaces to JS as `Map`/`Uint8Array`. Most programs will want plain
JSON-shaped args. **Recommend (not require) in the spec that `args` be
JSON-representable**, so program authors do not trip over `Map` keys; the bridge
still passes through whatever structured clone supports.

### `getBlob(name)` → a `thing://` URL, not the bytes

This is the load-bearing design choice. Attachments can be a 200 MB video;
pumping that through `sendSync` or an IPC buffer is a non-starter. Instead
`getBlob` returns a URL served by the phase-1 `thing://` protocol handler — the
cage's *only* permitted read path — and the thing uses it as an ordinary
`src`/`href`:

```ts
const url = bridge.getBlob('poster')     // "thing://<id>/att/poster" or null
img.src = url
```

The handler streams the bytes from the local content-addressed store. This means
**the bridge moves no attachment bytes at all** — it hands back a string, and the
existing, already-audited handler does the serving. Streaming, range requests,
and browser-native media handling all come for free.

Where the authorization actually lives — state this plainly for auditors:

- The security gate is the **attachment table plus the handler**, not the
  `getBlob` function. A thing can construct `thing://<its-id>/att/<name>` itself;
  `getBlob` returning `null` for an unknown name is a convenience and a clean
  signal, not the boundary.
- At mount, the shell registers the manifest's attachment table (name → hash,
  mime, size) with the cage. The handler resolves `att/<name>` by looking up the
  name, then streams `blobs/<hex-hash>` from the CAS. An unknown name is a 404 —
  exactly the "serves only supplied bytes" property phase 1 already tests (and
  which finding P1-4 is fixing to test *properly*).
- **Integrity is verified at admission, not per-serve.** Admission (§8.1 step 8)
  already hashed every attachment before the thing loaded. The CAS is keyed by
  hash and is shell-controlled and read-only to the thing, so re-hashing a 200 MB
  video on every range request buys nothing against the threat model (a thing
  cannot touch the CAS; local malware editing the CAS is out of scope — if local
  disk is compromised, the game is already over). Verify once, serve by hash
  thereafter.

Serve `att/<name>` with the manifest's `mime` and `X-Content-Type-Options:
nosniff` (spec §4). Support HTTP `Range` on this route so media seeking works;
without it, `<video>` scrubbing breaks.

### `viewerInfo()` → coarse and non-identifying

```ts
interface ViewerInfo { locale: string; colorScheme: 'light' | 'dark' }
```

Enough for a thing to localize a date or match the theme. **No timezone at fine
grain, no unique id, no screen dimensions, no anything that fingerprints.** The
whole point of the project is that a thing cannot spy on its reader; a chatty
`viewerInfo` would quietly reintroduce exactly that. When in doubt, leave a field
out — a thing that needs more can ask via `emit` and let the human decide.

### `emit(channel, data)` → a request that grants nothing

`emit` is how a thing hands the shell a *draft of a new instance of itself* (the
create flow) or any other request. It is fire-and-forget in phase 2: the thing
cannot tell whether the user confirmed, because confirmation is a human decision
in chrome that the thing has no business observing. (A later phase may add a
request/response channel for cases where the thing genuinely needs the outcome;
not now.)

The draft shape mirrors a manifest-to-be, so the shell can later assemble, sign,
and seal it without a format change:

```ts
// channel: "publish"
emit("publish", {
  type: string,
  args: unknown,
  blobs?: { [name: string]: Uint8Array }   // inline bytes for new attachments
})
```

On receipt the shell (NOT the bridge, and NOT in this phase beyond validation):
validates the shape, enforces the size caps below, hashes each inline blob to
build the attachment table, assembles a draft manifest, and — for phase 2 —
persists it to a drafts area / records it. Signing, sealing, and the review UI
are later phases; this brief only needs the *message contract* and the
*receipt-side validation* to be right so nothing downstream has to change shape.

How new attachments get their bytes: in phase 2, only inline `blobs` in the emit
payload (a thing generating an SVG, say). A user attaching a *file* needs the
shell to mediate a file picker — the thing has no filesystem — which is a future
`bridge.requestFile()` method, explicitly out of scope now.

---

## Sealed content: decrypt shell-side, keep plaintext out of the persistent CAS

By the time `getArgs` runs, a sealed thing has already been decrypted shell-side
during admission (§8.1 step 2), so the thing only ever sees plaintext args and
never touches ciphertext or keys — good. But its decrypted attachments must
**not** be written to the persistent, content-addressed CAS, or you have silently
written someone's private video to disk in the clear. For sealed things, serve
`att/<name>` from an **ephemeral in-memory store** scoped to that cage's lifetime,
not the on-disk CAS. Public things use the CAS as normal.

Format-spec note: this is a shell obligation the spec does not currently state.
When we add a "shell obligations" section, record that decrypted sealed content
is memory-only.

---

## Cage changes this forces (checklist)

1. **Protocol handler** (`src/main/protocol.ts`): add the `att/<name>` route.
   Parse `thing://<id>/att/<name>`, look the name up in the cage's attachment
   table, stream from CAS (public) or memory store (sealed), set `mime` +
   `nosniff`, support `Range`. Keep the existing `index.html` route. Reject
   unknown names with 404 (this is the property P1-4 tests, so update that test
   to cover `att/` too).
2. **Cage registration** (`src/main/cage.ts` / `bridge.ts`): `setArgsFor` no
   longer takes ad-hoc JSON — it takes the decoded `ThingArgs` view plus the
   attachment table and the store handle (CAS vs ephemeral). Thread these to the
   handler.
3. **Preload surface** (`src/preload/index.ts`): expose the four methods on the
   frozen object. `getArgs`/`viewerInfo` via `sendSync`; `getBlob` via `sendSync`
   returning a string (it only computes a URL, so it stays cheap); `emit`
   unchanged.
4. **Bridge shell side** (`src/main/bridge.ts`): implement `cage:getBlob`
   (resolve name → URL or null against the table), `cage:viewerInfo`, and reshape
   `cage:getArgs` to return `ThingArgs`. Keep the phase-1 `emit` size cap
   (`MAX_EMIT_BYTES`), and add a **total** inline-blob cap and per-blob cap on the
   `publish` path (see finding P0-3 about count-unbounded growth — apply the same
   discipline here: bound total bytes accepted per draft, not just per blob).
5. **CSP**: already permits `thing:` for `img-src`/`media-src`/`connect-src`;
   confirm `att/` responses inherit the same THING_CSP. No new directive needed.
6. **Update the surface test** (`test/things/escalate-bridge-surface.html` +
   its assertion): the expected frozen key set changes from `['emit','getArgs']`
   to `['emit','getArgs','getBlob','viewerInfo']`. This test is the guard that
   the surface does not silently widen, so it MUST be updated deliberately and
   reviewed, not auto-fixed.

---

## Tests to add

- **Positive:** a thing that reads `args`, lists `attachments`, calls
  `getBlob('poster')`, sets an `<img src>` to the returned URL, and renders it —
  proving the whole path works end to end.
- **Attachment served only by name:** `getBlob('known')` loads; `getBlob('nope')`
  returns `null`; a hand-built `thing://<id>/att/nope` 404s. (Folds into P1-4.)
- **Range:** a `<video>` attachment seeks (a `Range` request is served with 206).
- **`getArgs` withholds the envelope:** assert the object handed to the thing has
  no author/signature/timestamp fields — a regression here is an identity-spoof
  vector, so pin it.
- **`viewerInfo` is coarse:** assert it exposes only `locale` + `colorScheme` and
  nothing id-like.
- **`emit('publish', …)` validation:** oversized total blobs rejected; malformed
  draft rejected; a valid draft recorded with the expected assembled attachment
  table.
- **Sealed content stays off disk:** after a sealed thing renders an attachment,
  assert nothing was written to the persistent CAS path (memory-only serve).
- **Surface:** the updated four-key frozen-surface assertion.

---

## Definition of done

`getArgs`/`getBlob`/`viewerInfo`/`emit` implemented against the shapes above; a
positive thing renders args + an attachment via the URL path; `att/<name>` serves
by name with range support and 404s the unknown; the envelope is provably
withheld from the thing; `viewerInfo` is coarse; the `publish` draft path
validates and bounds input; sealed attachments serve from memory, not the CAS;
the frozen surface is exactly the four methods and the surface test asserts it;
the phase-1 escape suite still passes unchanged.

## Out of scope (leave `// LATER:` notes, do not build)

Signing and envelope assembly; sealing/encryption; the keyring and any key
material in the shell; the review/confirm UI; `requestFile()` and file-picking;
request/response `emit`; ENS/naming; transport; the feed/library. The bridge
holds no keys, does no crypto, opens no network, and reads only the local,
content-addressed (or ephemeral) blob store behind the existing handler.
