import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadWebTorrent,
  torrentDiscoveryOptions,
  type WebTorrentClient,
  type WebTorrentDownload,
  type WebTorrentSeed
} from '../transport/webtorrent.js'

// ── Torrents: downloads and seeds ────────────────────────────────────────────
// Serving admitted bundles to peers over BitTorrent, so a magnet link someone
// is handed actually resolves to something.
//
// This is the app's first DELIBERATE outbound exposure, and the shape reflects
// that:
//
//   • Opt-in per thing, off by default. Nothing seeds because it exists.
//   • What is seeded is the ORIGINAL admitted tar from the seed store — the
//     same bytes Share hands out — so the magnet resolves to exactly what was
//     signed, byte for byte.
//   • Seeding announces to the DHT. Anyone holding the magnet learns the IP of
//     whoever is serving it. For a SEALED thing the bytes stay encrypted, but
//     that you hold it does not: the chrome says so before the toggle.
//
// The fetch path builds a client per download and destroys it, which is right
// for a download and wrong here — a seed must stay up. So this holds ONE
// long-lived client, created lazily on the first seed so the shell still
// starts when webtorrent is missing or fails to load.

export interface SeedStatus {
  envelopeHash: string
  magnet: string
  peers: number
  bytes: number
}

/** How a download is going, and -- when it is going badly -- WHY.
 *
 *  `peersConnected` is wires; `peersDiscovered` is peers the swarm told us
 *  about, connected or not. The gap between them is the whole point: a stale
 *  announcement from behind NAT looks identical to an empty swarm unless you
 *  report both. */
export interface DownloadStatus {
  id: string
  magnet: string
  infoHash: string
  name: string
  state: 'starting' | 'finding-peers' | 'peers-unreachable' | 'downloading' | 'stalled' | 'verifying' | 'admitting' | 'failed'
  bytes: number
  downloaded: number
  progress: number
  downloadSpeed: number
  peersConnected: number
  peersDiscovered: number
  /** Discovery sources that have reported finding nothing, e.g. ['dht','lsd']. */
  silentSources: string[]
  error: string | null
  startedAt: number
}

interface Download {
  id: string
  magnet: string
  infoHash: string
  name: string
  dir: string
  torrent: WebTorrentDownload | null
  state: DownloadStatus['state']
  error: string | null
  startedAt: number
  lastBytes: number
  lastProgressAt: number
  silentSources: Set<string>
  settled: boolean
}

/** How long a download may sit connected-but-silent, or discovered-but-
 *  unconnected, before it says so. It keeps running either way -- reporting a
 *  stall is not the same as giving up on it, and that difference is what makes
 *  this a download manager rather than a fetch with extra words. */
const QUIET_MS = 15_000

export class TorrentService {
  private client: WebTorrentClient | null = null
  private clientFailed: string | null = null
  private readonly torrents = new Map<string, WebTorrentSeed>()
  private readonly magnets = new Map<string, string>()
  private readonly downloads = new Map<string, Download>()
  /** Where partial downloads live. Set per profile rather than webtorrent's
   *  default of /tmp/webtorrent, which is cleared on reboot (so nothing could
   *  resume) and SHARED BETWEEN PROFILES -- that sharing is what produced the
   *  misleading "verifying existing torrent data" when two instances were being
   *  debugged against each other. */
  private downloadRoot = ''

  setDownloadRoot(dir: string): void {
    this.downloadRoot = dir
  }

  /** One client, made on first use. A shell that never seeds never loads
   *  webtorrent at all, which is why this is not created in the constructor. */
  private async ensureClient(): Promise<WebTorrentClient> {
    if (this.client) return this.client
    if (this.clientFailed !== null) throw new Error(this.clientFailed)
    const WebTorrent = await loadWebTorrent()
    const c = new WebTorrent(torrentDiscoveryOptions())
    // A client-level error must not take the shell down with it.
    c.on('error', () => {
      /* per-torrent failures surface through status(); nothing to do here */
    })
    this.client = c
    return c
  }

  isSeeding(envelopeHash: string): boolean {
    return this.torrents.has(envelopeHash)
  }

  magnetFor(envelopeHash: string): string | null {
    return this.magnets.get(envelopeHash) ?? null
  }

  /** Start serving `tar` under `envelopeHash`. Idempotent: seeding something
   *  already seeded returns the existing magnet rather than a second torrent
   *  for the same bytes. */
  async start(envelopeHash: string, tar: Uint8Array, name: string): Promise<{ magnet: string } | { error: string }> {
    const already = this.magnets.get(envelopeHash)
    if (already) return { magnet: already }
    let client: WebTorrentClient
    try {
      client = await this.ensureClient()
    } catch (e) {
      // Remembered, so every later attempt fails fast with the same reason
      // instead of re-running a dynamic import that will not succeed.
      this.clientFailed = (e as Error).message
      return { error: this.clientFailed }
    }
    return new Promise<{ magnet: string } | { error: string }>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ error: 'seeding did not start (timed out building the torrent)' })
      }, 30_000)
      timer.unref?.()
      try {
        client.seed(tar, { name }, (torrent) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.torrents.set(envelopeHash, torrent)
          this.magnets.set(envelopeHash, torrent.magnetURI)
          resolve({ magnet: torrent.magnetURI })
        })
      } catch (e) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ error: `seeding failed: ${(e as Error).message}` })
      }
    })
  }

  /** Stop serving it. The bytes stay in the library; only the announcing stops. */
  stop(envelopeHash: string): boolean {
    const t = this.torrents.get(envelopeHash)
    this.torrents.delete(envelopeHash)
    this.magnets.delete(envelopeHash)
    if (!t) return false
    try {
      t.destroy()
    } catch {
      /* already gone */
    }
    return true
  }

  /** What is being announced right now, with live peer counts. */
  status(): SeedStatus[] {
    const out: SeedStatus[] = []
    for (const [envelopeHash, t] of this.torrents) {
      out.push({
        envelopeHash,
        magnet: this.magnets.get(envelopeHash) ?? t.magnetURI,
        // A torrent that has gone away still reports through the map until it
        // is stopped; treat unreadable counts as zero rather than throwing.
        peers: typeof t.numPeers === 'number' ? t.numPeers : 0,
        bytes: typeof t.length === 'number' ? t.length : 0
      })
    }
    return out
  }

  // ── Downloads ──────────────────────────────────────────────────────────────

  /** Begin (or resume) a download. Returns as soon as it is registered: the
   *  caller gets an id, not bytes. Progress is read through status(). */
  async startDownload(id: string, magnet: string, name: string): Promise<{ error: string } | null> {
    if (this.downloads.has(id)) return null
    const infoHash = infoHashOf(magnet)
    const dir = join(this.downloadRoot || '.', infoHash || id)
    const d: Download = {
      id,
      magnet,
      infoHash,
      name,
      dir,
      torrent: null,
      state: 'starting',
      error: null,
      startedAt: Date.now(),
      lastBytes: 0,
      lastProgressAt: Date.now(),
      silentSources: new Set(),
      settled: false
    }
    this.downloads.set(id, d)

    let client: WebTorrentClient
    try {
      client = await this.ensureClient()
    } catch (e) {
      this.clientFailed = (e as Error).message
      d.state = 'failed'
      d.error = this.clientFailed
      return { error: this.clientFailed }
    }
    try {
      mkdirSync(dir, { recursive: true })
      // Adding an infoHash we already hold partial data for makes webtorrent
      // re-verify what is on disk -- which is exactly what resuming is.
      const torrent = client.add(magnet, { path: dir }, () => {
        /* ready; state is derived in status() */
      })
      d.torrent = torrent
      d.state = 'finding-peers'
      torrent.on('noPeers', (source) => {
        if (typeof source === 'string') d.silentSources.add(source)
      })
      torrent.on('error', (err) => {
        d.state = 'failed'
        d.error = String((err as Error)?.message ?? err)
      })
      torrent.on('metadata', () => {
        if (!d.name && typeof torrent.name === 'string') d.name = torrent.name
      })
    } catch (e) {
      d.state = 'failed'
      d.error = (e as Error).message
      return { error: d.error }
    }
    return null
  }

  /** The torrent behind a download, for the caller that needs its bytes. */
  torrentFor(id: string): WebTorrentDownload | null {
    return this.downloads.get(id)?.torrent ?? null
  }

  /** Mark where a download has got to, for states this service cannot see --
   *  reading the file out, and admission. */
  setDownloadState(id: string, state: DownloadStatus['state'], error?: string): void {
    const d = this.downloads.get(id)
    if (!d) return
    d.state = state
    if (error !== undefined) d.error = error
    if (state === 'verifying' || state === 'admitting') d.settled = true
  }

  /** Stop a download and remove its partial data. */
  cancelDownload(id: string): boolean {
    const d = this.downloads.get(id)
    if (!d) return false
    this.downloads.delete(id)
    try {
      d.torrent?.destroy()
    } catch {
      /* already gone */
    }
    // The partial file is worth nothing once the intent is gone, and left alone
    // it would accumulate silently.
    try {
      rmSync(d.dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    return true
  }

  downloadStatus(): DownloadStatus[] {
    const now = Date.now()
    const out: DownloadStatus[] = []
    for (const d of this.downloads.values()) {
      const t = d.torrent
      const connected = num(t?.numPeers)
      // Internal API, read defensively: if a future webtorrent drops it we
      // report connected-only rather than inventing a number.
      const discovered = Math.max(connected, num(t?._peersLength))
      const downloaded = num(t?.downloaded)
      if (downloaded > d.lastBytes) {
        d.lastBytes = downloaded
        d.lastProgressAt = now
      }
      const quiet = now - d.lastProgressAt > QUIET_MS
      let state = d.state
      // Only diagnose while the transfer is still the swarm's business; once we
      // are verifying or admitting, peer counts say nothing useful.
      if (!d.settled && state !== 'failed') {
        if (downloaded > 0 && !quiet) state = 'downloading'
        else if (connected > 0 && quiet) state = 'stalled'
        else if (connected > 0) state = 'downloading'
        else if (discovered > 0 && quiet) state = 'peers-unreachable'
        else state = 'finding-peers'
      }
      out.push({
        id: d.id,
        magnet: d.magnet,
        infoHash: d.infoHash,
        name: d.name || t?.name || '',
        state,
        bytes: num(t?.length),
        downloaded,
        progress: t && typeof t.progress === 'number' ? t.progress : 0,
        downloadSpeed: num(t?.downloadSpeed),
        peersConnected: connected,
        peersDiscovered: discovered,
        silentSources: [...d.silentSources],
        error: d.error,
        startedAt: d.startedAt
      })
    }
    return out
  }

  /** Drop a finished download's bookkeeping and its now-redundant partial file.
   *  The bytes live in the library's CAS and the seed store by this point. */
  finishDownload(id: string): void {
    const d = this.downloads.get(id)
    if (!d) return
    this.downloads.delete(id)
    try {
      d.torrent?.destroy()
    } catch {
      /* already gone */
    }
    try {
      rmSync(d.dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  async destroy(): Promise<void> {
    for (const id of [...this.downloads.keys()]) {
      // Leave the partial data: the transfers table still records the intent,
      // so a restart resumes rather than starts over.
      const d = this.downloads.get(id)
      this.downloads.delete(id)
      try {
        d?.torrent?.destroy()
      } catch {
        /* already gone */
      }
    }
    for (const hash of [...this.torrents.keys()]) this.stop(hash)
    const c = this.client
    this.client = null
    if (!c) return
    await new Promise<void>((resolve) => {
      try {
        c.destroy(() => resolve())
      } catch {
        resolve()
      }
    })
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The infohash out of a magnet, lowercased, or '' if it names none. */
export function infoHashOf(magnet: string): string {
  const m = /xt=urn:btih:([0-9a-z]+)/i.exec(magnet)
  return m ? m[1]!.toLowerCase() : ''
}

/** The `dn=` display name a magnet carries, if any. It is the publisher's
 *  claim, like every other name in this system, and is shown as such. */
export function displayNameOf(magnet: string): string {
  const m = /[?&]dn=([^&]+)/i.exec(magnet)
  if (!m) return ''
  try {
    return decodeURIComponent(m[1]!.replace(/\+/g, ' ')).slice(0, 120)
  } catch {
    return ''
  }
}
