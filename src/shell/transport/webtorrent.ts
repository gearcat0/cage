import { TransportError, type FetchLimits, type Transport } from './index.js'

// `magnet:?xt=urn:btih:…` — BitTorrent via webtorrent, WIRED behind the
// interface. webtorrent is a heavy WebRTC/DHT dependency and this environment
// has no peers, so it is loaded LAZILY: a magnet locator dispatches here, and if
// webtorrent is not installed (the default) the fetch fails with a clear,
// actionable error rather than crashing. Enable with `pnpm add webtorrent`.
// The live-network download/seed path is exercised manually, not in CI.
//
// LATER: seeding admitted bundles to peers; DHT privacy hardening.

interface WebTorrentFile {
  length: number
  getBuffer(cb: (err: Error | null, buf: Uint8Array) => void): void
}
interface WebTorrentInstance {
  length: number
  files: WebTorrentFile[]
}
interface WebTorrentClient {
  add(locator: string, cb: (torrent: WebTorrentInstance) => void): void
  on(event: 'error', cb: (err: unknown) => void): void
  destroy(cb?: () => void): void
}
type WebTorrentCtor = new () => WebTorrentClient

async function loadWebTorrent(): Promise<WebTorrentCtor> {
  try {
    // Non-literal specifier: keeps this an opaque runtime dynamic import, so tsc
    // needn't resolve `webtorrent` at build (it is an optional, uninstalled dep)
    // and vite won't try to bundle it.
    const specifier = 'webtorrent'
    const mod = (await import(specifier)) as { default: WebTorrentCtor }
    return mod.default
  } catch {
    throw new TransportError(
      'webtorrent is not installed — run `pnpm add webtorrent` to enable magnet transport'
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
      const client = new WebTorrent()
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
      client.add(locator, (torrent) => {
        // Bound the download by total size before pulling bytes.
        if (torrent.length > limits.maxBytes) return fail('torrent exceeds maxBytes')
        const file = torrent.files[0]
        if (!file) return fail('empty torrent')
        file.getBuffer((err, buf) => {
          if (err) fail(`webtorrent read: ${String(err)}`)
          else done(new Uint8Array(buf))
        })
      })
    })
  }
}
