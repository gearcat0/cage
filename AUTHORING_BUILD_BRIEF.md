# Build brief — authoring + ship-to-testers (phase 7)

## Why

The shell can *receive, verify, and view* things, but not *make* one — so an
early tester has nothing to test the concept **with**. This phase closes the
loop: pick an HTML file → sign it with your identity → get a shareable `.thing`
file. Sharing is **file handoff** (the "flyer" model): a `.thing` travels over
any channel — chat, email, USB — and the receive side already admits it. No
server, no network dependency, fully decentralized, least that can flake in a
first test. Live P2P (webtorrent/magnet) is the immediate fast-follow, not a
blocker.

Because real people will now hold real keys, the software-key **safety warning**
(promised for this stage) lands here too.

## The principle

**Authoring is the mirror of admission, and it lives in `format`.** `admitBundle`
parses + verifies a bundle; `buildBundle` builds + signs one. A bundle *writer*
(`packBundle`, the tar counterpart to `parseBundle`) belongs in the format
package because anyone writing a thing — a bot, a CLI, a rival shell — needs it,
exactly as they need the reader. The shell just supplies its keyring `Signer`;
`format` never sees key bytes (the §2.2 injected-interface rule, unchanged).

**A thing you author is a thing like any other.** After signing, the shell runs
its own new `.thing` back through admission and into the library — so you see
your creation in your own feed, and it is seeded (re-servable by `bundle:<hash>`,
which the live-transport fast-follow will use). No special "my drafts" trust
path; the gate is the same for everyone.

## Scope

- **`format`: `packBundle` + `buildBundle`.** `packBundle(parts)` writes a
  canonical ustar (`envelope.cbor`, `manifest.cbor`, `program`, `blobs/<hex>`) —
  symmetric with `parseBundle`. `buildBundle(signer, opts)` builds the manifest +
  signed envelope and packs them — symmetric with `admitBundle`. Public bundles
  only this phase (sealed authoring is later).
- **Shell: compose.** A testable core `composeAndIngest({ program, type, args,
  attachments })` that calls `buildBundle` with `keyring.signer`, admits + stores
  the result locally, and returns the `.thing` bytes + outcome. A native-dialog
  IPC wrapper gathers the HTML (+ optional attachments), runs the core, then
  offers a **Save** dialog to write the `.thing`. Mirrors the existing
  ingest-core / IPC split so the core is unit-testable without native dialogs.
- **Chrome: a "Create…" affordance** — choose an HTML file, set a `type`,
  optionally add attachments, then Sign & save. A success toast names the saved
  path. Attachments guess MIME from extension; a self-contained HTML page needs
  none.
- **Chrome: the safety banner.** A persistent, dismissible notice that this is an
  experimental alpha and the identity key is stored **in software on this
  device** — surfaced from the keyring's actual at-rest mode (`os` vs
  `software`), so it tells the truth rather than a constant.

## Out of scope (later / next phase)

- **Packaging** (phase 8): electron-builder installers for macOS / Windows /
  Linux — the other half of "ship to testers." Separate PR.
- **Live P2P sharing** (fast-follow): wire webtorrent so a `.thing` shares by
  magnet link instead of only by file.
- **Sealed authoring** (private things): compose to recipients under `CK`. The
  read path already exists; the write path is deferred with the rest of sealing.
- **An in-app editor / templates**: this phase is pick-a-file; richer authoring
  is a later product decision.
- **Author encryption-key binding** (`Author.e`/`ek`): only needed so others can
  seal *to* you — deferred with sealed authoring.

## Test battery

- **format** (`test/format/`): `buildBundle` output re-admits as `valid` with the
  expected author, hashes at every level, and attachments; `packBundle` /
  `parseBundle` round-trip; a self-contained HTML program with no attachments
  works.
- **shell** (`test/shell/authoring.spec.ts`): `composeAndIngest` produces a
  `.thing` signed by the running identity, admits + appears in the feed, and its
  bytes re-admit `valid` in a *fresh* shell (the flyer round-trip). The safety
  banner reports the actual key-storage mode.
