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

test('a thing seeds, survives a restart, and stops when asked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-seed-'))
  try {
    let hash: string
    let magnet: string
    {
      const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
      try {
        const { outcome } = await shell.compose(NAMETAG.toString('base64'), 'nametag')
        hash = outcome.envelopeHash as string

        expect(await shell.seedStatus(), 'nothing seeds just by existing').toEqual([])

        const started = await shell.seedStart(hash)
        expect(started.error ?? null).toBeNull()
        magnet = started.magnet as string
        expect(magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}/i)

        const status = await shell.seedStatus()
        expect(status.length).toBe(1)
        expect(status[0]!.envelopeHash).toBe(hash)
        expect(status[0]!.type).toBe('nametag')
      } finally {
        await shell.app.close() // keep the profile
      }
    }

    // The intent is remembered, and resuming produces the SAME infohash —
    // which is what makes a magnet handed out yesterday still work today.
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      const resumed = await expect
        .poll(async () => (await shell.seedStatus()).length, { timeout: 30_000 })
        .toBe(1)
        .then(() => shell.seedStatus())
      expect(resumed[0]!.envelopeHash).toBe(hash!)
      expect(resumed[0]!.magnet).toBe(magnet!)

      // Stopping stops, and is remembered: a restart must not resurrect it.
      expect((await shell.seedStop(hash!)).stopped).toBe(true)
      expect(await shell.seedStatus()).toEqual([])
    } finally {
      await shell.app.close()
    }

    const third = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      await new Promise((r) => setTimeout(r, 1500))
      expect(await third.seedStatus(), 'a stopped share stays stopped').toEqual([])
    } finally {
      await third.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
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
