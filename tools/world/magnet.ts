// The two-machine test, on one machine.
//
// Seeding and magnet fetching are the one part of sharing that no unit test can
// reach: the CI magnet spec deliberately asserts only that it "fails cleanly
// with no peers", because CI has no peers. This gives it peers — two real
// instances, two real libraries, two different keys — and moves bytes between
// them over BitTorrent.
//
// Driven through Playwright's Electron launcher rather than `spawn`, because
// this needs a control channel into `app.__shell`, not just a process.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from 'playwright'
import { REPO_ROOT, accountDir, assertNotLive, releaseLock, takeLock } from './account.js'
import { bySlug, deriveRoster, type WorldAccount } from './roster.js'

const log = (s = ''): void => {
  process.stdout.write(`${s}\n`)
}

const SHELL_MAIN = join(REPO_ROOT, 'out', 'main', 'shell', 'main.js')

interface Instance {
  who: WorldAccount
  app: ElectronApplication
}

async function launch(who: WorldAccount, fetchTimeoutMs: number, debug: boolean): Promise<Instance> {
  const app = await _electron.launch({
    args: [SHELL_MAIN],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHELL_USER_DATA_DIR: accountDir(who.slug),
      SHELL_ALLOW_MULTI: '1',
      SHELL_FORCE_SOFTWARE_KEYS: '1',
      SHELL_NO_RELAUNCH: '1',
      // Peer discovery on a cold swarm takes longer than the 30s default.
      SHELL_FETCH_TIMEOUT_MS: String(fetchTimeoutMs),
      ...(debug ? { DEBUG: 'bittorrent-lsd,webtorrent*,torrent*,bittorrent-dht' } : {})
    } as Record<string, string>
  })
  if (debug) {
    // Peer discovery failing is invisible from the outside: the fetch simply
    // times out. The libraries say plenty on stderr, so surface it labelled.
    app.process().stderr?.on('data', (b: Buffer) => {
      for (const line of String(b).split('\n')) {
        if (line.trim() && !/vaapi|libva|GPU|gpu_/i.test(line)) log(`  [${who.slug}] ${line.trim().slice(0, 200)}`)
      }
    })
  }
  takeLock(who.slug, 'magnet test')
  // Poll from OUT here rather than looping inside one long evaluate: the
  // inspector context is torn down and rebuilt during startup, so a single
  // long-lived evaluate dies with "Execution context was destroyed". Short
  // evaluates, retried, is what test/shell/helpers.ts does and why it works.
  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  for (;;) {
    try {
      // tsx compiles this file with esbuild's keepNames, which wraps named
      // functions in a `__name(...)` helper. Playwright ships the SOURCE of an
      // evaluated function to the remote context, where that helper does not
      // exist. A string evaluate is not instrumented, so it installs the shim;
      // reinstalled each round because a rebuilt context loses it.
      await app.evaluate('globalThis.__name = globalThis.__name || ((f) => f)')
      const ready = await app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell?: { ready?: boolean } }).__shell
        return Boolean(s?.ready)
      })
      if (ready) break
      lastErr = null
    } catch (e) {
      lastErr = e // transient during startup; the deadline is the real bound
    }
    if (Date.now() > deadline) {
      throw lastErr instanceof Error ? lastErr : new Error(`${who.slug} never became ready`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return { who, app }
}

/** Call one of the shell's own hooks inside an instance. */
function hook<T>(inst: Instance, body: string): Promise<T> {
  return inst.app.evaluate(async (electron, src) => {
    const shell = (electron.app as unknown as { __shell: Record<string, unknown> }).__shell
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function('shell', `return (async () => { ${src} })()`) as (
      s: unknown
    ) => Promise<unknown>
    return (await fn(shell)) as never
  }, body)
}

export async function runMagnet(argv: string[]): Promise<void> {
  const flag = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback
  }
  const roster = deriveRoster()
  const from = bySlug(roster, flag('from', 'ada'))
  const to = bySlug(roster, flag('to', 'grace'))
  const timeoutMs = Number.parseInt(flag('timeout', '180000'), 10)
  const debug = argv.includes('--debug')
  if (from.slug === to.slug) throw new Error('--from and --to must be different accounts')
  assertNotLive(from.slug)
  assertNotLive(to.slug)

  // Playwright's Electron launcher injects --no-sandbox. This app is about
  // confinement, so that is stated rather than assumed, exactly as the cage
  // suite's CAGE_ALLOW_NO_SANDBOX does.
  log('NOTE: Playwright launches Electron with --no-sandbox. Layer 1 is not exercised by this test.')
  log('')

  const started: Instance[] = []
  try {
    log(`seeder:  ${from.name} (${from.slug})`)
    log(`fetcher: ${to.name} (${to.slug})`)
    log('')
    const seeder = await launch(from, timeoutMs, debug)
    started.push(seeder)
    const fetcher = await launch(to, timeoutMs, debug)
    started.push(fetcher)
    log('both instances up')

    // A FRESH thing, made now. Seeding something the fetcher already holds
    // would prove nothing: it would "arrive" from its own library.
    const nametag = readFileSync(join(REPO_ROOT, 'samples', 'nametag.html')).toString('base64')
    const composed = await hook<{ outcome: Record<string, unknown>; tarBase64: string }>(
      seeder,
      `const r = await shell.compose(${JSON.stringify(nametag)}, 'magnet-test'); return r`
    )
    const hash = composed.outcome.envelopeHash as string
    if (composed.outcome.status !== 'valid') {
      throw new Error(`the seeder could not author a thing: ${JSON.stringify(composed.outcome)}`)
    }
    log(`authored on ${from.slug}: ${hash.slice(0, 16)}…`)

    const alreadyThere = await hook<boolean>(
      fetcher,
      `return shell.feed({ limit: 10000 }).some(r => r.envelopeHash === ${JSON.stringify(hash)})`
    )
    if (alreadyThere) throw new Error('the fetcher already holds it — this test would prove nothing')
    log(`${to.slug} does not hold it (as it should not)`)

    const seeded = await hook<{ magnet?: string; error?: string }>(
      seeder,
      `return shell.seedStart(${JSON.stringify(hash)})`
    )
    if (!seeded.magnet) throw new Error(`seeding failed: ${seeded.error ?? 'unknown'}`)
    log('')
    log(`magnet: ${seeded.magnet.slice(0, 96)}…`)
    log('')
    log(`fetching on ${to.slug} (up to ${Math.round(timeoutMs / 1000)}s for peer discovery)…`)

    const started_at = Date.now()
    const outcome = await hook<Record<string, unknown>>(
      fetcher,
      `return shell.fetch(${JSON.stringify(seeded.magnet)})`
    )
    const took = ((Date.now() - started_at) / 1000).toFixed(1)

    if (outcome.status !== 'valid') {
      log('')
      log(`FAILED after ${took}s: ${JSON.stringify(outcome)}`)
      log('')
      log('If this says "magnet fetch timed out", the two peers never found each other.')
      log('Discovery needs the DHT or a tracker to be reachable; raise --timeout, or')
      log('check whether this machine can reach the public BitTorrent network.')
      process.exitCode = 1
      return
    }

    // It admitted — but did it land in the library, under the same hash, with
    // the seeder's signature intact? That is the actual claim.
    const landed = await hook<{ has: boolean; author: string | null; type: string | null }>(
      fetcher,
      `const rows = shell.feed({ limit: 10000 });
       const row = rows.find(r => r.envelopeHash === ${JSON.stringify(hash)}) ?? null;
       return { has: !!row, author: row ? row.authorKey : null, type: row ? row.type : null }`
    )
    log('')
    log(`ARRIVED in ${took}s`)
    log(`  hash    ${hash}`)
    log(`  in ${to.slug}'s library: ${landed.has ? 'yes' : 'NO'}`)
    log(`  type    ${landed.type ?? '—'}`)
    log(`  author  ${landed.author ?? '—'}`)
    log(`  ${landed.author === from.address ? `still signed by ${from.name} — the signature crossed intact` : 'AUTHOR MISMATCH'}`)
    if (!landed.has || landed.author !== from.address) {
      log('')
      log('The bytes moved but the result is not what was seeded.')
      process.exitCode = 1
    }
    // Leave the world as we found it. Seeding intent PERSISTS across restarts,
    // so without this every run would add another torrent the seeder announces
    // forever -- which is exactly the stray infohash that muddied the first
    // diagnosis of this test.
    await hook(seeder, `shell.seedStop(${JSON.stringify(hash)}); return null`).catch(() => null)
    for (const inst of [seeder, fetcher]) {
      await hook(inst, `shell.deleteThing(${JSON.stringify(hash)}); return null`).catch(() => null)
    }
  } finally {
    for (const inst of started) {
      releaseLock(inst.who.slug)
      await inst.app.close().catch(() => {})
    }
  }
}
