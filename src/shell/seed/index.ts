import { loadWebTorrent, type WebTorrentClient, type WebTorrentSeed } from '../transport/webtorrent.js'

// ── Seeding ──────────────────────────────────────────────────────────────────
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

export class SeedService {
  private client: WebTorrentClient | null = null
  private clientFailed: string | null = null
  private readonly torrents = new Map<string, WebTorrentSeed>()
  private readonly magnets = new Map<string, string>()

  /** One client, made on first use. A shell that never seeds never loads
   *  webtorrent at all, which is why this is not created in the constructor. */
  private async ensureClient(): Promise<WebTorrentClient> {
    if (this.client) return this.client
    if (this.clientFailed !== null) throw new Error(this.clientFailed)
    const WebTorrent = await loadWebTorrent()
    const c = new WebTorrent()
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

  async destroy(): Promise<void> {
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
