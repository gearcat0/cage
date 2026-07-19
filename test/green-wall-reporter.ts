import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter'
import { readSandboxState } from './sandbox-state-file.js'

// A tiny reporter that prints the "green wall": one line per attack plus a final
// verdict banner. Runs alongside the built-in 'list' reporter. This output is
// the artifact you show people — every line green means the cage held.

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

interface Row {
  title: string
  ok: boolean
  ms: number
}

export default class GreenWallReporter implements Reporter {
  private rows: Row[] = []

  onTestEnd(test: TestCase, result: TestResult): void {
    // titlePath: [ '', file, describe, test ] — join the describe + test.
    const path = test.titlePath().filter(Boolean).slice(1)
    const title = path.slice(1).join(' › ') || test.title
    this.rows.push({ title, ok: result.status === 'passed', ms: result.duration })
  }

  onEnd(result: FullResult): void {
    const blocked = this.rows.filter((r) => r.ok).length
    const total = this.rows.length
    const line = '─'.repeat(64)

    process.stdout.write(`\n${BOLD}THE CAGE — escape-attempt wall${RESET}\n${line}\n`)
    for (const r of this.rows) {
      const mark = r.ok ? `${GREEN}[✔ blocked]${RESET}` : `${RED}[x ESCAPED]${RESET}`
      process.stdout.write(`${mark} ${r.title} ${DIM}(${Math.round(r.ms)}ms)${RESET}\n`)
    }
    process.stdout.write(`${line}\n`)

    // OS-sandbox honesty (P0-1): the banner must state Layer 1's actual status,
    // never let a green wall imply the OS sandbox was exercised when it was off.
    const sb = readSandboxState()
    let sandboxNote = ''
    if (!sb) {
      sandboxNote = ` ${DIM}(OS SANDBOX: UNKNOWN — integrity check did not run)${RESET}`
    } else if (sb.argvNoSandbox || sb.envDisabled) {
      const why = sb.argvNoSandbox ? '--no-sandbox' : 'ELECTRON_DISABLE_SANDBOX'
      sandboxNote = ` ${BOLD}${RED}(OS SANDBOX: OFF — Layer 1 not exercised; ${why})${RESET}`
    } else {
      sandboxNote = ` ${GREEN}(OS SANDBOX: ON)${RESET}`
    }

    if (result.status === 'passed') {
      process.stdout.write(
        `${BOLD}${GREEN}CAGE HOLDS${RESET}  ${blocked}/${total} attempts blocked, ` +
          `positive test passed.${sandboxNote}\n\n`
      )
    } else {
      process.stdout.write(
        `${BOLD}${RED}BREACH${RESET}  ${total - blocked}/${total} checks failed — see failures above.${sandboxNote}\n\n`
      )
    }
  }
}
