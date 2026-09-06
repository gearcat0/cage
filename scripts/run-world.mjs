// Launcher for the world harness (`pnpm world`).
//
// Two things have to be true for tools/world to run, and neither can be
// expressed portably in an npm script:
//
//   1. It must run under ELECTRON'S node, not the system one. better-sqlite3 is
//      built against Electron's ABI (see `pnpm rebuild:native`), so the shell's
//      library only loads there. ELECTRON_RUN_AS_NODE gives us that ABI with no
//      browser, no window, and no display — which is what makes 30 accounts in
//      one process cheap.
//   2. `VAR=value cmd` is POSIX-only and Windows `cmd` rejects it, so the
//      environment is set on the CHILD from Node — the same fix, for the same
//      reason, as scripts/run-cage-tests.mjs.
//
// tsx loads the TypeScript in src/ and tools/ directly; there is no build step
// for the harness, and it always reflects the working tree.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = require('electron') // the path to the binary, under plain node
const cli = join(root, 'tools', 'world', 'cli.ts')
const argv = process.argv.slice(2)

// Most commands touch only SQLite and need no display at all — that is the
// whole point of running under ELECTRON_RUN_AS_NODE. These three launch the
// real app, so on headless Linux they need a virtual X server. Same detection,
// for the same reason, as scripts/run-cage-tests.mjs.
const NEEDS_DISPLAY = new Set(['open', 'live', 'magnet'])
const wantsDisplay = NEEDS_DISPLAY.has(argv[0])
const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const xvfbAvailable = () =>
  process.platform === 'linux' && !spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error

let command = electron
let args = ['--import', 'tsx', cli, ...argv]
if (wantsDisplay && process.platform === 'linux' && !hasDisplay) {
  if (!xvfbAvailable()) {
    console.error(
      `[world] '${argv[0]}' launches the real app, but this is headless Linux with no ` +
        'display and `xvfb-run` was not found. Install it (Debian/Ubuntu: ' +
        '`sudo apt-get install -y xvfb`) or run under a display.'
    )
    process.exit(1)
  }
  // xvfb-run sets DISPLAY for everything below it, so the app Playwright
  // launches inherits it too.
  command = 'xvfb-run'
  args = ['-a', electron, ...args]
}

const child = spawn(command, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // 30 throwaway keys, written headless: never the OS keychain.
    SHELL_FORCE_SOFTWARE_KEYS: '1'
  }
})

child.on('error', (err) => {
  console.error(`[world] failed to launch: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
