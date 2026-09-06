// Opening one account's world.
//
// `world/accounts/<slug>` IS a real SHELL_USER_DATA_DIR — the same
// identity.key.enc, library/ and seeds/ the app itself writes — so anything
// provisioned here can be opened by the real GUI with no conversion step.
// The paths below deliberately mirror main.ts's boot (library at
// `<dir>/library`, seed store at `<dir>/seeds`).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Library } from '../../src/shell/library/index.js'
import { Keyring } from '../../src/shell/keyring/index.js'
import { CasStore } from '../../src/main/store.js'
import { toHex, type Signer } from '../../src/format/index.js'
import { deriveRoster, type WorldAccount } from './roster.js'

const here = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(here, '..', '..')
export const WORLD_DIR = process.env.WORLD_DIR ?? join(REPO_ROOT, 'world')
export const ACCOUNTS_DIR = join(WORLD_DIR, 'accounts')
export const WORLD_JSON = join(WORLD_DIR, 'world.json')

export function accountDir(slug: string): string {
  return join(ACCOUNTS_DIR, slug)
}

/** A live instance holds this data dir open. Two writers on one SQLite file is
 *  a corruption risk, and a GUI that never hears about the write would show a
 *  stale feed anyway — so offline commands refuse rather than race. */
export function lockPath(slug: string): string {
  return join(accountDir(slug), '.world-live-lock')
}

/** Is the process that took this lock still running?
 *
 *  A lock is only evidence if its owner is alive. Signal 0 does not deliver
 *  anything -- it just asks the kernel whether the pid exists -- so a lock left
 *  behind by a crash or a kill -9 is recognised as stale and cleared, rather
 *  than blocking the account until someone deletes a file by hand. */
function lockOwner(slug: string): { pid: number; note: string } | null {
  let raw: string
  try {
    raw = readFileSync(lockPath(slug), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; note?: unknown }
    if (typeof parsed.pid !== 'number') return null
    process.kill(parsed.pid, 0) // throws ESRCH if it is gone
    return { pid: parsed.pid, note: typeof parsed.note === 'string' ? parsed.note : '' }
  } catch {
    return null
  }
}

export function assertNotLive(slug: string): void {
  if (!existsSync(lockPath(slug))) return
  const owner = lockOwner(slug)
  if (!owner) {
    // Stale: whoever held it is gone. Clear it and carry on.
    rmSync(lockPath(slug), { force: true })
    return
  }
  throw new Error(
    `${slug} has a live instance open (pid ${owner.pid}${owner.note ? `, ${owner.note}` : ''}). ` +
      'Close it first — offline writes and a running instance must not share a library.'
  )
}

export function takeLock(slug: string, note: string): void {
  mkdirSync(accountDir(slug), { recursive: true })
  writeFileSync(lockPath(slug), `${JSON.stringify({ pid: process.pid, note, at: new Date().toISOString() })}\n`)
}

export function releaseLock(slug: string): void {
  rmSync(lockPath(slug), { force: true })
}

/** An account's on-disk world, opened. Close it when done: SQLite handles are
 *  process-wide and 30 of them left open will exhaust file descriptors. */
export interface OpenAccount {
  who: WorldAccount
  dir: string
  library: Library
  seeds: CasStore
  signer: Signer
  close(): void
}

export function openAccount(who: WorldAccount, opts: { allowLive?: boolean } = {}): OpenAccount {
  if (!opts.allowLive) assertNotLive(who.slug)
  const dir = accountDir(who.slug)
  if (!existsSync(join(dir, 'identity.key.enc'))) {
    throw new Error(`${who.slug} is not provisioned — run: pnpm world provision`)
  }
  // The PRODUCT's signer, loaded from the identity file the app reads, rather
  // than a signer reimplemented here. The world is signed by the same code
  // path the shell uses, so a bundle it makes is a bundle the shell could have.
  const keyring = Keyring.load(dir)
  if (!keyring) throw new Error(`${who.slug} has no identity file`)
  // identity.address is 20 raw bytes; the roster and the library both speak hex.
  const onDisk = toHex(keyring.identity.address)
  if (onDisk !== who.address) {
    throw new Error(
      `${who.slug} on disk is ${onDisk} but the roster derives ${who.address} — ` +
        'the world was provisioned from a different mnemonic. Run: pnpm world reset && pnpm world provision'
    )
  }
  const library = new Library(join(dir, 'library'))
  const seeds = new CasStore(join(dir, 'seeds'))
  return {
    who,
    dir,
    library,
    seeds,
    signer: keyring.signer,
    close: () => library.close()
  }
}

/** Every provisioned account, opened. */
export function openAll(opts: { allowLive?: boolean } = {}): OpenAccount[] {
  return deriveRoster().map((who) => openAccount(who, opts))
}

export function closeAll(open: OpenAccount[]): void {
  for (const a of open) {
    try {
      a.close()
    } catch {
      /* closing a library that never opened is not worth failing a command over */
    }
  }
}

/** Read a sample program by type — the same HTML the app ships as a starter,
 *  so everything this harness creates renders in the real GUI. */
export function sampleProgram(type: string): Uint8Array {
  const path = join(REPO_ROOT, 'samples', `${type}.html`)
  if (!existsSync(path)) throw new Error(`no sample program for type "${type}" (looked in ${path})`)
  return new Uint8Array(readFileSync(path))
}
