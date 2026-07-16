// Test-observable event log.
//
// Everything the cage blocks or forwards is recorded here, in the MAIN process,
// OUTSIDE the untrusted renderer. The escape-attempt suite reads this via
// Playwright's `electronApp.evaluate(() => globalThis.__cage.events)`, so egress
// and escalation are verified from outside the sandbox — not by trusting the
// page's own error callbacks. See test/cage.spec.ts.

export type CageEvent =
  | { type: 'blocked-request'; url: string; resourceType?: string }
  | { type: 'navigation-blocked'; url: string; kind: 'navigate' | 'redirect' }
  | { type: 'window-open-denied'; url: string }
  | { type: 'permission-denied'; permission: string; via: 'request' | 'check' }
  | { type: 'emit'; channel: string; data: unknown; bytes: number }
  | { type: 'emit-rejected'; reason: string }

export interface CageGlobals {
  events: CageEvent[]
  /** Geometry of the two native views, so the chrome-spoofing test can assert
   *  the thing's pixels never leave the cage rectangle. Set by main/index.ts. */
  bounds: {
    chrome: Electron.Rectangle | null
    cage: Electron.Rectangle | null
    window: Electron.Rectangle | null
  }
}

const g = globalThis as unknown as { __cage?: CageGlobals }

export const cage: CageGlobals =
  g.__cage ?? (g.__cage = { events: [], bounds: { chrome: null, cage: null, window: null } })

export function record(event: CageEvent): void {
  cage.events.push(event)
  // Mirror to stderr so a human watching `pnpm dev` can see the wall doing its job.
  // eslint-disable-next-line no-console
  console.error(`[cage] ${event.type}: ${JSON.stringify(event).slice(0, 200)}`)
}
