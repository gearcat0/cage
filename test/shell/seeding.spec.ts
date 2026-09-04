import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell } from './helpers.js'

// ── Seeding ──────────────────────────────────────────────────────────────────
// Serving admitted bundles to peers. The live network path — a peer actually
// fetching — is not testable here (CI has no peers), so what is pinned is
// everything around it: that seeding starts and produces a magnet, that the
// INTENT survives a restart, that stopping stops, and that deleting a thing
// stops serving it. Those are the parts that would silently keep announcing
// something the human thought was private.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

// Three shell launches plus a webtorrent client that has to come up and build a
// torrent — comfortably past the 30s default on a loaded runner, where this
// first failed. The work is real, not a hang; give it room.
test.beforeEach(() => test.setTimeout(120_000))

// Split in two on purpose. Bringing up a webtorrent client is the expensive
// part, and doing it twice inside ONE budget blew even 120s on a constrained
// runner. Each half now gets its own, and they share a profile the way the
// feature does: the second test reads what the first one left on disk.
let sharedDir: string | null = null
let seededHash: string | null = null
let seededMagnet: string | null = null

test('seeding a thing produces a magnet, and nothing seeds by itself', async () => {
  sharedDir = mkdtempSync(join(tmpdir(), 'shell-seed-'))
  const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: sharedDir } })
  try {
    const { outcome } = await shell.compose(NAMETAG.toString('base64'), 'nametag')
    seededHash = outcome.envelopeHash as string

    expect(await shell.seedStatus(), 'nothing seeds just by existing').toEqual([])

    const started = await shell.seedStart(seededHash)
    expect(started.error ?? null).toBeNull()
    seededMagnet = started.magnet as string
    expect(seededMagnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/i)

    const status = await shell.seedStatus()
    expect(status.length).toBe(1)
    expect(status[0]!.envelopeHash).toBe(seededHash)
    expect(status[0]!.type).toBe('nametag')
  } finally {
    await shell.app.close() // keep the profile for the next test
  }
})

test('the intent survives a restart, and a stop stays stopped', async () => {
  // If the test above did not finish (a worker restart resets module state),
  // there is nothing to resume and a failure here would be noise about that.
  test.skip(!sharedDir || !seededHash, 'depends on the seeding test above')
  const dir = sharedDir!
  try {
    {
      const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
      try {
        // Resuming produces the SAME infohash — which is what makes a magnet
        // handed out yesterday still work today.
        await expect.poll(async () => (await shell.seedStatus()).length, { timeout: 40_000 }).toBe(1)
        const resumed = await shell.seedStatus()
        expect(resumed[0]!.envelopeHash).toBe(seededHash)
        expect(resumed[0]!.magnet).toBe(seededMagnet)

        expect((await shell.seedStop(seededHash!)).stopped).toBe(true)
        expect(await shell.seedStatus()).toEqual([])
      } finally {
        await shell.app.close()
      }
    }

    // A stopped share stays stopped: the record is gone, so nothing resumes.
    const third = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      await new Promise((r) => setTimeout(r, 2000))
      expect(await third.seedStatus()).toEqual([])
    } finally {
      await third.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    sharedDir = null
  }
})

test('deleting a thing stops serving it', async () => {
  const shell = await launchShell()
  try {
    const { outcome } = await shell.compose(NAMETAG.toString('base64'), 'nametag')
    const hash = outcome.envelopeHash as string
    expect((await shell.seedStart(hash)).error ?? null).toBeNull()
    expect((await shell.seedStatus()).length).toBe(1)

    // Deleting is the human saying they no longer hold it. Continuing to
    // announce it would be the worst kind of surprise.
    await shell.app.evaluate(async (electron, h) => {
      const s = (electron.app as unknown as { __shell: { deleteThing: (x: string) => unknown } }).__shell
      s.deleteThing(h)
    }, hash)
    expect(await shell.seedStatus()).toEqual([])
  } finally {
    await shell.close()
  }
})
