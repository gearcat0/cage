// Launch/close an Electron app N times and count abnormal exits.
//
//   node tools/probe-exit.mjs out/main/shell/main.js 60         # close during boot
//   WAIT_READY=1 node tools/probe-exit.mjs <target> 60          # close after ready
//   FIXED_DIR=world/accounts/ada node tools/probe-exit.mjs ...  # reuse a profile
//
// On headless Linux, run it under `xvfb-run -a`.
//
// Written to chase a crash that fails no test: the shell segfaults on roughly a
// third of closes that land DURING boot, and 0 of 60 when the close waits for
// ready. CI reaches it through launchShell's retry, which closes a still-booting
// app; it shows up as ~4% of app exits per suite run, on Linux and Windows but
// not macOS.
//
// What is already ruled out, so nobody repeats it: it is OURS, not Electron's.
// A bare app (60/60 clean), one holding an open better-sqlite3 handle (60/60),
// one using BaseWindow + WebContentsView like the shell's chrome (60/60), and
// one with a deliberately slow boot closed into the pause (25/25) were all
// clean. It is not first-run initialisation — an already-provisioned profile
// crashes at the same rate. Our JS quit path never runs (no quitReason is
// recorded), so the fault is native and precedes it, and guards added to the
// boot continuation did not change the rate.
//
// Finding the faulting component needs a stack trace — a core dump (this
// machine had no disk headroom for one) or Electron's crashReporter. That is
// where anyone picking this up should start.

import { _electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TARGET = process.argv[2]
const N = Number.parseInt(process.argv[3] ?? '60', 10)
if (!TARGET) {
  console.error('usage: node tools/probe-exit.mjs <path-to-electron-main.js> [count]')
  process.exit(1)
}

let clean = 0
let abnormal = 0
const codes = {}

for (let i = 0; i < N; i++) {
  const dir = process.env.FIXED_DIR ?? mkdtempSync(join(tmpdir(), 'probe-'))
  const app = await _electron.launch({
    args: [TARGET],
    env: { ...process.env, SHELL_FORCE_SOFTWARE_KEYS: '1', SHELL_USER_DATA_DIR: dir, SHELL_NO_RELAUNCH: '1' }
  })
  const proc = app.process()
  const exited = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal })))

  if (process.env.WAIT_READY === '1') {
    const deadline = Date.now() + 20_000
    for (;;) {
      try {
        if (await app.evaluate(async (electron) => Boolean(electron.app.__shell?.ready))) break
      } catch {
        /* transient while the inspector context is rebuilt during startup */
      }
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 100))
    }
  } else {
    // Deliberately does NOT wait: closing mid-boot is the case being measured.
    try {
      await app.evaluate(async () => true)
    } catch {
      /* ignore */
    }
  }

  await app.close().catch(() => {})
  const { code, signal } = await exited
  if (signal || (code !== 0 && code !== null)) {
    abnormal++
    const k = String(signal ?? code)
    codes[k] = (codes[k] ?? 0) + 1
  } else {
    clean++
  }
  if (!process.env.FIXED_DIR) rmSync(dir, { recursive: true, force: true })
}

console.log(`${TARGET.split(/[\\/]/).pop()}: clean=${clean} abnormal=${abnormal}`, codes)
