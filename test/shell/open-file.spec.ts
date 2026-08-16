import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Opening a .thing from the desktop ────────────────────────────────────────
// Double-clicking a bundle hands its path to the shell: on Windows/Linux in
// argv (and via `second-instance` when a shell is already running), on macOS
// as an `open-file` event. However it arrives, the bytes go through the SAME
// admission gate as a pasted or fetched bundle — a file is not more trusted
// for having been double-clicked.

const SHELL_MAIN = join(__dirname, '..', '..', 'out', 'main', 'shell', 'main.js')
const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

const ready = async (app: ElectronApplication): Promise<void> => {
  await poll(
    () => app.evaluate(async (e) => Boolean((e.app as unknown as { __shell?: { ready?: boolean } }).__shell?.ready)),
    (v) => v
  )
}

const feedOf = (app: ElectronApplication): Promise<Record<string, unknown>[]> =>
  app.evaluate(async (e) => {
    const s = (e.app as unknown as { __shell: { feed: () => Record<string, unknown>[] } }).__shell
    return s.feed() as never
  })

const lastFileOpen = (app: ElectronApplication): Promise<Record<string, unknown> | null> =>
  app.evaluate(async (e) => {
    const s = (e.app as unknown as { __shell: { lastFileOpen: Record<string, unknown> | null } }).__shell
    return s.lastFileOpen as never
  })

/** Launch the app the way the OS does when you double-click a bundle: the
 *  path as a plain argv entry. */
function launchWithFile(dir: string, thingPath: string): Promise<ElectronApplication> {
  return _electron.launch({
    args: [SHELL_MAIN, thingPath],
    env: {
      ...process.env,
      SHELL_USER_DATA_DIR: dir,
      SHELL_FORCE_SOFTWARE_KEYS: '1',
      SHELL_NO_RELAUNCH: '1'
    } as Record<string, string>
  })
}

async function strangerBundle(shell: ShellHandle, type = 'nametag'): Promise<Uint8Array> {
  void shell
  return buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type, program: new Uint8Array(NAMETAG) })
}

test('a .thing passed at launch is admitted and opened', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-openfile-'))
  const file = join(dir, 'gift.thing')
  try {
    // A bundle from someone else, sitting on disk like a download.
    const shell = await launchShell()
    const bundle = await strangerBundle(shell)
    await shell.close()
    writeFileSync(file, bundle)

    const app = await launchWithFile(dir, file)
    try {
      await ready(app)
      const outcome = await poll(() => lastFileOpen(app), (r) => r != null)
      expect(outcome!.status).toBe('valid')
      expect(outcome!.path).toBe(file)
      // It landed in the library…
      const feed = await feedOf(app)
      expect(feed.length).toBe(1)
      expect(feed[0]!.type).toBe('nametag')
      // …and the shell opens it, so the user sees what they just opened.
      // Polled, not read once: lastFileOpen is set when the bundle is
      // ADMITTED, and the mount follows it.
      await poll(
        () =>
          app.evaluate(async (e) => {
            const s = (
              e.app as unknown as { __shell: { modeState: () => { viewWcId: number | null } | null } }
            ).__shell.modeState()
            return s?.viewWcId != null
          }),
        (open) => open === true
      )
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt .thing is rejected with a reason, not silently ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-openfile-bad-'))
  const file = join(dir, 'broken.thing')
  try {
    writeFileSync(file, Buffer.from('this is not a tar at all'))
    const app = await launchWithFile(dir, file)
    try {
      await ready(app)
      const outcome = await poll(() => lastFileOpen(app), (r) => r != null)
      expect(outcome!.status).toBe('invalid')
      expect(String(outcome!.reason).length).toBeGreaterThan(0)
      expect((await feedOf(app)).length).toBe(0)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second launch hands the file to the running shell instead of starting a rival', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-openfile-single-'))
  const file = join(dir, 'handed-over.thing')
  try {
    const seed = await launchShell()
    const bundle = await strangerBundle(seed, 'memo')
    await seed.close()
    writeFileSync(file, bundle)

    // First instance: already running, nothing in its feed.
    const first = await _electron.launch({
      args: [SHELL_MAIN],
      env: {
        ...process.env,
        SHELL_USER_DATA_DIR: dir,
        SHELL_FORCE_SOFTWARE_KEYS: '1',
        SHELL_NO_RELAUNCH: '1'
      } as Record<string, string>
    })
    try {
      await ready(first)
      expect((await feedOf(first)).length).toBe(0)

      // Double-clicking the file launches a second copy, which must hand the
      // path over and exit rather than opening a rival library. It exits so
      // fast that Playwright may never get a session — either way, what
      // matters is that it did not stay up owning the same profile.
      const handoff = await launchWithFile(dir, file).then(
        async (app) => {
          const stillUp = await app
            .evaluate(async (e) => Boolean((e.app as unknown as { __shell?: unknown }).__shell))
            .catch(() => false)
          await app.close().catch(() => {})
          return stillUp ? 'stayed-up' : 'exited'
        },
        () => 'exited' // died before Playwright could attach: the handoff path
      )
      expect(handoff, 'the second instance must not open a rival library').toBe('exited')

      // The FIRST instance ingested it.
      const outcome = await poll(() => lastFileOpen(first), (r) => r != null)
      expect(outcome!.status).toBe('valid')
      const feed = await feedOf(first)
      expect(feed.length).toBe(1)
      expect(feed[0]!.type).toBe('memo')
    } finally {
      await first.close().catch(() => {})
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
