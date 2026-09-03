// Test-observable event log.
//
// Everything the cage blocks or forwards is recorded here, in the MAIN process,
// OUTSIDE the untrusted renderer. The escape-attempt suite reads this via
// Playwright's `electronApp.evaluate(() => globalThis.__cage.events)`, so egress
// and escalation are verified from outside the sandbox — not by trusting the
// page's own error callbacks. See test/cage.spec.ts.
//
// `record()` survives into the real shell (it is called from the request
// canceller and the emit handler, both reachable in a loop by a thing), so it
// must be bounded. The log is a ring buffer; emit records store size + a short
// hash, NEVER the payload, so a flood of ≤256 KB messages cannot grow
// main-process memory without bound (finding P0-3).

export type CageEvent =
  | { type: 'blocked-request'; url: string; resourceType?: string }
  | { type: 'navigation-blocked'; url: string; kind: 'navigate' | 'redirect' }
  | { type: 'window-open-denied'; url: string }
  | { type: 'permission-denied'; permission: string; via: 'request' | 'check' }
  // NOTE: no `data` field. The payload is deliberately not retained here (see
  // P0-3). Tests that need to assert on payloads read `testEmits` instead.
  | { type: 'emit'; channel: string; bytes: number; hash: string }
  | { type: 'emit-rejected'; reason: string }
  | { type: 'att-request'; name: string; status: number; range: string | null }
  | {
      type: 'draft-recorded'
      draftType: string
      att: Record<string, { h: string; m: string; n: number }>
      argsBytes: number
      blobBytes: number
    }
  | { type: 'sandbox-state'; envDisabled: boolean; argvNoSandbox: boolean }
  // A cage's renderer died (crash, OOM kill, GPU reset). Recorded so a blank
  // pane or a frozen preview is diagnosable instead of mysterious.
  | { type: 'cage-gone'; role: 'view' | 'edit' | 'preview'; reason: string; exitCode: number }
  // A preview mount failed. Same motivation as cage-gone: the preview then
  // never appears AND is not retried (the pending draft was already consumed),
  // so without this the symptom is a preview that silently never arrives.
  | { type: 'preview-failed'; reason: string }

/** TEST-ONLY payload capture. A separate buffer that DOES retain emit payloads
 *  so the Playwright suite can assert on them. Populated only when
 *  `CAGE_TEST_CAPTURE=1` (the harness sets it); inert in a production shell.
 *  Bounded in both entry count and per-entry bytes so it cannot become the
 *  memory sink the main log was fixed not to be. */
export interface EmitCapture {
  channel: string
  data: unknown
}

export interface CageGlobals {
  /** Bounded ring buffer of the most recent events (oldest evicted). */
  events: CageEvent[]
  /** How many events have been evicted from `events` — lets a test tell
   *  truncation from absence. */
  dropped: number
  /** See EmitCapture. Test-only; gated on CAGE_TEST_CAPTURE. */
  testEmits: EmitCapture[]
  /** Publish drafts accepted from things (validated, attachment table built).
   *  In-memory only for phase 2. LATER: real drafts area + review/sign UI. */
  drafts: unknown[]
  /** Geometry of the two native views, so the chrome-spoofing test can assert
   *  the thing's pixels never leave the cage rectangle. Set by main/index.ts. */
  bounds: {
    chrome: Electron.Rectangle | null
    cage: Electron.Rectangle | null
    window: Electron.Rectangle | null
  }
}

/** Keep the last N events. 2000 is far more than any single test produces, so a
 *  legitimate run never drops; a flood truncates rather than growing. */
const MAX_EVENTS = 2000
/** Cap stderr mirroring so a flood cannot turn into thousands of writes. */
const MIRROR_CAP = 500
/** Test-capture bounds (see EmitCapture). */
const MAX_TEST_EMITS = 4096
const TEST_EMIT_MAX_BYTES = 64 * 1024

const g = globalThis as unknown as { __cage?: CageGlobals }

export const cage: CageGlobals =
  g.__cage ??
  (g.__cage = {
    events: [],
    dropped: 0,
    testEmits: [],
    drafts: [],
    bounds: { chrome: null, cage: null, window: null }
  })

let mirrored = 0

function mirror(event: CageEvent): void {
  // Quiet under test (the suite reads the log via evaluate, not stderr) and
  // hard-capped everywhere else so a flood cannot spew unbounded stderr.
  if (process.env.CAGE_QUIET === '1') return
  if (mirrored > MIRROR_CAP) return
  if (mirrored === MIRROR_CAP) {
    mirrored++
    // eslint-disable-next-line no-console
    console.error('[cage] …event mirror capped; further events suppressed this run')
    return
  }
  mirrored++
  // eslint-disable-next-line no-console
  console.error(`[cage] ${event.type}: ${JSON.stringify(event).slice(0, 200)}`)
}

export function record(event: CageEvent): void {
  const events = cage.events
  events.push(event)
  if (events.length > MAX_EVENTS) {
    const overflow = events.length - MAX_EVENTS
    events.splice(0, overflow)
    cage.dropped += overflow
  }
  mirror(event)
}

/** Test-only: retain an emit payload so the suite can assert on it. No-op
 *  unless CAGE_TEST_CAPTURE=1. Bounded in count and per-entry bytes. */
export function recordTestEmit(channel: string, data: unknown, bytes: number): void {
  if (process.env.CAGE_TEST_CAPTURE !== '1') return
  const stored = bytes <= TEST_EMIT_MAX_BYTES ? data : '[payload too large to capture]'
  const t = cage.testEmits
  t.push({ channel, data: stored })
  if (t.length > MAX_TEST_EMITS) t.splice(0, t.length - MAX_TEST_EMITS)
}
