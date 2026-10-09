# Building from source

Requirements: Node 22, [pnpm](https://pnpm.io), and a C++ toolchain (one native
module, `better-sqlite3`, is compiled at install).

```bash
git clone https://github.com/souspli/souspli.git
cd souspli
pnpm install
pnpm dev            # launch Souspli with hot reload
```

| Command | Does |
|---|---|
| `pnpm dev` | Launch the app with HMR (electron-vite dev server). |
| `pnpm build` | Compile main / preload / renderer into `out/`. |
| `pnpm start` | Launch the built app from `out/`. |
| `pnpm dev:cage` | Launch the bare container harness: one benign letter in a cage, no client. |
| `pnpm typecheck` | Both TypeScript projects. |
| `pnpm test:unit` | Fast pure-logic tests (Vitest). |
| `pnpm test:cage` | Build, then the full Playwright run: escape battery + client specs. |
| `pnpm world …` | The [30-account world](world.md). |
| `pnpm gen:vectors` | Regenerate [conformance vectors](../protocol/conformance.md). |
| `pnpm welcome:forum <file.thing>` | Bundle the welcome forum's roster (made by its keeper in the app) after checking it is a first-version public group. |
| `pnpm gen:welcome` | Regenerate the bundled welcome letter. Frozen: needs `FORCE=1`, and changes its hash. |
| `pnpm dist` | Installers for the current platform → `release/`. |

## Toolchain notes

- **Windows:** install the Visual Studio Build Tools (VC++ workload) *before*
  `pnpm install`:
  ```powershell
  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  ```
- **macOS:** Xcode Command Line Tools. **Linux:** `build-essential`, `python3`.
- Packaged installers ship the compiled module; end users need none of this.
- `better-sqlite3` must match Electron's ABI, not Node's. `postinstall` runs
  `pnpm rebuild:native`; run it by hand if you see a module-version error.
- The build emits CommonJS for the main and preload scripts on purpose (see
  `electron.vite.config.ts`).

## Linux: the OS sandbox on dev machines and CI

On a normal Linux desktop Chromium's sandbox initialises by itself. In a locked-down
container (unprivileged user namespaces disabled by AppArmor, setuid helper not
root-owned) Electron aborts on launch. Either enable it once:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
# or make the setuid helper root-owned:
# sudo chown root:root node_modules/electron/dist/chrome-sandbox
# sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

or, for a throwaway dev container, `pnpm dev:nosandbox`
(`ELECTRON_DISABLE_SANDBOX=1`, read by the binary before any JavaScript runs). That
turns the OS process sandbox **off** — a dev-only accommodation; every other layer
still applies. Headless: `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a pnpm start`.

What this does and does not affect is explained on the
[security page](../architecture/security.md).

## Packaging

`electron-builder` (`electron-builder.yml`) packages the app.

```bash
pnpm dist          # current platform → release/
pnpm dist:linux    # AppImage + deb
pnpm dist:mac      # dmg + zip   (must run on macOS)
pnpm dist:win      # nsis .exe   (best run on Windows)
pnpm pack:dir      # unpacked app, no installer — quick local check
```

Cross-platform builds happen in CI: pushing a `v*` tag runs
`.github/workflows/release.yml` on macOS, Windows and Linux runners and drafts a
GitHub Release with the installers attached.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`appId` (`org.souspli.app`) is the update and signing identity. Do not change it.

## Releasing, signing and updates

Installed copies update from GitHub Releases through `electron-updater`
(`src/shell/update/`), and only with the user's consent. `electron-builder.yml`'s
`publish` block makes each build write the feed: `latest.yml`, `latest-mac.yml`,
`latest-linux.yml` and `.blockmap` files. A copy sees a release only once it is
**published**, never while it is a draft, so publishing is the go button.

**macOS** is signed and notarized in CI. The workflow's `release` environment holds
the secrets and must require your approval:

| Secret | What |
|---|---|
| `MAC_CSC_LINK` | Developer ID Application certificate, `.p12`, base64 |
| `MAC_CSC_KEY_PASSWORD` | its password |
| `APPLE_API_KEY_P8` | App Store Connect API key, the `.p8` file's contents |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | that key's ID and issuer ID |

**Windows** is signed on your own machine. The Certum certificate lives in
SimplySign's cloud HSM behind the one-time code from the SimplySign phone app, so it
cannot sit in CI. Signing must happen inside `electron-builder`: `latest.yml` holds
the installer's sha512, and signing it afterwards would make every installed copy
reject the update.

One-time setup of the signing machine (a Windows VM is fine): Git, Node 22, pnpm 11,
Visual Studio Build Tools with *Desktop development with C++* (better-sqlite3
compiles during packaging), the GitHub CLI, and SimplySign Desktop. Use it for
nothing else. Set `win.signtoolOptions.publisherName` in `electron-builder.yml` to
the certificate's subject CN: installed copies accept an update only when it is signed
by that name.

### Cutting a release

1. Bump `version` in `package.json` (plain `x.y.z`: a prerelease tag like `-alpha.1`
   would switch those users onto prereleases), merge, then
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
2. Approve the `release` environment. CI signs and notarizes macOS (arm64 and x64;
   notarizing arm64 can take hours), builds Linux, and drafts a Release with the
   installers and feed files. Its Windows build is an unsigned check and is not
   attached.
3. On the signing machine, in a fresh clone at the tag after
   `pnpm install --frozen-lockfile`: log in to SimplySign Desktop, set
   `$env:SOUSPLI_WIN_CERT_SHA1` to the certificate's thumbprint, and run
   `pnpm dist:win:signed`. It refuses to build without a publisher name and
   thumbprint, verifies the signature and timestamp, and prints the
   `gh release upload` command for the installer, its blockmap and `latest.yml`.
4. Download the draft's installers and smoke-test them on each OS.
5. Publish. For a staged rollout, add `stagingPercentage: 10` (say) to the `latest*.yml`
   files first and raise it later.

To pull a bad release, unpublish it and ship a higher version. Installed copies
never downgrade.

### Certificate calendar

- **Certum** (Windows): one year. Renew about a month early and keep the same subject
  CN. If the CN has to change, first ship a release whose `publisherName` lists both
  names, or installed copies will reject the next update. Signatures are timestamped,
  so installers already out keep verifying after the certificate expires.
- **Apple Developer Program**: yearly membership. If it lapses, builds already
  notarized keep working, but new ones cannot be notarized.

## Environment variables

| Variable | Effect |
|---|---|
| `SHELL_USER_DATA_DIR` | Use this directory as the whole profile. |
| `SHELL_ALLOW_MULTI=1` | Skip the single-instance lock (several profiles at once). |
| `SHELL_SCALE` | Force the device scale factor (Linux defaults to 2). |
| `SHELL_FORCE_SOFTWARE_KEYS=1` | Ignore the OS keychain. |
| `SHELL_TORRENT_OFFLINE=1` | No DHT, trackers or local discovery. |
| `SHELL_SUGGESTED_RELAY` | The relay the app suggests (default `wss://relay.souspli.org`). Tests point it at an in-process relay; a fork points it at its own. |
| `SHELL_WELCOME_FORUM_B64` | Stand-in for the bundled welcome-forum letter (base64; empty = none). |
| `SHELL_NO_WELCOME=1` | Do not offer the first-run welcome letter (tests and scripted launches). |
| `SHELL_NO_UPDATE_PROMPT=1` | Do not ask about update checks on first launch; checks stay off (tests). |
| `SHELL_UPDATE_FEED` | Check this URL (an electron-updater generic feed) instead of GitHub Releases; also lets an unpackaged build check. |
| `SHELL_UPDATE_FIRST_CHECK_MS` | Delay before the first background check once checks are on (default 30 s). |
| `SHELL_ENS_RPC` | Ethereum RPC endpoint for ENS (requires `viem`, which is not a dependency). |

The `SHELL_` prefix is the code's name for the client; see the
[glossary](../../glossary.md).
