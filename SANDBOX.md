# The OS sandbox (Layer 1) — status, honesty, and how to actually exercise it

This note is about **Layer 1 only**: the OS-level Chromium process sandbox
(`sandbox: true` on the cage's `WebContentsView`). It is the one hardening layer
that depends on the host and the launcher, so it needs its own explanation and
its own honesty machinery.

## Layer 1 is a backstop, not a load-bearing guarantee

The cage's behavioral guarantees — no network, no storage bleed, no ambient
authority — are enforced by **Layers 2–4** (request cancellation, the dead
proxy + WebRTC policy, and CSP) plus `contextIsolation`, `nodeIntegration: false`,
and per-thing non-persistent session partitions. **None of those depend on the
OS sandbox.** Layer 1 is the extra backstop against a renderer
*memory-corruption* exploit — valuable defense-in-depth, but its being off does
**not** weaken any property the escape suite asserts. See
`src/main/index.ts` (the `Two ways it ends up OFF` comment, ~line 80).

## Why it currently runs OFF

There are **two independent reasons**, and fixing one does not fix the other:

1. **The host cannot initialize it.** In a locked-down container (unprivileged
   user namespaces disabled by AppArmor, and the setuid `chrome-sandbox` helper
   not root-owned), Electron cannot self-initialize the sandbox and aborts on
   launch. The `dev:nosandbox` script and `ELECTRON_DISABLE_SANDBOX=1` exist to
   work around exactly this — read by the Electron binary before JS runs.
2. **The harness deliberately launches with it off.** Playwright's
   `_electron.launch` injects `--no-sandbox` **by default**, and `test/helpers.ts`
   (~line 189) does not override it. So even on a host that *can* initialize the
   sandbox, `pnpm test:cage` runs with Layer 1 **off** until we pass
   `chromiumSandbox: true` (there is a note to this effect right above that
   launch call).

> Upgrading the OS fixes **only reason 1**. The banner will still read
> `OS SANDBOX: OFF` until the harness change below is made.

## The honesty machinery (finding P0-1)

Because Layer 1 can be silently off while every test still passes, the suite
refuses to let a green wall *imply* it was exercised:

- **Ground truth is recorded at startup.** `src/main/index.ts` (~line 303) emits
  a `sandbox-state` event with `envDisabled` (`ELECTRON_DISABLE_SANDBOX` present)
  and `argvNoSandbox` (`--no-sandbox` in argv or command line).
- **The env escape-hatch is scrubbed.** `test/helpers.ts` (~line 155) deletes
  `ELECTRON_DISABLE_SANDBOX` from the child env, so the suite can never run with
  Layer 1 off *via the env var* and still look clean. The
  `harness integrity` test in `test/cage.spec.ts` asserts `envDisabled === false`.
- **`--no-sandbox` requires an explicit acknowledgement.** When `argvNoSandbox`
  is true (the Playwright default), the integrity test **fails** unless
  `CAGE_ALLOW_NO_SANDBOX=1` is set. The cross-platform launcher
  (`scripts/run-cage-tests.mjs`) sets it, so `pnpm test:cage` is a deliberate,
  acknowledged "OS sandbox off" run — not an accident.
- **The banner states the real status.** `test/green-wall-reporter.ts` (~line 45)
  prints one of:
  - `(OS SANDBOX: ON)` — Layer 1 genuinely exercised;
  - `(OS SANDBOX: OFF — Layer 1 not exercised; --no-sandbox)` — the current state;
  - `(OS SANDBOX: UNKNOWN — integrity check did not run)`.

## Turning Layer 1 ON (after the Ubuntu upgrade)

### Step 1 — confirm the host can initialize the sandbox

On the upgraded machine:

```bash
# Unprivileged user namespaces must work:
unshare --user --map-root-user true && echo "userns OK"

# The setuid helper must be root-owned, mode 4755:
ls -l node_modules/electron/dist/chrome-sandbox
```

A fresh `pnpm install` extracts `chrome-sandbox` without the setuid bit (an
unprivileged extract cannot set it), so it usually needs a one-time fix:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

If user namespaces are restricted by AppArmor, either enable them once
(`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`) or use the
root-owned-helper route above. (These are the same remediations in the README's
"Linux sandbox note".)

### Step 2 — the harness change (deliberately not yet made)

Make it **opt-in**, e.g. a `CAGE_OS_SANDBOX=1` env var that:

- passes `chromiumSandbox: true` to `_electron.launch` in `test/helpers.ts`
  (which stops Playwright from injecting `--no-sandbox`).

That single change auto-satisfies the honesty machinery: with `--no-sandbox`
gone, `argvNoSandbox` becomes `false`, the integrity test's acknowledgement
branch is skipped, and the reporter prints `(OS SANDBOX: ON)` on its own — no
other edits needed. The launcher need not set `CAGE_ALLOW_NO_SANDBOX` in this
mode (harmless if it does; the gate is simply not reached).

### Why opt-in, not unconditional

The `test` CI workflow runs the escape suite on three runners, and **none can
run a real OS sandbox unconditionally**:

- **Headless Linux CI** — the GitHub runner would need the same userns /
  `chrome-sandbox` setup; not guaranteed.
- **macOS / Windows runners** — Playwright's default `--no-sandbox` and the
  platform sandboxing differ; the current acknowledged-off path is what keeps
  those legs green.

So flipping Layer 1 on unconditionally would break CI. The opt-in gives us a
genuine `OS SANDBOX: ON` green wall on a properly configured host (a dev machine
or a dedicated Linux CI job) while the portable, acknowledged-off run stays the
default everywhere else.

## TL;DR

| | Fixes host init (reason 1) | Exercises Layer 1 |
|---|---|---|
| Upgrade Ubuntu / enable userns / root-own `chrome-sandbox` | ✅ | ❌ (still `--no-sandbox`) |
| `CAGE_OS_SANDBOX=1` → `chromiumSandbox: true` in the harness | — | ✅ (needs a ready host) |

Both are required to see `(OS SANDBOX: ON)`. The upgrade is step 1; ping to have
the opt-in harness knob wired once `unshare … true` succeeds on the new box.
