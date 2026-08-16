# src/shell — the trusted client

The shell is the first component that inverts the cage's "nothing to steal"
posture: it holds the keyring, parses hostile bundles, and mounts admitted
things into cages. It is the trusted process with the crown jewels; its threat
model is "handle hostile input without being compromised, and never leak the
keys."

Everything is in this repo for now (the cage, format, and shell together) for
ease of testing; extraction into packages is a later `git mv`. The **dependency
rule is CI-enforced** (`test/unit/boundary.test.ts`): the cage
(`src/main`, `src/preload`) imports nothing from `src/shell` or `src/format`.
The shell is the only place that knows about all three.

## Internal boundaries

```
src/shell/
├── admission/   hostile-bundle handling. Structural decode (tar + CBOR under
│                caps, canonical validation) runs in an ISOLATED utilityProcess
│                (worker.ts) that holds no keys; signature verify + unseal run in
│                this process on the already-bounded output (index.ts).
├── keyring/     the ONLY code that touches private key bytes. Exposes Signer +
│                Unsealer interfaces; format/cage never receive key material.
│                Software key custody for now (LATER: OS-backed + hardware).
├── library/     SQLite index + content-addressed blob store. One row per
│                admitted envelope; RECEIVED-AT ordering (the reader owns order);
│                fork detection on same (author, path, seq) / different hash.
├── mount/       admitted thing → CageResources → createCage → bridge args →
│                view placed beneath the chrome. Reuses the cage library.
├── transport/   fetch bundle bytes by locator (file: / content-addressed
│                bundle: / magnet:), resource-bounded + content-untrusted —
│                admission is the gate. webtorrent wired behind the interface
│                (lazy import); admitted bundles are retained in a seed store.
├── naming/      name → author key (identity) + name → locator (discovery). A
│                name is shown as VERIFIED only when it provably maps to the
│                thing's signature-proven author key. ENS via an injected
│                EnsClient (viem for live, mock-tested); reverse+forward
│                confirmed. Direct locators pass through; Nostr stubbed.
├── chrome/      the trusted 3-pane renderer (omnibar, feed, per-thing trust
│                header, confirm dialogs). Vanilla TS + the evm-ui design
│                language (CSS tokens/classes, no framework). Every trust signal
│                lives in chrome pixels the thing cannot reach.
└── main.ts      bootstrap: window (chrome view + cage area), library, admission,
                 mount, ingestion, IPC, and the confirm flow.
```

## Trust integrity

The chrome renderer draws the feed, the per-thing header (author, signature
status, content hash), and every human-confirmation dialog. The thing renders
into a **separate native view** composited into the main-content area only, so
it cannot forge or overpaint the trust chrome. This is proven at the pixel level
(`test/shell/chrome.spec.ts`, the N6 test): a thing that floods its viewport and
paints a fake "✓ signed" badge leaves the chrome layer's real badge intact and
its own colour entirely absent from the chrome capture.

A thing's `emit("draft", …)` streams its working state: it grants nothing.
The shell renders it as the live preview, and the chrome **Publish** button
signs exactly the latest draft — after the human confirms in chrome, never
auto-granted. Programs cannot initiate a publish (`emit("publish")` is
retired); all controls live in trusted chrome.

## Ingestion & authoring

**Receive:** file / paste / drag / double-click a `.thing` / locator / name →
admission → library — the "flyer" property, transport-agnostic and
verify-at-the-gate. Double-clicking is just another transport: the bundle
still passes the same gate, and a second launch hands the file to the running
shell (single-instance lock) rather than opening a rival library.

**Author (New):** pick a known type — a built-in starter or any program
already in your library — and the shell starts a local, UNSIGNED draft that
autosaves as you edit and is consumed when you publish it. Drafts live in their
own feed section, never leave the machine, and their header says DRAFT, never
"signed". **New from HTML…** is the raw path: pick a self-contained HTML page (+ optional attachments) →
`format.buildBundle` signs it with the keyring `Signer` → a shareable `.thing`
saved via a native dialog, and admitted + seeded locally like any other thing (so
you see your own creation, and it is re-servable by `bundle:<hash>`). Authoring is
the mirror of admission and lives in `format`; the shell only supplies the
`Signer`. Public things only for now — sealed authoring is deferred with the rest
of sealing. Sharing this phase is **file handoff**; live P2P is the fast-follow.

## Notes

- **Keys are software-only** for now (safeStorage if present, else static-key
  XChaCha — never the plaintext key on disk). The chrome now carries an explicit
  **safety warning** reflecting the *actual* at-rest mode (`os` vs `software`): a
  first-run modal + a persistent topbar badge. Proper OS-backed storage as the
  default (and a hardware-wallet `Signer`) are still LATER.
- **`better-sqlite3` is native** and must be built against Electron's ABI, not
  Node's — `pnpm rebuild:native` (run automatically by `postinstall`). Because
  of this, the library is tested through Electron (Playwright), not vitest.
- **Sealed content** (format §7.1) is fully decrypted: the library stores a
  sealed thing's plaintext program/manifest/attachments in an **ephemeral
  in-memory store** (never the on-disk CAS), and mounts serve from it. A sealed
  thing not decrypted this session (e.g. after a restart) is unmountable until
  re-ingested — decrypted plaintext never touches disk.
