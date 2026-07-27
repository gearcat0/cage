# Build brief — packaging: installers for testers (phase 8)

## Why

Phase 7 gave a tester something to *do* (author → sign → share a `.thing`); this
phase gives them something to *install*. The concept can only be tested by people
who are not running `pnpm dev`, so the deliverable is a double-clickable installer
for **macOS, Windows, and Linux**. This is the last thing between the working
end-to-end loop and real hands on it.

## The principle

**The packaged app is the shell, and packaging must not lie about that.** The
repo built two Electron entries — the phase-1 cage harness (`out/main/index.js`)
and the shell (`out/main/shell/main.js`). An installer that launched the harness
would ship a demo, not the product. So `package.json` `main` now points at the
shell; every launch path — `pnpm dev`, `pnpm start`, `electron .`, and the
installer — agrees, and the harness moves to an explicit `pnpm dev:cage`.

**No source mutation during a build.** electron-builder's `extraMetadata.main`
would let `main` stay the harness and be overridden only in the package — but
with the app dir at the repo root it rewrites the real `package.json` in place
(stripping scripts/devDeps) and does not reliably restore it. Making `main`
correct at the source sidesteps that entirely. A build must never leave the tree
dirty.

**Testers carry no toolchain.** `better-sqlite3` is native; each platform's
installer must contain a copy built against *that* platform's Electron ABI. That
is a packaging-time responsibility (`npmRebuild` + asar-unpack), never something
we ask a tester to do.

## Scope

- **`electron-builder.yml`** — appId, the shell as the packaged entry (via
  `main`, not `extraMetadata`), asar with `better-sqlite3` unpacked and rebuilt
  for the target ABI, and per-platform targets: macOS `dmg`+`zip`, Windows
  `nsis`, Linux `AppImage`+`deb`. Unsigned (alpha).
- **`scripts/make-icon.mjs` + `build/icon.png`** — a placeholder icon generated
  with a tiny hand-rolled PNG encoder (no image tooling in the toolchain);
  `pnpm gen:icon` regenerates it. Replace with real artwork before a public
  release.
- **`package.json`** — `dist` / `dist:{linux,mac,win}` / `pack:dir` scripts, the
  `main`→shell change, `dev:cage` for the harness, and the `electron-builder`
  dev dependency.
- **`.github/workflows/release.yml`** — a matrix (macOS / Windows / Linux
  runners) that, on a `v*` tag, builds each platform on its own OS (a `.dmg`
  cannot be built off a Mac) and drafts a GitHub Release with the artifacts.
- **README** — a Packaging section (dist scripts, the cross-platform/CI reality,
  the unsigned-first-launch steps, how to add signing later) and the corrected
  run commands (`dev` now launches the shell; `dev:cage` the harness).

## Out of scope (later)

- **Code signing + notarization** — needs an Apple Developer ID and a Windows
  cert; the workflow reads them from the environment when present, so enabling it
  is "add secrets," not "rewrite packaging."
- **Auto-update** — the `zip`/`latest.yml` artifacts are update-friendly, but no
  update server/feed is wired. Testers re-download for now.
- **Live P2P sharing** — still the file-handoff model; magnet sharing is the
  post-packaging fast-follow.
- **Real branding** — icon, product name, and appId are placeholders.

## Verification

Fully verifiable for Linux in-repo; macOS/Windows rely on their CI runners.

- `pnpm pack:dir` produces an unpacked app whose asar `main` is the shell, with
  `scripts`/`devDependencies` stripped, `out/**` present, and no `src/`/`test/`
  leakage — and leaves the source `package.json` **unchanged** (no clobber).
- The packaged Linux binary **boots to ready** and opens its SQLite index
  (`better-sqlite3` loading from `asar.unpacked` in the real layout).
- `pnpm install --frozen-lockfile`, typecheck, 174 unit + 82 Playwright all green
  after the `main` change.
