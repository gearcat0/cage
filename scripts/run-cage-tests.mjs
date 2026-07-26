// Cross-platform launcher for the Playwright escape suite (`pnpm test:cage`).
//
// It exists to fix two portability bugs in what used to be a single npm-script
// line (`CAGE_ALLOW_NO_SANDBOX=1 xvfb-run -a playwright test`):
//
//   1. `VAR=value cmd` is POSIX-only — Windows `cmd` rejects it (issue #12).
//      Here the variable is set on the CHILD's environment from Node, portably.
//   2. `xvfb-run` is Linux-only, and even there only needed when HEADLESS
//      (issue #11). macOS/Windows and any desktop with a display server run the
//      suite directly; only headless Linux (CI, containers) is wrapped in a
//      virtual X server, and only when `xvfb-run` is actually installed.
//
// Playwright is invoked as its CLI *.js under the current `node` — no reliance
// on PATH or a .bin shim, so there are no Windows `.cmd`/spawn pitfalls. Any
// extra args are forwarded (e.g. `pnpm test:cage -- test/shell/naming.spec.ts`).

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')
const passthrough = process.argv.slice(2)

// CAGE_ALLOW_NO_SANDBOX acknowledges that Playwright launches Electron with
// `--no-sandbox` (Layer 1 off) on EVERY platform — the suite requires it (see
// test/cage.spec.ts). We set it here rather than in a shell prefix so it works
// identically on Windows, macOS, and Linux.
const env = { ...process.env, CAGE_ALLOW_NO_SANDBOX: '1' }

const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const xvfbAvailable = () =>
  process.platform === 'linux' && !spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error

let command
let args
if (process.platform === 'linux' && !hasDisplay && xvfbAvailable()) {
  // Headless Linux: provide a throwaway virtual X server. `-a` auto-picks a free
  // display number so parallel/repeat runs do not collide.
  command = 'xvfb-run'
  args = ['-a', process.execPath, playwrightCli, 'test', ...passthrough]
} else {
  command = process.execPath
  args = [playwrightCli, 'test', ...passthrough]
}

if (process.platform === 'linux' && !hasDisplay && !xvfbAvailable()) {
  console.error(
    '[test:cage] Headless Linux with no display and `xvfb-run` not found.\n' +
      '            Install it (Debian/Ubuntu: `sudo apt-get install -y xvfb`) or run under a display.'
  )
  process.exit(1)
}

const child = spawn(command, args, { stdio: 'inherit', env })
child.on('error', (err) => {
  console.error(`[test:cage] failed to launch: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
