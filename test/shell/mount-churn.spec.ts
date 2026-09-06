import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Mount churn ──────────────────────────────────────────────────────────────
// A deliberate stress of the open → edit → view → open cycle, written to chase
// a Windows-only failure in poster.spec.ts:201 where the whole app goes away
// mid-test ("Target page, context or browser has been closed").
//
// That test mounts and tears down cages about ten times. This does it as many
// times as CHURN_ROUNDS asks for, so a leak or a teardown fault that needs
// dozens of cycles to show has room to appear. It also asserts the invariant
// the real test only relies on implicitly: the app is still alive, and the
// webContents count is not growing without bound.

const ROUNDS = Number.parseInt(process.env.CHURN_ROUNDS ?? '30', 10)

interface ModeState {
  activeMode: 'view' | 'edit'
  viewWcId: number | null
  editWcId: number | null
  previewWcId: number | null
}

let shell: ShellHandle
test.beforeEach(async () => {
  shell = await launchShell()
})
test.afterEach(async () => {
  await shell?.close()
})

const modeState = (): Promise<ModeState> =>
  shell.app.evaluate(
    async (electron) =>
      (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState() as never
  )

/** How many webContents the process is holding, and whether it is still there. */
const liveContents = (): Promise<number> =>
  shell.app.evaluate(async (electron) => electron.webContents.getAllWebContents().length)

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value: T | undefined
  for (;;) {
    value = await fn()
    if (pred(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

test('the app survives repeated mount/unmount cycles', async () => {
  test.setTimeout(15 * 60_000)
  const types = await shell.knownTypes()
  const poster = types.find((t) => t.testKey === 'starter-poster')!

  const counts: number[] = []
  for (let round = 1; round <= ROUNDS; round++) {
    const created = await shell.newDraft(poster.key, {
      title: `round ${round}`,
      layout: 'auto',
      photos: [{ name: 'p1', alt: '', caption: '' }]
    })
    expect(created.id, `round ${round}: draft not created (${JSON.stringify(created)})`).toBeTruthy()

    // A draft opens straight into edit: that is one cage mounted.
    await shell.openThing(created.id!)
    await poll(modeState, (s) => s?.activeMode === 'edit' && s.editWcId !== null, `round ${round} edit mount`)

    // Switching to view mounts a second and leaves the first alive but hidden.
    await shell.app.evaluate(async (electron) => {
      const s = (electron.app as unknown as { __shell: { setMode: (m: string) => Promise<string> } }).__shell
      await s.setMode('view')
    })
    await poll(modeState, (s) => s?.activeMode === 'view' && s.viewWcId !== null, `round ${round} view mount`)

    counts.push(await liveContents())
    if (round % 10 === 0) {
      // eslint-disable-next-line no-console
      console.log(`[churn] round ${round}/${ROUNDS}, ${counts[counts.length - 1]} webContents`)
    }
  }

  // Still alive after all that — the thing the Windows failure disproves.
  expect(await liveContents()).toBeGreaterThan(0)

  // And not accumulating: opening a new thing destroys the previous mounts, so
  // the count should settle rather than climb with every round.
  const early = counts[Math.min(4, counts.length - 1)]!
  const late = counts[counts.length - 1]!
  expect(late, `webContents grew from ${early} to ${late} over ${ROUNDS} rounds — mounts are leaking`).toBeLessThanOrEqual(
    early + 2
  )
})
