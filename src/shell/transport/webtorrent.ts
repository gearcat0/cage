import { TransportError, type FetchLimits, type Transport } from './index.js'

// `magnet:?xt=urn:btih:…` — BitTorrent via webtorrent, WIRED behind the
// interface. webtorrent is a heavy WebRTC/DHT dependency and this environment
// has no peers, so it is loaded LAZILY: a magnet locator dispatches here, and if
// webtorrent is not installed (the default) the fetch fails with a clear,
// actionable error rather than crashing. Enable with `pnpm add webtorrent`.
// The live-network download/seed path is exercised manually, not in CI.
//
// LATER: seeding admitted bundles to peers; DHT privacy hardening.

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
interface WebTorrentInstance {
  length: number
  files: WebTorrentFile[]
}
/** A seeded torrent: what the DHT is announcing, and who is connected. */
export interface WebTorrentSeed {
  magnetURI: string
  numPeers: number
  length: number
  destroy(cb?: () => void): void
}
export interface WebTorrentClient {
  add(locator: string, cb: (torrent: WebTorrentInstance) => void): void
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

export class WebtorrentTransport implements Transport {
  supports(locator: string): boolean {
    return locator.startsWith('magnet:')
  }

  async fetch(locator: string, limits: FetchLimits): Promise<Uint8Array> {
    const WebTorrent = await loadWebTorrent()
    return new Promise<Uint8Array>((resolve, reject) => {
      const client = new WebTorrent(torrentDiscoveryOptions())
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        try {
          client.destroy()
        } catch {
          /* already gone */
        }
      }
      const fail = (msg: string): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new TransportError(msg))
      }
      const done = (bytes: Uint8Array): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(bytes)
      }
      const timer = setTimeout(() => fail('magnet fetch timed out'), limits.timeoutMs)

      client.on('error', (e) => fail(`webtorrent: ${String(e)}`))
      // The callback body is wrapped because a THROW in here has nowhere to
      // go: webtorrent does not catch it, the promise never settles, and the
      // only symptom is the outer timeout -- which says "timed out" and reads
      // as "no peers", even when the peers connected and the data arrived.
      // That is exactly how the getBuffer/arrayBuffer drift below stayed
      // hidden. A throw must fail the fetch with its own message.
      client.add(locator, (torrent) => {
        try {
          // Bound the download by total size before pulling bytes.
          if (torrent.length > limits.maxBytes) return fail('torrent exceeds maxBytes')
          const file = torrent.files[0]
          if (!file) return fail('empty torrent')
          // webtorrent 3.x exposes arrayBuffer(); the callback-style
          // getBuffer() it replaced no longer exists.
          file
            .arrayBuffer()
            .then((buf) => done(new Uint8Array(buf)))
            .catch((e: unknown) => fail(`webtorrent read: ${String(e)}`))
        } catch (e) {
          fail(`webtorrent: ${(e as Error).message}`)
        }
      })
    })
  }
}
