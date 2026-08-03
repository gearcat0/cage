import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
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

/** Ids of local drafts are namespaced so they can never be confused with an
 *  envelope hash (which is 64 hex chars and means "signed and admitted"). */
export const DRAFT_ID_PREFIX = 'draft:'
export const isDraftId = (id: string): boolean => id.startsWith(DRAFT_ID_PREFIX)

/** A local, unsigned draft: a program + the args typed so far. Never signed,
 *  never seeded, never shared. */
export interface DraftRow {
  id: string
  type: string
  progHash: string
  /** Whatever the program last streamed; null until it streams anything. */
  args: unknown
  created: number
  updated: number
}

/** A program type the user can make something of: distinct (type, program). */
export interface KnownType {
  type: string
  progHash: string
  /** How many things in the library use this exact (type, program). */
  count: number
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

type DraftDbRow = {
  id: string
  type: string
  prog_hash: string
  args_json: string | null
  created: number
  updated: number
}

function toDraftRow(r: DraftDbRow): DraftRow {
  let args: unknown = null
  if (r.args_json !== null) {
    try {
      args = JSON.parse(r.args_json)
    } catch {
      args = null // unreadable args degrade to "blank", never to a broken draft
    }
  }
  return { id: r.id, type: r.type, progHash: r.prog_hash, args, created: r.created, updated: r.updated }
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

      -- Local, UNSIGNED drafts: work in progress that has never been signed and
      -- never left this machine. Deliberately a separate table, not a column on
      -- the things table -- migrate() is idempotent CREATE-IF-NOT-EXISTS with
      -- no version column, so an added column would silently not apply to
      -- existing libraries, while a new table is created on next open.
      CREATE TABLE IF NOT EXISTS drafts (
        id        TEXT PRIMARY KEY,
        type      TEXT NOT NULL,
        prog_hash TEXT NOT NULL,
        args_json TEXT,
        created   INTEGER NOT NULL,
        updated   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated DESC);
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
    this.gc(candidates)
    return true
  }

  /** Every content hash still referenced by ANY thing or ANY draft. Drafts are
   *  not in `things` but DO reference their program blob — scanning only
   *  `things` would collect the program out from under a live draft. */
  private referencedHashes(): Set<string> {
    const referenced = new Set<string>()
    const rows = this.db.prepare('SELECT prog_hash, manifest_hash, sealed FROM things').all() as {
      prog_hash: string
      manifest_hash: string
      sealed: number
    }[]
    for (const r of rows) {
      for (const h of this.contentHashes({ progHash: r.prog_hash, manifestHash: r.manifest_hash, sealed: r.sealed === 1 })) {
        referenced.add(h)
      }
    }
    for (const d of this.db.prepare('SELECT prog_hash FROM drafts').all() as { prog_hash: string }[]) {
      referenced.add(d.prog_hash)
    }
    return referenced
  }

  /** Drop candidate blobs that nothing references any more. */
  private gc(candidates: Set<string>): void {
    const referenced = this.referencedHashes()
    for (const h of candidates) {
      if (referenced.has(h)) continue
      this.cas.delete(h)
      this.sealed.delete(h)
    }
  }

  // ── Drafts ─────────────────────────────────────────────────────────────────

  /** Program types the user can create something of: distinct (type, program)
   *  across the library. Sealed things are excluded — their program lives only
   *  in the in-memory store, so a draft made from one would be unmountable
   *  after a restart (and copying those bytes to the CAS would put sealed
   *  plaintext on disk). */
  distinctTypes(): KnownType[] {
    const rows = this.db
      .prepare(
        `SELECT type, prog_hash, COUNT(*) AS n, MAX(received_at) AS recent
         FROM things WHERE sealed = 0
         GROUP BY type, prog_hash
         ORDER BY recent DESC`
      )
      .all() as { type: string; prog_hash: string; n: number }[]
    return rows
      .filter((r) => this.cas.has(r.prog_hash))
      .map((r) => ({ type: r.type, progHash: r.prog_hash, count: r.n }))
  }

  createDraft(input: { type: string; progHash: string; now?: number }): DraftRow {
    const now = input.now ?? Date.now()
    const row: DraftRow = {
      id: `${DRAFT_ID_PREFIX}${randomUUID()}`,
      type: input.type,
      progHash: input.progHash,
      args: null,
      created: now,
      updated: now
    }
    this.db
      .prepare('INSERT INTO drafts (id, type, prog_hash, args_json, created, updated) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.type, row.progHash, null, now, now)
    return row
  }

  listDrafts(): DraftRow[] {
    const rows = this.db.prepare('SELECT * FROM drafts ORDER BY updated DESC').all() as DraftDbRow[]
    return rows.map(toDraftRow)
  }

  getDraft(id: string): DraftRow | null {
    const r = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(id) as DraftDbRow | undefined
    return r ? toDraftRow(r) : null
  }

  /** Persist the args (and current type) a draft's program last streamed. */
  updateDraftArgs(id: string, args: unknown, type: string, now = Date.now()): boolean {
    let json: string
    try {
      json = JSON.stringify(args ?? null)
    } catch {
      return false
    }
    const r = this.db
      .prepare('UPDATE drafts SET args_json = ?, type = ?, updated = ? WHERE id = ?')
      .run(json, type, now, id)
    return r.changes > 0
  }

  /** Delete a draft and GC its program blob if nothing else references it. */
  deleteDraft(id: string): boolean {
    const row = this.getDraft(id)
    if (!row) return false
    this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
    this.gc(new Set([row.progHash]))
    return true
  }

  /** Store program bytes in the CAS (idempotent) and return their hash. */
  putProgram(bytes: Uint8Array): string {
    return this.cas.put(bytes)
  }

  /** Read program bytes by hash — no envelope, no row required. */
  readProgram(progHash: string): Uint8Array | null {
    return this.cas.readAll(progHash)
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
