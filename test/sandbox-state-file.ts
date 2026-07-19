import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Shared channel between the harness-integrity test (which measures the OS
// sandbox state from a real Electron launch) and the green-wall reporter (which
// prints it). A file, because the test worker and the reporter can be separate
// processes. See finding P0-1: the banner must never imply Layer 1 was
// exercised when the OS sandbox was off.

export interface SandboxState {
  envDisabled: boolean
  argvNoSandbox: boolean
}

const FILE = join(__dirname, '..', 'test-results', 'sandbox-state.json')

export function writeSandboxState(s: SandboxState): void {
  mkdirSync(join(__dirname, '..', 'test-results'), { recursive: true })
  writeFileSync(FILE, JSON.stringify(s))
}

export function readSandboxState(): SandboxState | null {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as SandboxState
  } catch {
    return null
  }
}
