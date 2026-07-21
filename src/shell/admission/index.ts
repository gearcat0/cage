import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import {
  admitBundle,
  DEFAULT_BUNDLE_LIMITS,
  type AdmissionResult,
  type BundleLimits,
  type BundleSource,
  type Unsealer
} from '@yourproject/format'

// ── Admission service — the trusted orchestrator (brief §1.1, §1.5) ──────────
//
// Runs the parser-attack-surface work in an isolated, disposable utilityProcess
// (see worker.ts), then — on the ALREADY structurally-validated, size-bounded
// output — runs signature verification (public keys, safe) and unsealing (needs
// the recipient private key, so it must be here where the key is). Crypto never
// runs on unbounded or unvalidated input.
//
// The worker is forked per bundle and killed after: a fresh, clean state for
// each hostile input, and no accumulated worker state to corrupt. If the worker
// dies or hangs mid-admission, the bundle is rejected and the shell carries on.

const WORKER = join(__dirname, 'admission-worker.js')

/** How long a single structural decode may take before we kill the worker. A
 *  decoder that hangs (infinite loop) must not wedge admission. Overridable so
 *  the isolation test's hang case need not wait the full production timeout. */
const WORKER_TIMEOUT_MS = (() => {
  const raw = process.env.SHELL_WORKER_TIMEOUT_MS
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 15_000
})()

interface WorkerOk {
  id: number
  ok: true
  source: {
    envelope: Uint8Array
    manifest?: Uint8Array
    program?: Uint8Array
    blobs: [string, Uint8Array][]
  }
  sealed: boolean
}
interface WorkerErr {
  id: number
  ok: false
  reason: string
}
type WorkerResponse = WorkerOk | WorkerErr

export interface AdmissionServiceOptions {
  limits?: BundleLimits
  /** Path override for the worker script (tests). */
  workerPath?: string
}

export class AdmissionService {
  private readonly limits: BundleLimits
  private readonly workerPath: string
  private nextId = 1

  constructor(opts: AdmissionServiceOptions = {}) {
    this.limits = opts.limits ?? DEFAULT_BUNDLE_LIMITS
    this.workerPath = opts.workerPath ?? WORKER
  }

  /**
   * Structurally decode `raw` in the isolated worker, then verify/unseal in
   * this process. Returns one of the four §1.5 outcomes. Never throws for a
   * malformed or hostile bundle — a structural failure is `invalid`, a dead
   * worker is `invalid` (with an isolation note), a sealed-not-for-us is
   * `not-for-me`.
   */
  async admit(raw: Uint8Array, unsealer?: Unsealer): Promise<AdmissionResult> {
    let structural: WorkerResponse
    try {
      structural = await this.runWorker(raw)
    } catch (e) {
      // Worker crashed, OOM'd, or timed out — reject and carry on. The keyring
      // process (this one) is untouched.
      return { status: 'invalid', reason: `structural decode failed in isolation: ${(e as Error).message}` }
    }

    if (!structural.ok) {
      return { status: 'invalid', reason: structural.reason }
    }

    // Reassemble the bounded BundleSource and run the crypto half here.
    const source: BundleSource = {
      envelope: structural.source.envelope,
      blobs: new Map(structural.source.blobs)
    }
    if (structural.source.manifest) source.manifest = structural.source.manifest
    if (structural.source.program) source.program = structural.source.program

    try {
      const opts = unsealer ? { limits: this.limits, unsealer } : { limits: this.limits }
      return admitBundle(source, opts)
    } catch (e) {
      // admitBundle is written to return outcomes, not throw; treat any escape
      // as a rejection rather than crashing the shell.
      return { status: 'invalid', reason: `admission error: ${(e as Error).message}` }
    }
  }

  private runWorker(raw: Uint8Array): Promise<WorkerResponse> {
    const id = this.nextId++
    return new Promise<WorkerResponse>((resolve, reject) => {
      let child: UtilityProcess
      try {
        child = utilityProcess.fork(this.workerPath, [], {
          serviceName: 'admission-worker',
          env: process.env as Record<string, string>
        })
      } catch (e) {
        reject(e as Error)
        return
      }
      let settled = false
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        fn()
      }
      const timer = setTimeout(() => {
        done(() => reject(new Error('worker timed out')))
      }, WORKER_TIMEOUT_MS)

      child.on('message', (msg: WorkerResponse) => {
        if (msg && msg.id === id) done(() => resolve(msg))
      })
      child.on('exit', (code) => {
        done(() => reject(new Error(`worker exited (code ${code}) before responding`)))
      })
      // `spawn` fires when the child is ready to receive messages.
      child.on('spawn', () => {
        child.postMessage({ id, raw, limits: this.limits })
      })
    })
  }
}
