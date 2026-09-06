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

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electron = require('electron') // the path to the binary, under plain node
const cli = join(root, 'tools', 'world', 'cli.ts')

const child = spawn(electron, ['--import', 'tsx', cli, ...process.argv.slice(2)], {
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
