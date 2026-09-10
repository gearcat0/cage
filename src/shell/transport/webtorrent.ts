
import { TransportError } from './index.js'

// webtorrent, loaded LAZILY and declared here.
//
// This file no longer implements a Transport. `Transport.fetch()` is
// Promise<bytes>, which cannot express progress, cancellation, or a download
// that outlives the request -- so magnets are handled by TorrentService
// (src/shell/torrent) as long-lived TRANSFERS, and never reach the transport
// dispatch. What remains here is the lazy loader, the shape of the library, and
// the discovery switch.

// These are OUR declarations for a module imported dynamically, which means
// they are an assertion, not a check: if webtorrent's API moves, tsc keeps
// agreeing with whatever is written here. `getBuffer` sat here long after
// webtorrent 3.x replaced it with `arrayBuffer`, and the only symptom was a
// magnet fetch that timed out as though no peer had answered. When touching
// these, read the installed lib/file.js rather than trusting the shape below.
interface WebTorrentFile {
  length: number
  arrayBuffer(): Promise<ArrayBuffer>
}
/** A seeded torrent: what the DHT is announcing, and who is connected. */
export interface WebTorrentSeed {
  magnetURI: string
  numPeers: number
  length: number
  destroy(cb?: () => void): void
}
/** A torrent being DOWNLOADED. The getters and events below were read out of
 *  the installed webtorrent (lib/torrent.js) rather than assumed -- see the
 *  warning above about what these declarations are worth.
 *
 *  `numPeers` counts connected wires. `_peersLength` counts peers DISCOVERED,
 *  connected or not, and is the difference between "nobody is sharing this" and
 *  "found peers, none would talk" -- the distinction the app could not make when
 *  a stale NAT-bound announcement produced a bare "timed out". It is internal
 *  API (underscore), so it is read defensively and may go away. */
export interface WebTorrentDownload {
  infoHash: string
  name?: string
  length: number
  downloaded: number
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  timeRemaining: number
  numPeers: number
  /** Internal; may be absent on a future webtorrent. */
  _peersLength?: number
  files: WebTorrentFile[]
  destroy(cb?: () => void): void
  on(event: 'metadata' | 'ready' | 'done', cb: () => void): void
  on(event: 'error' | 'warning', cb: (err: unknown) => void): void
  /** Fires per DISCOVERY SOURCE ('dht' | 'tracker' | 'lsd') that came back with
   *  nothing, rechecked every 30s. Which source is silent is worth saying. */
  on(event: 'noPeers', cb: (source: string) => void): void
}

export interface WebTorrentClient {
  add(locator: string, opts: { path?: string }, cb: (torrent: WebTorrentDownload) => void): WebTorrentDownload
  seed(input: Uint8Array | Buffer, opts: { name: string }, cb: (torrent: WebTorrentSeed) => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  destroy(cb?: () => void): void
}
/** Client options. Only the discovery switches are modelled: they are the ones
 *  that decide whether a client talks to the outside world at all. */
export interface WebTorrentOptions {
  dht?: boolean
  tracker?: boolean
  lsd?: boolean
}
export type WebTorrentCtor = new (opts?: WebTorrentOptions) => WebTorrentClient

/** How a client is allowed to FIND peers.
 *
 *  `SHELL_TORRENT_OFFLINE=1` turns off all three routes -- the DHT, public
 *  trackers, and local discovery -- leaving a client that can still hash, seed,
 *  report status and fail a fetch, but can never reach the network.
 *
 *  It exists for the tests. What they check about seeding is OURS: that a
 *  magnet is produced, that the intent survives a restart with the same
 *  infohash, that stopping stops, and that deleting a thing stops serving it.
 *  None of that needs a swarm -- but a default client bootstraps the DHT and
 *  announces to public trackers before it will do anything, which on a CI
 *  runner is slow when it works and a timeout when it does not. Those tests had
 *  been given 90 and 120 second budgets to absorb it and still failed
 *  intermittently on all three platforms, which is a test depending on the
 *  weather rather than on the code.
 *
 *  Deliberately NOT the default: a shell that cannot find peers cannot share,
 *  and the real path is exercised by `pnpm world magnet`, which runs two real
 *  instances and moves bytes between them. */
export function torrentDiscoveryOptions(): WebTorrentOptions {
  if (process.env.SHELL_TORRENT_OFFLINE !== '1') return {}
  return { dht: false, tracker: false, lsd: false }
}

/** Exported so the seeding service shares ONE dynamic import and one error
 *  message with the fetch path -- two copies would drift, and this is the
 *  message that misreported a broken native dependency as a missing package. */
export async function loadWebTorrent(): Promise<WebTorrentCtor> {
  try {
    // Non-literal specifier: keeps this an opaque runtime dynamic import, so tsc
    // needn't resolve `webtorrent` at build (it is an optional, uninstalled dep)
    // and vite won't try to bundle it.
    const specifier = 'webtorrent'
    const mod = (await import(specifier)) as { default: WebTorrentCtor }
    return mod.default
  } catch (e) {
    // Say WHY. "Not installed" was the only possible answer here, so a module
    // that IS installed and fails to load (a native dependency that did not
    // build, an ESM/CJS mismatch) reported the one thing that was not true.
    const why = (e as Error)?.message ?? String(e)
    throw new TransportError(
      `webtorrent could not be loaded — ${why}. If it is not installed, run \`pnpm add webtorrent\`.`
    )
  }
}
