// Real instances, for what an offline library cannot do.
//
// `open` is the everyday one: launch the actual GUI on an account's world and
// look at it. `live` holds several up at once, which is what finally makes the
// two-machine test doable on one machine -- seed a thing from one account and
// fetch its magnet from another.
//
// The env below is exactly what the app expects: SHELL_ALLOW_MULTI is the
// existing escape from the single-instance lock (without it the second launch
// hands its argv to the first and exits), and SHELL_NO_RELAUNCH stops an
// identity change from restarting a process we are supervising.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { REPO_ROOT, accountDir, assertNotLive, releaseLock, takeLock } from './account.js'
import { bySlug, deriveRoster } from './roster.js'

const log = (s = ''): void => {
  process.stdout.write(`${s}\n`)
}

const SHELL_MAIN = join(REPO_ROOT, 'out', 'main', 'shell', 'main.js')
const ELECTRON = join(REPO_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron')

/** Headless Linux needs a virtual X server; everything else runs as-is. Same
 *  detection as scripts/run-cage-tests.mjs, for the same reason. */
function displayWrapper(): { command: string; prefix: string[] } {
  const hasDisplay = Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY)
  const xvfbAvailable =
    process.platform === 'linux' && !spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' }).error
  if (process.platform === 'linux' && !hasDisplay && xvfbAvailable) {
    return { command: 'xvfb-run', prefix: ['-a', ELECTRON] }
  }
  return { command: ELECTRON, prefix: [] }
}

/** Where Chromium's SUID helper actually lives, resolved from the Electron
 *  binary rather than guessed — under pnpm the real path is inside the store. */
function chromeSandboxPath(): string | null {
  try {
    const require_ = createRequire(import.meta.url)
    const binary = require_('electron') as unknown
    if (typeof binary !== 'string') return null
    return join(dirname(binary), 'chrome-sandbox')
  } catch {
    return null
  }
}

/** That helper must be root-owned and setuid, or Electron aborts rather than
 *  run unsandboxed. Checked BEFORE launching, so the human gets a remedy
 *  instead of a FATAL line from deep inside Chromium. */
function suidSandboxUsable(path: string | null): boolean {
  if (process.platform !== 'linux' || path === null || !existsSync(path)) return true
  try {
    const st = statSync(path)
    return st.uid === 0 && (st.mode & 0o4000) !== 0
  } catch {
    return true // unreadable: let Electron have the final say
  }
}

function launch(slug: string, noSandbox: boolean): ChildProcess {
  const dir = accountDir(slug)
  const { command, prefix } = displayWrapper()
  const child = spawn(command, [...prefix, SHELL_MAIN], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Not RUN_AS_NODE: this one is the real app, browser and all.
      ELECTRON_RUN_AS_NODE: '',
      // Layer 1 stays ON unless the human asked for it off, and asking is
      // explicit — the same acknowledgement the cage suite demands.
      ...(noSandbox ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
      SHELL_USER_DATA_DIR: dir,
      SHELL_ALLOW_MULTI: '1',
      SHELL_FORCE_SOFTWARE_KEYS: '1',
      SHELL_NO_RELAUNCH: '1'
    }
  })
  takeLock(slug, `live instance, started ${new Date().toISOString()}`)
  return child
}

export async function runLive(command: 'open' | 'live', argv: string[]): Promise<void> {
  const noSandbox = argv.includes('--no-sandbox')
  const slugs = argv.filter((a) => !a.startsWith('--'))
  if (slugs.length === 0) throw new Error(`${command} needs at least one account slug, e.g. \`pnpm world ${command} ada\``)
  const roster = deriveRoster()
  const wanted = slugs.map((s) => bySlug(roster, s))
  for (const who of wanted) assertNotLive(who.slug)

  // This app's whole subject is confinement, so it does not quietly run with a
  // layer of it switched off. Say what is wrong, offer both remedies, and let
  // the human choose one.
  const sandboxHelper = chromeSandboxPath()
  if (!noSandbox && !suidSandboxUsable(sandboxHelper)) {
    throw new Error(
      'the OS sandbox (Layer 1) cannot start: chrome-sandbox is not root-owned and setuid.\n' +
        '\n  Fix it (needs sudo, and is the better option):\n' +
        `    sudo chown root:root ${sandboxHelper}\n` +
        `    sudo chmod 4755 ${sandboxHelper}\n` +
        '\n  Or run this world with that layer OFF, deliberately:\n' +
        `    pnpm world ${command} ${slugs.join(' ')} --no-sandbox\n` +
        '\nThe cage’s in-process guarantees hold either way; the OS layer simply is not exercised.'
    )
  }
  if (noSandbox) {
    log('NOTE: running with the OS sandbox OFF (--no-sandbox). Layer 1 is not exercised.')
  }

  const children = new Map<string, ChildProcess>()
  const cleanup = (): void => {
    for (const [slug, child] of children) {
      releaseLock(slug)
      if (!child.killed) child.kill()
    }
    children.clear()
  }
  // SIGTERM matters as much as SIGINT here: `timeout`, a supervisor, or a
  // plain `kill` all send it, and Node's default handling would exit WITHOUT
  // running exit listeners -- leaving a lock behind and the app orphaned.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log('\nstopping…')
      cleanup()
      process.exit(0)
    })
  }
  process.on('exit', cleanup)

  for (const who of wanted) {
    log(`launching ${who.name} (${who.slug}) on ${accountDir(who.slug)}`)
    const child = launch(who.slug, noSandbox)
    children.set(who.slug, child)
    child.on('exit', (code, signal) => {
      releaseLock(who.slug)
      children.delete(who.slug)
      log(`${who.slug} exited${code === null ? ` on ${signal}` : ` with code ${code}`}`)
    })
  }

  log('')
  log(
    children.size === 1
      ? 'The app is open on that account. Ctrl-C here closes it.'
      : `${children.size} instances are up. Seed a thing in one and paste its magnet into another’s Ingest box. Ctrl-C closes them.`
  )
  // Hold until every child is gone.
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (children.size === 0) {
        clearInterval(tick)
        resolve()
      }
    }, 500)
  })
}
