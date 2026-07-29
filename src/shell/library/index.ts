import Database from 'better-sqlite3'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { CasStore, EphemeralStore, type AttachmentStore } from '../../main/store.js'
import {
  decodeManifest,
  toHex,
  type AdmissionResult,
  type Manifest
} from '../../format/index.js'

// ── Library — the admitted-things index + blob store (brief §4) ──────────────
//
// One row per admitted envelope. Ordering is by RECEIVED-AT (local clock) — the
// reader owns ordering (format rule 4); `created` is the author's claim, stored
// but not trusted. Public content lives in the on-disk CAS; decrypted SEALED
// content (spec §7.1) lives in an ephemeral in-memory store, NEVER the CAS.
//
// Fork detection (§5.3): two admitted envelopes with the same
// (author, path, seq) and different hashes are a FORK — surfaced, never silently
// deduped, because it is evidence of author misbehaviour or key compromise.

export interface ThingRow {
  envelopeHash: string
  authorScheme: string
  authorKey: string
  type: string
  progHash: string
  manifestHash: string
  receivedAt: number
  created: number
  path: string | null
  seq: number | null
  sealed: boolean
  read: boolean
  isFork: boolean
}

export interface FeedQuery {
  type?: string
  author?: string
  limit?: number
  offset?: number
}

/** Everything needed to mount an admitted thing (rebuilt from its store). */
export interface StoredThing {
  row: ThingRow
  /** The program (the thing's HTML) bytes. */
  program: Uint8Array
  manifest: Manifest
  /** The store the cage serves attachments from: the on-disk CAS for public
   *  things, the ephemeral in-memory store for sealed ones. */
  store: AttachmentStore
}

type Row = {
  envelope_hash: string
  author_scheme: string
  author_key: string
  type: string
  prog_hash: string
  manifest_hash: string
  received_at: number
  created: number
  path: string | null
  seq: number | null
  sealed: number
  read_state: number
  is_fork: number
}

function toThingRow(r: Row): ThingRow {
  return {
    envelopeHash: r.envelope_hash,
    authorScheme: r.author_scheme,
    authorKey: r.author_key,
    type: r.type,
    progHash: r.prog_hash,
    manifestHash: r.manifest_hash,
    receivedAt: r.received_at,
    created: r.created,
    path: r.path,
    seq: r.seq,
    sealed: r.sealed === 1,
    read: r.read_state === 1,
    isFork: r.is_fork === 1
  }
}

export interface AdmitStoreResult {
  envelopeHash: string
  /** True if this admission collided with an existing (author,path,seq) at a
   *  different hash — a fork. Both rows are flagged. */
  fork: boolean
  /** False if this envelope was already in the library (idempotent). */
  inserted: boolean
}

export class Library {
  private readonly db: Database.Database
  private readonly cas: CasStore
  // Decrypted SEALED content lives ONLY here — in memory, scoped to the session,
  // NEVER the on-disk CAS. Writing sealed plaintext to the persistent store
  // would silently put someone's private thing on disk in the clear.
  private readonly sealed = new EphemeralStore()

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'index.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.cas = new CasStore(dir)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS things (
        envelope_hash TEXT PRIMARY KEY,
        author_scheme TEXT NOT NULL,
        author_key    TEXT NOT NULL,
        type          TEXT NOT NULL,
        prog_hash     TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        received_at   INTEGER NOT NULL,
        created       INTEGER NOT NULL,
        path          TEXT,
        seq           INTEGER,
        sealed        INTEGER NOT NULL DEFAULT 0,
        read_state    INTEGER NOT NULL DEFAULT 0,
        is_fork       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_things_received ON things(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_things_chain ON things(author_key, path, seq);
    `)
  }

  /**
   * Store an admitted (valid) thing: persist its program + manifest +
   * attachments to the CAS, insert the index row (ordered by received-at), and
   * run fork detection. Idempotent on the envelope hash.
   */
  store(result: Extract<AdmissionResult, { status: 'valid' }>, receivedAt: number): AdmitStoreResult {
    const envelopeHash = toHex(result.envelopeHash)
    const existing = this.db.prepare('SELECT envelope_hash FROM things WHERE envelope_hash = ?').get(envelopeHash)
    if (existing) return { envelopeHash, fork: false, inserted: false }

    // Persist bytes to the right store: the on-disk CAS for public content, the
    // in-memory ephemeral store for decrypted SEALED content (never the CAS).
    const store = result.sealed ? this.sealed : this.cas
    store.put(result.program)
    store.put(result.manifestBytes)
    for (const bytes of result.attachments.values()) store.put(bytes)

    const env = result.envelope
    const authorKey = toHex(env.author.k)
    const path = env.path ?? null
    const seq = env.seq ?? null

    // Fork detection: same (author, path, seq), different envelope hash.
    let fork = false
    if (path !== null && seq !== undefined && seq !== null) {
      const clash = this.db
        .prepare('SELECT envelope_hash FROM things WHERE author_key = ? AND path = ? AND seq = ? AND envelope_hash != ?')
        .all(authorKey, path, seq, envelopeHash) as { envelope_hash: string }[]
      if (clash.length > 0) {
        fork = true
        const flag = this.db.prepare('UPDATE things SET is_fork = 1 WHERE envelope_hash = ?')
        for (const c of clash) flag.run(c.envelope_hash)
      }
    }

    this.db
      .prepare(
        `INSERT INTO things
          (envelope_hash, author_scheme, author_key, type, prog_hash, manifest_hash,
           received_at, created, path, seq, sealed, read_state, is_fork)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`
      )
      .run(
        envelopeHash,
        env.author.s,
        authorKey,
        result.manifest.type,
        toHex(result.manifest.prog),
        toHex(env.man),
        receivedAt,
        env.created,
        path,
        seq,
        result.sealed ? 1 : 0,
        fork ? 1 : 0
      )

    return { envelopeHash, fork, inserted: true }
  }

  /** The feed: admitted things, newest RECEIVED first (not by `created`). */
  feed(query: FeedQuery = {}): ThingRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (query.type) {
      where.push('type = ?')
      params.push(query.type)
    }
    if (query.author) {
      where.push('author_key = ?')
      params.push(query.author)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = query.limit ?? 200
    const offset = query.offset ?? 0
    const rows = this.db
      .prepare(`SELECT * FROM things ${clause} ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[]
    return rows.map(toThingRow)
  }

  get(envelopeHash: string): ThingRow | null {
    const r = this.db.prepare('SELECT * FROM things WHERE envelope_hash = ?').get(envelopeHash) as Row | undefined
    return r ? toThingRow(r) : null
  }

  /** Reconstruct the program + manifest + serving store for mounting a thing.
   *  Sealed content is served from the ephemeral store (in memory); a sealed
   *  thing not decrypted this session (e.g. after a restart) is unmountable. */
  load(envelopeHash: string): StoredThing | null {
    const row = this.get(envelopeHash)
    if (!row) return null
    const store: AttachmentStore = row.sealed ? this.sealed : this.cas
    const manifestBytes = store.readAll(row.manifestHash)
    const programBytes = store.readAll(row.progHash)
    if (!manifestBytes || !programBytes) return null
    return { row, program: programBytes, manifest: decodeManifest(manifestBytes), store }
  }

  markRead(envelopeHash: string, read = true): void {
    this.db.prepare('UPDATE things SET read_state = ? WHERE envelope_hash = ?').run(read ? 1 : 0, envelopeHash)
  }

  /** Content hashes a row references: program, manifest, and (decoded from the
   *  manifest) every attachment. Blobs are content-addressed and SHARED across
   *  things, so these are references, not ownership. */
  private contentHashes(r: { progHash: string; manifestHash: string; sealed: boolean }): Set<string> {
    const hashes = new Set<string>([r.progHash, r.manifestHash])
    const store: AttachmentStore = r.sealed ? this.sealed : this.cas
    const manifestBytes = store.readAll(r.manifestHash)
    if (manifestBytes) {
      try {
        for (const att of decodeManifest(manifestBytes).att.values()) hashes.add(toHex(att.h))
      } catch {
        /* undecodable manifest — GC only what the row itself names */
      }
    }
    return hashes
  }

  /**
   * Delete a thing: drop its index row, then garbage-collect content blobs no
   * longer referenced by ANY remaining thing (blobs are shared — every nametag
   * instance references the same program blob, so a blob dies only with its
   * last referrer). Returns false if the row was absent.
   */
  delete(envelopeHash: string): boolean {
    const row = this.get(envelopeHash)
    if (!row) return false
    // Candidates BEFORE the row goes (the manifest must still be readable).
    const candidates = this.contentHashes(row)
    this.db.prepare('DELETE FROM things WHERE envelope_hash = ?').run(envelopeHash)
    const referenced = new Set<string>()
    const remaining = this.db.prepare('SELECT prog_hash, manifest_hash, sealed FROM things').all() as {
      prog_hash: string
      manifest_hash: string
      sealed: number
    }[]
    for (const r of remaining) {
      for (const h of this.contentHashes({ progHash: r.prog_hash, manifestHash: r.manifest_hash, sealed: r.sealed === 1 })) {
        referenced.add(h)
      }
    }
    for (const h of candidates) {
      if (referenced.has(h)) continue
      this.cas.delete(h)
      this.sealed.delete(h)
    }
    return true
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM things').get() as { n: number }).n
  }

  /** The CAS store handle, for the mount layer to serve attachments. */
  get casStore(): CasStore {
    return this.cas
  }

  close(): void {
    this.db.close()
  }
}
