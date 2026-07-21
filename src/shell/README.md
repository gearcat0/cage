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
├── transport/   stub: file/paste now, webtorrent later (magnet → not-yet).
├── naming/      stub: no resolver; direct-hash / direct-bundle ingestion works.
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

A thing's `emit("publish", …)` is a *request*: it grants nothing. The shell
surfaces it to chrome, where the human approves or rejects it — never
auto-granted.

## Ingestion

File / paste / drag only (this phase). Raw bundle bytes → admission → library —
the "flyer" property already working, transport-agnostic and verify-at-the-gate.

## Notes

- **Keys are software-only** for now (safeStorage if present, else static-key
  XChaCha — never the plaintext key on disk). Proper OS-backed storage + a UI
  warning are LATER.
- **`better-sqlite3` is native** and must be built against Electron's ABI, not
  Node's — `pnpm rebuild:native` (run automatically by `postinstall`). Because
  of this, the library is tested through Electron (Playwright), not vitest.
- **Sealed content** (format §7.1) is fully decrypted: the library stores a
  sealed thing's plaintext program/manifest/attachments in an **ephemeral
  in-memory store** (never the on-disk CAS), and mounts serve from it. A sealed
  thing not decrypted this session (e.g. after a restart) is unmountable until
  re-ingested — decrypted plaintext never touches disk.
