import { test as base, _electron, type ElectronApplication } from '@playwright/test'
import { join } from 'node:path'
import { startCanary, type Canary } from './canary.js'

// Mirror of the main-process CageEvent union (see src/main/events.ts). Redefined
// locally so the test bundle never imports main/electron code.
export type CageEvent =
  | { type: 'blocked-request'; url: string; resourceType?: string }
  | { type: 'navigation-blocked'; url: string; kind: 'navigate' | 'redirect' }
  | { type: 'window-open-denied'; url: string }
  | { type: 'permission-denied'; permission: string; via: 'request' | 'check' }
  | { type: 'emit'; channel: string; data: unknown; bytes: number }
  | { type: 'emit-rejected'; reason: string }

export interface Bounds {
  chrome: { x: number; y: number; width: number; height: number } | null
  cage: { x: number; y: number; width: number; height: number } | null
  window: { x: number; y: number; width: number; height: number } | null
}

const THINGS_DIR = join(__dirname, 'things')
const MAIN = join(__dirname, '..', 'out', 'main', 'index.js')

export function thingPath(name: string): string {
  return join(THINGS_DIR, name)
}

export interface CageHandle {
  app: ElectronApplication
  /** Snapshot of the main-process event log, read from OUTSIDE the renderer. */
  events(): Promise<CageEvent[]>
  /** Resolve with the data of the first emit seen on `channel`. */
  waitForEmit(channel: string, timeoutMs?: number): Promise<unknown>
  /** All emit payloads seen on `channel` so far. */
  emitsOn(channel: string): Promise<unknown[]>
  bounds(): Promise<Bounds>
  close(): Promise<void>
}

export interface LaunchOptions {
  /** Filename under test/things (becomes the primary cage's content). */
  thing: string
  /** Value returned by the primary thing's getArgs(). Canary is merged in. */
  args?: Record<string, unknown>
  /** Optional second cage in the same run (fresh partition) — storage tests. */
  thing2?: string
  args2?: Record<string, unknown>
  /** Provide a canary so the thing can try (and fail) to beacon to it. */
  canary?: Canary
}

async function readEvents(app: ElectronApplication): Promise<CageEvent[]> {
  return app.evaluate(async (electron) => {
    const cage = (electron.app as unknown as { __cage?: { events: unknown[] } }).__cage
    return (cage ? cage.events : []) as never
  })
}

export async function launch(opts: LaunchOptions): Promise<CageHandle> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  env.CAGE_THING = thingPath(opts.thing)
  env.CAGE_ARGS = JSON.stringify({ ...(opts.args ?? {}), canary: canaryArg(opts.canary) })
  if (opts.thing2) {
    env.CAGE_THING2 = thingPath(opts.thing2)
    env.CAGE_ARGS2 = JSON.stringify({ ...(opts.args2 ?? {}), canary: canaryArg(opts.canary) })
  }

  // No --no-sandbox: the cage runs with its real `sandbox: true` renderers.
  const app = await _electron.launch({ args: [MAIN], env })

  const handle: CageHandle = {
    app,
    events: () => readEvents(app),
    async waitForEmit(channel, timeoutMs = 10_000) {
      const deadline = performance.now() + timeoutMs
      for (;;) {
        const evs = await readEvents(app)
        const hit = evs.find((e) => e.type === 'emit' && e.channel === channel)
        if (hit && hit.type === 'emit') return hit.data
        if (performance.now() > deadline) {
          throw new Error(`timed out waiting for emit on "${channel}"; saw: ${JSON.stringify(evs)}`)
        }
        await sleep(100)
      }
    },
    async emitsOn(channel) {
      const evs = await readEvents(app)
      return evs.filter((e) => e.type === 'emit' && e.channel === channel).map((e) => (e as { data: unknown }).data)
    },
    bounds: () =>
      app.evaluate(async (electron) => {
        const cage = (electron.app as unknown as { __cage?: { bounds: unknown } }).__cage
        return (cage ? cage.bounds : { chrome: null, cage: null, window: null }) as never
      }),
    close: () => app.close()
  }
  return handle
}

function canaryArg(c: Canary | undefined): Record<string, string> | null {
  if (!c) return null
  return { http: c.http, ws: c.ws, stun: c.stun }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// `canary` starts/stops a fresh listener per test. `open` launches cages and
// guarantees every one is closed at test end, even on failure.
export const test = base.extend<{
  canary: Canary
  open: (opts: LaunchOptions) => Promise<CageHandle>
}>({
  canary: async ({}, use) => {
    const c = await startCanary()
    await use(c)
    await c.close()
  },
  open: async ({ canary }, use) => {
    const opened: CageHandle[] = []
    const openFn = async (opts: LaunchOptions): Promise<CageHandle> => {
      const h = await launch({ canary, ...opts })
      opened.push(h)
      return h
    }
    await use(openFn)
    for (const h of opened) await h.close().catch(() => {})
  }
})

export { expect } from '@playwright/test'
