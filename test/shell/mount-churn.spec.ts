import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Mount churn ──────────────────────────────────────────────────────────────
// A deliberate stress of the open → edit → view → open cycle.
//
// Written to chase a Windows-only failure in poster.spec.ts:201 where the app
// went away mid-test ("Target page, context or browser has been closed"), and
// it found it: the process was CRASHING -- SIGSEGV on Linux, 0xC0000005 on
// Windows -- when cages were torn down while a preview was mid-mount. This is
// the regression guard for that (see the barrier in main.ts's openThing).
//
// At 60 rounds it reproduced the crash in 7 of 12 unfixed runs, and 0 of 13
// with the fix. Keep the round count meaningful: at 40 rounds it did not
// reproduce at all, so a smaller number would guard nothing.
//
// It also asserts the invariant poster.spec only relies on implicitly: the app
// is still alive, and webContents are not accumulating.

const ROUNDS = Number.parseInt(process.env.CHURN_ROUNDS ?? '60', 10)

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
    // Three cages in one window -- edit, preview, view -- is the state the
    // crash needs; two-cage variants never reproduced it.
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
