import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { CasStore, EphemeralStore, type AttachmentStore } from '../../main/store.js'
import { claimedTitle } from './title.js'
import { SHELL_PINNED_KEYS, pinsOf, type Pins } from './pins.js'
import { claimedKey } from './keys.js'
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
  /** YOUR name for the author, if you have given one. Local, never in a thing,
   *  and never a substitute for a verified name — see the chrome. */
  petname?: string | null
  /** What the thing CALLS ITSELF -- a sanitized line out of its args, so the
   *  author's claim and nothing more (see title.ts). Null when it offers none,
   *  and always null for a sealed thing: its words never reach sqlite. */
  title?: string | null
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
  /** Only on a rolled-up feed: how much conversation sits under this thing.
   *  `replies` counts the whole subtree, not just direct answers, because
   *  "12 replies" on a thread that is 12 deep should not read as 1. */
  activity?: { replies: number; up: number; down: number }
  /** How many envelopes sign this row's manifest, and whether the document
   *  names signatories at all. Only meaningful together: a plain thing copied
   *  twice also has two signatures over one manifest, and is not a contract. */
  signatures?: number
  cosignable?: boolean
}

/** A thing a relay says exists that you do not hold.
 *
 *  The mirror image of a draft: a draft is a thing you have and have not
 *  signed; an offer is a thing signed that you do not have. Both are rows the
 *  feed shows that are not library things.
 *
 *  `type`, `inGroup` and `replyTo` come from the EVENT, so they are the
 *  poster's claims about something nobody here has read yet. There is
 *  deliberately no author: the event names a nostr key, and who signed the
 *  thing is inside an envelope that has not arrived. */
export interface OfferRow {
  envelopeHash: string
  locator: string
  relayUrl: string
  /** The nostr key that posted the event. NOT the author. */
  poster: string
  type: string
  inGroup: string | null
  replyTo: string | null
  state: 'offered' | 'fetching' | 'failed'
  reason: string
  transferId: string | null
  seenAt: number
}

type OfferDbRow = {
  envelope_hash: string
  locator: string
  relay_url: string
  poster: string
  type: string
  in_group: string | null
  reply_to: string | null
  state: string
  reason: string
  transfer_id: string | null
  seen_at: number
}

const toOfferRow = (r: OfferDbRow): OfferRow => ({
  envelopeHash: r.envelope_hash,
  locator: r.locator,
  relayUrl: r.relay_url,
  poster: r.poster,
  type: r.type,
  inGroup: r.in_group,
  replyTo: r.reply_to,
  state: r.state === 'fetching' || r.state === 'failed' ? r.state : 'offered',
  reason: r.reason,
  transferId: r.transfer_id,
  seenAt: r.seen_at
})

export interface FeedQuery {
  type?: string
  author?: string
  /** Only things that CLAIM to reply to this envelope hash. */
  replyTo?: string
  /** Things claiming to attest to this envelope hash. */
  attests?: string
  /** Things claiming to vote on this envelope hash. */
  votesOn?: string
  /** Things claiming to belong to this group (a forum's root hash). */
  inGroup?: string
  /** Fold the feed to what is worth its own row: a vote is activity rather
   *  than content, and a reply belongs under the thing it answers. Off by
   *  default so every existing caller keeps the flat list it asked for. */
  rollUp?: boolean
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

/** The relations the shell indexes, which are also the args field names that
 *  carry them. Every one is an author CLAIM and none is verified: anyone may
 *  claim to reply to, attest to, or vote on anything at all, and anyone may
 *  claim their thing belongs to any group. The shell indexes the claim so a
 *  thing can show what points at it; it never treats one as evidence.
 *
 *  `inGroup` is the one that reads like membership and is not: a group's
 *  roster never consented to what gets tagged into it. What keeps that from
 *  mattering is that ranking and moderation both run through keys YOU reached
 *  -- see tribe() and the moderator roles a roster declares. */
export const INDEXED_RELS = ['replyTo', 'attests', 'votesOn', 'inGroup'] as const
export type IndexedRel = (typeof INDEXED_RELS)[number]

// A relation the library indexes is one only the shell can seed, so it must be
// one the shell keeps in a draft (pins.ts). Adding a rel here and forgetting it
// there would bring back the bug pins exist for -- a pointer silently dropped by
// the first keystroke -- so it is a refusal to start rather than a comment.
for (const rel of INDEXED_RELS) {
  if (!SHELL_PINNED_KEYS.includes(rel)) throw new Error(`INDEXED_RELS has '${rel}' but pins.ts does not pin it`)
}

/** Read a string field out of untrusted args (Map or plain object). */
function argString(args: unknown, key: string): string {
  const v =
    args instanceof Map
      ? args.get(key)
      : args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)[key]
        : undefined
  return typeof v === 'string' ? v : ''
}

/** The key a vouch is about, if its args name one. Keys are scheme-specific,
 *  so this only checks it is plausible hex of a sane length -- the shell never
 *  invents a key, it only indexes what the author claimed. */
export function vouchSubject(args: unknown): { scheme: string; key: string } | null {
  const key = claimedKey(argString(args, 'about'))
  if (!key) return null
  const scheme = argString(args, 'aboutScheme') || 'eth-eip191'
  return { scheme, key }
}

/** What a vote CLAIMS: which thing, and which way.
 *
 *  Direction is exactly +1 or -1. Anything else -- 0, 7, a string, a float
 *  (which canonical CBOR refuses outright) -- is not a vote, it is program
 *  data, and is ignored rather than coerced into one. A weight a program could
 *  choose would make a single key worth as much as it liked. */
export function voteClaim(args: unknown): { target: string; dir: 1 | -1 } | null {
  const target = refTarget(args, 'votesOn')
  if (!target) return null
  const raw =
    args instanceof Map
      ? args.get('dir')
      : args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>).dir
        : undefined
  if (raw !== 1 && raw !== -1) return null
  return { target, dir: raw }
}

/** One signatory a document NAMES. A claim by whoever wrote the manifest --
 *  being named is not consent and is emphatically not a signature. */
export interface DeclaredSigner {
  scheme: string
  key: string
  role: string
  name: string
}

/** The signatories a manifest declares, if it declares any.
 *
 *  Presence of this list is what makes a document co-signable: an ordinary
 *  thing has no signatories, and must never be dressed up as a contract
 *  awaiting signatures. The list lives in the MANIFEST, so it is covered by
 *  every signature over that manifest -- nobody can quietly add themselves to
 *  the named parties without producing a different document. */
export function declaredSigners(args: unknown, field = 'signers'): DeclaredSigner[] {
  const raw =
    args instanceof Map
      ? args.get(field)
      : args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)[field]
        : undefined
  if (!Array.isArray(raw)) return []
  const out: DeclaredSigner[] = []
  for (const entry of raw.slice(0, 64)) {
    const key = claimedKey(argString(entry, 'key'))
    if (!key) continue // junk is program data, not a party
    out.push({
      scheme: argString(entry, 'scheme') || 'eth-eip191',
      key,
      role: argString(entry, 'role').slice(0, 64),
      name: argString(entry, 'name').slice(0, 128)
    })
  }
  return out
}

/** The reference a manifest's args CLAIM, or null. Pure and shared by store()
 *  and the header so the index and the UI can never disagree. Only a bare
 *  64-hex string counts — anything else is just program data. */
export function refTarget(args: unknown, rel = 'replyTo'): string | null {
  if (args instanceof Map) {
    const v = args.get(rel)
    return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null
  }
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const v = (args as Record<string, unknown>)[rel]
    return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null
  }
  return null
}

/** One attachment a draft is holding (bytes in the CAS, keyed by hash). */
export interface DraftBlobRow {
  name: string
  hash: string
  mime: string
  size: number
}

/** What to store for a draft's attachment. `bytes` is LAZY: it is called only
 *  when the CAS does not already hold the hash, so an unchanged 3 MB image is
 *  never re-read on an autosave. */
export interface DraftBlobInput extends DraftBlobRow {
  bytes: () => Uint8Array
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
    isFork: r.is_fork === 1,
    // Your name for the author, when the query joined it. Local only; a row
    // read without the join simply has none.
    petname: (r as Row & { petname?: string | null }).petname ?? null,
    title: (r as Row & { title?: string | null }).title ?? null,
    signatures: (r as Row & { signatures?: number }).signatures ?? 1,
    cosignable: ((r as Row & { cosignable?: number }).cosignable ?? 0) === 1
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

  constructor(dir: string, opts: { maxOffers?: number } = {}) {
    if (opts.maxOffers !== undefined && opts.maxOffers > 0) this.maxOffers = opts.maxOffers
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

      -- Attachments a draft is holding. The BYTES live in the CAS (content-
      -- addressed, shared with published things); this table is the draft's
      -- reference to them, so referencedHashes() must scan it or publishing
      -- one draft would collect an image another draft still needs.
      CREATE TABLE IF NOT EXISTS draft_blobs (
        draft_id TEXT NOT NULL,
        name     TEXT NOT NULL,
        hash     TEXT NOT NULL,
        mime     TEXT NOT NULL,
        size     INTEGER NOT NULL,
        PRIMARY KEY (draft_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_draft_blobs_hash ON draft_blobs(hash);

      -- A reference one admitted thing CLAIMS to make to another. An author
      -- claim exactly like the created timestamp (format rule 4): anyone may
      -- claim to reply to anything, and the target's author never consented.
      -- The shell
      -- verifies the hex SHAPE only; whether the target is present locally is
      -- a separate fact the UI states honestly.
      CREATE TABLE IF NOT EXISTS refs (
        envelope_hash TEXT NOT NULL,
        rel           TEXT NOT NULL,
        target_hash   TEXT NOT NULL,
        PRIMARY KEY (envelope_hash, rel, target_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target_hash, rel);

      -- Which things this shell is SERVING to peers. Local bookkeeping only:
      -- it never enters a thing, and it says nothing about who has fetched
      -- one. A new table, not a column on things -- migrate() is idempotent
      -- CREATE-IF-NOT-EXISTS with no version column, so an added column would
      -- silently not apply to an existing library.
      CREATE TABLE IF NOT EXISTS seeding (
        envelope_hash TEXT PRIMARY KEY,
        magnet        TEXT NOT NULL,
        started_at    INTEGER NOT NULL
      );

      -- Signed statements about a KEY, not about a thing -- which is why they
      -- cannot live in the refs table: that indexes 64-hex envelope hashes, and
      -- these point at author keys. Indexed from the args at admission, like
      -- refs, and skipped for sealed things for the same reason.
      -- (No backticks in here: this is inside a JS template literal.)
      CREATE TABLE IF NOT EXISTS vouches (
        envelope_hash  TEXT PRIMARY KEY,
        voucher_scheme TEXT NOT NULL,
        voucher_key    TEXT NOT NULL,
        about_scheme   TEXT NOT NULL,
        about_key      TEXT NOT NULL,
        name           TEXT NOT NULL DEFAULT '',
        relation       TEXT NOT NULL DEFAULT '',
        created        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vouches_about ON vouches(about_scheme, about_key);
      CREATE INDEX IF NOT EXISTS idx_vouches_voucher ON vouches(voucher_scheme, voucher_key);

      -- A vote on a THING (not on a key -- that is a vouch, and conflating the
      -- two would make every upvote a one-hop trust edge). refs already records
      -- that a vote points at something; this carries the direction refs has no
      -- column for, and the created stamp that decides which of a voter's
      -- votes is their current word.
      CREATE TABLE IF NOT EXISTS votes (
        envelope_hash TEXT PRIMARY KEY,
        voter_scheme  TEXT NOT NULL,
        voter_key     TEXT NOT NULL,
        target_hash   TEXT NOT NULL,
        dir           INTEGER NOT NULL,
        created       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_hash);
      CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter_scheme, voter_key);

      -- What YOU call a key. Local, and deliberately so: a petname is the one
      -- kind of name nobody else can influence -- an author may claim any name
      -- they like and may even prove an ENS name, but they cannot make you
      -- call them anything. It never enters a thing and never leaves here.
      CREATE TABLE IF NOT EXISTS petnames (
        author_scheme TEXT NOT NULL,
        author_key    TEXT NOT NULL,
        name          TEXT NOT NULL,
        note          TEXT NOT NULL DEFAULT '',
        set_at        INTEGER NOT NULL,
        PRIMARY KEY (author_scheme, author_key)
      );

      -- Co-signing: several envelopes over ONE manifest. The document is the
      -- manifest; an envelope is a single signature over it. Finding a
      -- document's other signatures is therefore a manifest_hash lookup, which
      -- needs an index -- CREATE INDEX is allowed where ALTER is not.
      CREATE INDEX IF NOT EXISTS idx_things_manifest ON things(manifest_hash);

      -- The signatories a document NAMES, keyed by the manifest they are named
      -- in. A claim by whoever wrote it: being named is not consent, and not a
      -- signature. Its presence is also what marks a manifest as a document
      -- meant to be co-signed at all.
      CREATE TABLE IF NOT EXISTS doc_signers (
        manifest_hash TEXT NOT NULL,
        idx           INTEGER NOT NULL,
        scheme        TEXT NOT NULL,
        key           TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT '',
        name          TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (manifest_hash, idx)
      );

      -- Downloads the human has ASKED FOR, which is a different thing from a
      -- download that is currently running. Like the seeding table above, a row
      -- is an INTENT: it survives a quit so the next start resumes rather than
      -- beginning again, and a failure to resume is not a decision to stop.
      -- Progress, speed and peer counts are deliberately NOT here -- they are
      -- properties of a live torrent and are meaningless on disk.
      CREATE TABLE IF NOT EXISTS transfers (
        id        TEXT PRIMARY KEY,
        magnet    TEXT NOT NULL,
        info_hash TEXT NOT NULL,
        name      TEXT NOT NULL DEFAULT '',
        added_at  INTEGER NOT NULL
      );

      -- What each version claims to follow. The prev field on an envelope has
      -- never been checked by anything -- an author claim, like created. Kept
      -- here so it CAN be checked against the chain's own order, and a version
      -- that points somewhere else can be said to.
      CREATE TABLE IF NOT EXISTS thing_prev (
        envelope_hash TEXT PRIMARY KEY,
        prev          TEXT NOT NULL
      );

      -- What each thing calls itself, for the feed. Derived from args at store
      -- time (title.ts) so a feed of 200 rows decodes no manifests. Its own
      -- table rather than a column on things: CREATE is allowed where ALTER is
      -- not. PUBLIC things only -- a sealed thing's words never reach sqlite.
      CREATE TABLE IF NOT EXISTS titles (
        envelope_hash TEXT PRIMARY KEY,
        title         TEXT NOT NULL
      );

      -- What a draft is AMENDING, until it is published and the envelope
      -- carries it instead. A separate table because the drafts table cannot
      -- gain columns (no schema versioning), and because most drafts amend
      -- nothing. (No backticks in here: this is a JS template literal.)
      CREATE TABLE IF NOT EXISTS draft_chain (
        draft_id TEXT PRIMARY KEY,
        path     TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        prev     TEXT NOT NULL
      );

      -- The pointers the SHELL seeded into a draft (replyTo, inGroup, ...),
      -- kept apart from args_json because args are replaced whole by every
      -- draft the program emits, and these must outlive that. See pins.ts.
      CREATE TABLE IF NOT EXISTS draft_pins (
        draft_id  TEXT PRIMARY KEY,
        pins_json TEXT NOT NULL
      );

      -- Who a group LISTS. Keyed by envelope hash, so it records a particular
      -- VERSION of a roster -- being in version 1 of a group you were removed
      -- from in version 2 is not membership, and the query resolves to the
      -- latest version of each chain for exactly that reason.
      CREATE TABLE IF NOT EXISTS group_members (
        envelope_hash TEXT NOT NULL,
        idx           INTEGER NOT NULL,
        scheme        TEXT NOT NULL,
        key           TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT '',
        name          TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (envelope_hash, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_group_members_key ON group_members(scheme, key);

      -- Relays this shell talks to, and how far through each subscription it
      -- has read. The cursor matters: without it a reconnect re-ingests the
      -- relay's whole history every time.
      CREATE TABLE IF NOT EXISTS relays (
        url      TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relay_cursor (
        sub_id TEXT PRIMARY KEY,
        since  INTEGER NOT NULL
      );
      -- A thing a relay says exists that we do NOT hold: the event carried a
      -- hash and a locator instead of bytes, because the bundle was over the
      -- inline cap. Nothing is fetched until a human presses Fetch, so this is
      -- the record of what is on offer in the meantime.
      --
      -- type/group/reply_to are the POSTER'S hints, not facts. The author is
      -- deliberately absent: the event names a nostr key, and who signed the
      -- thing is inside an envelope nobody has yet.
      CREATE TABLE IF NOT EXISTS offers (
        envelope_hash TEXT PRIMARY KEY,
        locator       TEXT NOT NULL,
        relay_url     TEXT NOT NULL DEFAULT '',
        poster        TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT '',
        in_group      TEXT,
        reply_to      TEXT,
        state         TEXT NOT NULL DEFAULT 'offered',
        reason        TEXT NOT NULL DEFAULT '',
        transfer_id   TEXT,
        seen_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_offers_group ON offers(in_group);

      -- Who offered us a thing on a relay. Posting is NOT authoring: anyone
      -- may rebroadcast anything, so this records the messenger separately
      -- from the author the signature names, and never in place of them.
      -- The encryption key an author bound to a thing (Author.e/ek). Its whole
      -- job is to answer "is the key that posted this the key that signed it?"
      CREATE TABLE IF NOT EXISTS thing_enc (
        envelope_hash TEXT PRIMARY KEY,
        scheme        TEXT NOT NULL,
        key           TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relay_arrivals (
        envelope_hash TEXT NOT NULL,
        relay_url     TEXT NOT NULL,
        poster        TEXT NOT NULL,
        self_posted   INTEGER NOT NULL DEFAULT 0,
        at            INTEGER NOT NULL,
        PRIMARY KEY (envelope_hash, relay_url, poster)
      );

      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `)
    this.backfillRefs()
    this.backfillTitles()
    this.backfillParties()
  }

  /** A one-way marker for something that must happen at most once per library
   *  (the first-run welcome). Kept beside the data it describes, so copying or
   *  restoring a profile carries the answer with it. */
  hasFlag(k: string): boolean {
    return this.metaGet(`flag:${k}`) !== null
  }

  setFlag(k: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(`flag:${k}`, '1')
  }

  /** A small setting that belongs to this library, like whether the human
   *  agreed to update checks. Same table as the flags, under `setting:`. */
  getSetting(k: string): string | null {
    return this.metaGet(`setting:${k}`)
  }

  setSetting(k: string, v: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(`setting:${k}`, v)
  }

  private metaGet(k: string): string | null {
    const r = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
    return r ? r.v : null
  }

  /** One-time pass so libraries that predate the refs table get their existing
   *  claims indexed. Public things only — a sealed thing's manifest lives in
   *  the in-memory store and is deliberately unreadable here. Never allowed to
   *  make the library unopenable: a bad manifest is skipped. */
  private backfillRefs(): void {
    // The pass runs again whenever INDEXED_RELS grows: a library that ran an
    // earlier version has never looked for the new relations, so things it
    // already holds would stay invisible to them. v2 added `attests`; v3 adds
    // `votesOn` and `inGroup`.
    if (this.metaGet('refs_backfill_v3')) return
    try {
      const rows = this.db
        .prepare(
          'SELECT envelope_hash, author_scheme, author_key, type, created, manifest_hash FROM things WHERE sealed = 0'
        )
        .all() as {
        envelope_hash: string
        author_scheme: string
        author_key: string
        type: string
        created: number
        manifest_hash: string
      }[]
      const insert = this.db.prepare('INSERT OR IGNORE INTO refs (envelope_hash, rel, target_hash) VALUES (?,?,?)')
      // Votes carry a direction refs cannot hold, so the same pass rebuilds
      // them too. Otherwise a vote admitted before this version existed would
      // be indexed as pointing at something, with nobody able to say which way.
      const insertVote = this.db.prepare(
        `INSERT OR IGNORE INTO votes (envelope_hash, voter_scheme, voter_key, target_hash, dir, created)
         VALUES (?,?,?,?,?,?)`
      )
      this.db.transaction(() => {
        for (const r of rows) {
          const bytes = this.cas.readAll(r.manifest_hash)
          if (!bytes) continue
          try {
            const args = decodeManifest(bytes).args
            for (const rel of INDEXED_RELS) {
              const t = refTarget(args, rel)
              if (t) insert.run(r.envelope_hash, rel, t)
            }
            if (r.type === 'vote') {
              const claim = voteClaim(args)
              if (claim) {
                insertVote.run(r.envelope_hash, r.author_scheme, r.author_key, claim.target, claim.dir, r.created)
              }
            }
          } catch {
            /* undecodable manifest — skip it, never fail the open */
          }
        }
      })()
    } catch {
      /* backfill is best-effort; the library must still open */
    }
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('refs_backfill_v3', '1')
  }

  /** Rosters, named signatories and vouches are indexed when a thing is stored,
   *  so a thing stored while `0x`-prefixed keys were being dropped is missing
   *  its people for good -- including, for whoever keeps a forum, themselves.
   *  Re-read them once. INSERT OR REPLACE throughout, so a row that was indexed
   *  correctly the first time is simply written again. Same rules as the other
   *  passes: public things only, best-effort, never allowed to stop the open. */
  private backfillParties(): void {
    if (this.metaGet('parties_backfill_v1')) return
    try {
      const rows = this.db
        .prepare(
          `SELECT envelope_hash, author_scheme, author_key, type, created, manifest_hash
             FROM things WHERE sealed = 0`
        )
        .all() as { envelope_hash: string; author_scheme: string; author_key: string; type: string; created: number; manifest_hash: string }[]
      const member = this.db.prepare(
        'INSERT OR REPLACE INTO group_members (envelope_hash, idx, scheme, key, role, name) VALUES (?,?,?,?,?,?)'
      )
      const signer = this.db.prepare(
        'INSERT OR REPLACE INTO doc_signers (manifest_hash, idx, scheme, key, role, name) VALUES (?,?,?,?,?,?)'
      )
      const vouch = this.db.prepare(
        `INSERT OR REPLACE INTO vouches
           (envelope_hash, voucher_scheme, voucher_key, about_scheme, about_key, name, relation, created)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      this.db.transaction(() => {
        for (const r of rows) {
          const bytes = this.cas.readAll(r.manifest_hash)
          if (!bytes) continue
          try {
            const args = decodeManifest(bytes).args
            declaredSigners(args).forEach((sg, i) => signer.run(r.manifest_hash, i, sg.scheme, sg.key, sg.role, sg.name))
            if (r.type === 'group') {
              declaredSigners(args, 'members').forEach((m, i) => member.run(r.envelope_hash, i, m.scheme, m.key, m.role, m.name))
            }
            if (r.type === 'vouch') {
              const subject = vouchSubject(args)
              if (subject) {
                vouch.run(
                  r.envelope_hash,
                  r.author_scheme,
                  r.author_key,
                  subject.scheme,
                  subject.key,
                  argString(args, 'name'),
                  argString(args, 'relation'),
                  r.created
                )
              }
            }
          } catch {
            /* undecodable manifest — skip it, never fail the open */
          }
        }
      })()
    } catch {
      /* backfill is best-effort; the library must still open */
    }
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('parties_backfill_v1', '1')
  }

  /** Libraries from before titles existed hold things that have never been
   *  asked what they call themselves. Same shape and the same rule as the refs
   *  pass: public things only, best-effort, never allowed to stop the open.
   *  Versioned so that a change to what counts as a title can re-run it. */
  private backfillTitles(): void {
    if (this.metaGet('titles_backfill_v1')) return
    try {
      const rows = this.db.prepare('SELECT envelope_hash, manifest_hash FROM things WHERE sealed = 0').all() as {
        envelope_hash: string
        manifest_hash: string
      }[]
      const insert = this.db.prepare('INSERT OR REPLACE INTO titles (envelope_hash, title) VALUES (?,?)')
      this.db.transaction(() => {
        for (const r of rows) {
          const bytes = this.cas.readAll(r.manifest_hash)
          if (!bytes) continue
          try {
            const title = claimedTitle(decodeManifest(bytes).args)
            if (title) insert.run(r.envelope_hash, title)
          } catch {
            /* undecodable manifest — skip it, never fail the open */
          }
        }
      })()
    } catch {
      /* backfill is best-effort; the library must still open */
    }
    this.db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('titles_backfill_v1', '1')
  }

  /** How many things in this library claim to reply to `targetHash`. */
  countRefsTo(targetHash: string, rel = 'replyTo'): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM refs WHERE target_hash = ? AND rel = ?')
      .get(targetHash, rel) as { n: number }
    return r.n
  }

  // ── Draft attachments ──────────────────────────────────────────────────────

  draftBlobs(draftId: string): DraftBlobRow[] {
    return this.db
      .prepare('SELECT name, hash, mime, size FROM draft_blobs WHERE draft_id = ? ORDER BY name')
      .all(draftId) as DraftBlobRow[]
  }

  /** Replace a draft's whole attachment set, mirroring the emit contract (one
   *  emit carries the complete set). Returns false without writing anything if
   *  the draft is gone — a late autosave flush must never resurrect a row the
   *  user just discarded, which would pin CAS bytes with no owner. */
  setDraftBlobs(draftId: string, entries: DraftBlobInput[]): boolean {
    const exists = this.db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(draftId)
    if (!exists) return false
    const current = this.draftBlobs(draftId)
    const key = (b: DraftBlobRow): string => `${b.name}\u0000${b.hash}\u0000${b.mime}\u0000${b.size}`
    const same =
      current.length === entries.length && new Set(current.map(key)).size === new Set(entries.map(key)).size &&
      current.every((c) => entries.some((e) => key(e) === key(c)))
    if (same) return true
    // Write bytes BEFORE the row swap, and only for hashes we do not hold.
    for (const e of entries) {
      if (this.cas.has(e.hash)) continue
      try {
        this.cas.put(e.bytes())
      } catch {
        return false // never leave a half-written set
      }
    }
    const oldHashes = new Set(current.map((c) => c.hash))
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM draft_blobs WHERE draft_id = ?').run(draftId)
      const ins = this.db.prepare('INSERT INTO draft_blobs (draft_id, name, hash, mime, size) VALUES (?,?,?,?,?)')
      for (const e of entries) ins.run(draftId, e.name, e.hash, e.mime, e.size)
    })()
    // GC only AFTER the swap, and only what this draft dropped.
    for (const e of entries) oldHashes.delete(e.hash)
    if (oldHashes.size > 0) this.gc(oldHashes)
    return true
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

    // Index the reference this thing CLAIMS to make. Sealed things are skipped
    // on purpose: their decrypted metadata must never reach sqlite.
    if (!result.sealed) {
      const insertRef = this.db.prepare(
        'INSERT OR IGNORE INTO refs (envelope_hash, rel, target_hash) VALUES (?,?,?)'
      )
      for (const rel of INDEXED_RELS) {
        const target = refTarget(result.manifest.args, rel)
        if (target) insertRef.run(envelopeHash, rel, target)
      }
      // The signatories this document names. Keyed by MANIFEST, not envelope:
      // every signature over the same manifest names the same parties, so a
      // second co-signature rewrites identical rows rather than adding any.
      const named = declaredSigners(result.manifest.args)
      if (named.length > 0) {
        const insertSigner = this.db.prepare(
          `INSERT OR REPLACE INTO doc_signers (manifest_hash, idx, scheme, key, role, name)
           VALUES (?,?,?,?,?,?)`
        )
        const manifestHash = toHex(env.man)
        named.forEach((sg, i) => insertSigner.run(manifestHash, i, sg.scheme, sg.key, sg.role, sg.name))
      }

      // The encryption key the author BOUND to this thing (Author.e/ek, §5.2),
      // when there is one. Covered by the signature, so it is the author
      // saying which other key speaks for them -- which is the only way to
      // tell "the author posted this" from "somebody relayed it".
      if (env.author.e && env.author.ek) {
        this.db
          .prepare('INSERT OR REPLACE INTO thing_enc (envelope_hash, scheme, key) VALUES (?,?,?)')
          .run(envelopeHash, env.author.e, toHex(env.author.ek))
      }

      // What it calls itself, for the feed. A claim like the rest of args, and
      // sanitized before it is ever stored: see title.ts for the terms.
      const title = claimedTitle(result.manifest.args)
      if (title) {
        this.db.prepare('INSERT OR REPLACE INTO titles (envelope_hash, title) VALUES (?,?)').run(envelopeHash, title)
      }

      // What this version claims to follow, so the claim can be checked later.
      if (env.prev) {
        this.db
          .prepare('INSERT OR REPLACE INTO thing_prev (envelope_hash, prev) VALUES (?,?)')
          .run(envelopeHash, toHex(env.prev))
      }

      // Who a group LISTS. Same shape as a contract's signers, and the same
      // standing: the author's claim about who belongs, never their consent.
      if (result.manifest.type === 'group') {
        const members = declaredSigners(result.manifest.args, 'members')
        if (members.length > 0) {
          const insertMember = this.db.prepare(
            `INSERT OR REPLACE INTO group_members (envelope_hash, idx, scheme, key, role, name)
             VALUES (?,?,?,?,?,?)`
          )
          members.forEach((m, i) => insertMember.run(envelopeHash, i, m.scheme, m.key, m.role, m.name))
        }
      }

      // A vote: same shape as a vouch and for the same reason. The VOTER is
      // the signer, taken from the envelope where it cannot be faked; what the
      // vote is about, and which way, are args and therefore their claim.
      if (result.manifest.type === 'vote') {
        const claim = voteClaim(result.manifest.args)
        if (claim) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO votes
                 (envelope_hash, voter_scheme, voter_key, target_hash, dir, created)
               VALUES (?,?,?,?,?,?)`
            )
            .run(envelopeHash, env.author.s, authorKey, claim.target, claim.dir, env.created)
        }
      }

      // A vouch: the SIGNER is the voucher (from the envelope, so it cannot be
      // faked), the subject comes from the args (so it is their claim).
      if (result.manifest.type === 'vouch') {
        const subject = vouchSubject(result.manifest.args)
        if (subject) {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO vouches
                 (envelope_hash, voucher_scheme, voucher_key, about_scheme, about_key, name, relation, created)
               VALUES (?,?,?,?,?,?,?,?)`
            )
            .run(
              envelopeHash,
              env.author.s,
              authorKey,
              subject.scheme,
              subject.key,
              argString(result.manifest.args, 'name'),
              argString(result.manifest.args, 'relation'),
              env.created
            )
        }
      }
    }

    return { envelopeHash, fork, inserted: true }
  }

  /** The feed: admitted things, newest RECEIVED first (not by `created`). */
  feed(query: FeedQuery = {}): ThingRow[] {
    const where: string[] = []
    const params: unknown[] = []
    // QUALIFIED: petnames carries author_key/author_scheme too, so an
    // unqualified column here silently stops filtering once that join exists.
    if (query.type) {
      where.push('t.type = ?')
      params.push(query.type)
    }
    if (query.author) {
      where.push('t.author_key = ?')
      params.push(query.author)
    }
    let join = ''
    // Both relations are claims pointing AT a thing; only the rel differs.
    const refFilter = query.replyTo
      ? { rel: 'replyTo', target: query.replyTo }
      : query.attests
        ? { rel: 'attests', target: query.attests }
        : query.votesOn
          ? { rel: 'votesOn', target: query.votesOn }
          : query.inGroup
            ? { rel: 'inGroup', target: query.inGroup }
            : null
    if (refFilter) {
      join = ' JOIN refs r ON r.envelope_hash = t.envelope_hash'
      where.push('r.rel = ?', 'r.target_hash = ?')
      params.push(refFilter.rel, refFilter.target)
    }
    // Collapse a co-signed DOCUMENT to one row. Four signatures over one
    // contract are four things -- and the library still stores four rows --
    // but they are one document, and listing it four times would be a worse
    // lie than showing it once. Scoped to declared documents only, so an
    // ordinary Copy (which also shares a manifest hash, since a manifest has
    // no author and no nonce) keeps its own row exactly as before.
    where.push(
      `(NOT EXISTS (SELECT 1 FROM doc_signers d WHERE d.manifest_hash = t.manifest_hash)
        OR t.rowid = (SELECT MIN(t2.rowid) FROM things t2 WHERE t2.manifest_hash = t.manifest_hash))`
    )
    // Collapse a version CHAIN to its current version. Two rules, because a
    // chain has two kinds of stale member: an older version (a later seq by the
    // same author on the same path), and the ORIGINAL the chain was rooted on,
    // whose own hash is the path. Without the second, amending something would
    // leave the thing you amended sitting beside its own replacement.
    //
    // Scoped to things that are actually IN a chain, so an ordinary standalone
    // thing keeps its row -- the lesson the co-signing collapse above taught.
    where.push(
      `(t.path IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM things later
           WHERE later.author_key = t.author_key AND later.path = t.path AND later.seq > t.seq
        ))`
    )
    where.push(
      `NOT EXISTS (
        SELECT 1 FROM things v
         WHERE v.path = t.envelope_hash AND v.author_key = t.author_key
      )`
    )
    // Fold the feed to what deserves its own row. Two rules, and both are
    // scoped narrowly -- the co-signing collapse above is here because a first
    // attempt at it quietly swallowed ordinary copies.
    if (query.rollUp) {
      // A vote is activity, not content. Forty votes on an article are forty
      // things and the library still stores forty rows, but listing them would
      // bury everything else -- which is the exact complaint this answers.
      where.push(`t.type != 'vote'`)
      // A reply belongs under the thing it answers. Scoped to targets actually
      // HELD: a reply to something you do not have must still show, because
      // what you have is the reply, and hiding it would hide the only copy.
      where.push(
        `NOT EXISTS (
          SELECT 1 FROM refs rr JOIN things parent ON parent.envelope_hash = rr.target_hash
           WHERE rr.envelope_hash = t.envelope_hash AND rr.rel = 'replyTo'
        )`
      )
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = query.limit ?? 200
    const offset = query.offset ?? 0
    const rows = this.db
      .prepare(
        `SELECT t.*, p.name AS petname,
                (SELECT ti.title FROM titles ti WHERE ti.envelope_hash = t.envelope_hash) AS title,
                (SELECT COUNT(*) FROM things t3 WHERE t3.manifest_hash = t.manifest_hash) AS signatures,
                EXISTS (SELECT 1 FROM doc_signers d2 WHERE d2.manifest_hash = t.manifest_hash) AS cosignable
           FROM things t${join}
           LEFT JOIN petnames p ON p.author_scheme = t.author_scheme AND p.author_key = t.author_key
         ${clause} ORDER BY t.received_at DESC, t.rowid DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Row[]
    const out = rows.map(toThingRow)
    if (query.rollUp && out.length > 0) {
      // Two whole-table queries for the whole page, rather than a walk per
      // row. A feed of 200 rows would otherwise be 400 queries.
      const replies = this.descendantCounts()
      const votes = this.voteCounts()
      for (const row of out) {
        const v = votes.get(row.envelopeHash)
        row.activity = {
          replies: replies.get(row.envelopeHash) ?? 0,
          up: v?.up ?? 0,
          down: v?.down ?? 0
        }
      }
    }
    return out
  }

  /** Things this shell was seeding when it last ran, so it can resume. */
  seeding(): { envelopeHash: string; magnet: string; startedAt: number }[] {
    const rows = this.db
      .prepare('SELECT envelope_hash, magnet, started_at FROM seeding ORDER BY started_at')
      .all() as { envelope_hash: string; magnet: string; started_at: number }[]
    return rows.map((r) => ({ envelopeHash: r.envelope_hash, magnet: r.magnet, startedAt: r.started_at }))
  }

  rememberSeeding(envelopeHash: string, magnet: string, now: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO seeding (envelope_hash, magnet, started_at) VALUES (?,?,?)')
      .run(envelopeHash, magnet, now)
  }

  forgetSeeding(envelopeHash: string): void {
    this.db.prepare('DELETE FROM seeding WHERE envelope_hash = ?').run(envelopeHash)
  }

  /** Every signature over one manifest -- that is, every envelope naming it.
   *
   *  RECEIVED order, like the feed. `created` is an author claim and must not
   *  be used to decide who signed "first": nothing in the format records the
   *  order signatures were made in, and the shell does not invent one. */
  signaturesOf(manifestHash: string): {
    envelopeHash: string
    authorScheme: string
    authorKey: string
    created: number
    receivedAt: number
  }[] {
    const rows = this.db
      .prepare(
        `SELECT envelope_hash, author_scheme, author_key, created, received_at
           FROM things WHERE manifest_hash = ? AND sealed = 0
          ORDER BY received_at ASC`
      )
      .all(manifestHash) as {
      envelope_hash: string
      author_scheme: string
      author_key: string
      created: number
      received_at: number
    }[]
    return rows.map((r) => ({
      envelopeHash: r.envelope_hash,
      authorScheme: r.author_scheme,
      authorKey: r.author_key,
      created: r.created,
      receivedAt: r.received_at
    }))
  }

  /** The signatories a document names. Empty for anything not meant to be
   *  co-signed, which is almost everything. */
  namedSigners(manifestHash: string): DeclaredSigner[] {
    const rows = this.db
      .prepare('SELECT scheme, key, role, name FROM doc_signers WHERE manifest_hash = ? ORDER BY idx ASC')
      .all(manifestHash) as { scheme: string; key: string; role: string; name: string }[]
    return rows.map((r) => ({ scheme: r.scheme, key: r.key, role: r.role, name: r.name }))
  }

  /** Downloads asked for, oldest first. Resumed at startup. */
  transfers(): { id: string; magnet: string; infoHash: string; name: string; addedAt: number }[] {
    const rows = this.db
      .prepare('SELECT id, magnet, info_hash, name, added_at FROM transfers ORDER BY added_at ASC')
      .all() as { id: string; magnet: string; info_hash: string; name: string; added_at: number }[]
    return rows.map((r) => ({ id: r.id, magnet: r.magnet, infoHash: r.info_hash, name: r.name, addedAt: r.added_at }))
  }

  /** Record the intent to download. Keyed by INFOHASH, not by id: asking for
   *  the same magnet twice is one download, not two racing for one directory. */
  rememberTransfer(id: string, magnet: string, infoHash: string, name: string, now: number): string {
    const existing = this.db.prepare('SELECT id FROM transfers WHERE info_hash = ?').get(infoHash) as
      | { id: string }
      | undefined
    if (existing) return existing.id
    this.db
      .prepare('INSERT OR REPLACE INTO transfers (id, magnet, info_hash, name, added_at) VALUES (?,?,?,?,?)')
      .run(id, magnet, infoHash, name, now)
    return id
  }

  forgetTransfer(id: string): boolean {
    return this.db.prepare('DELETE FROM transfers WHERE id = ?').run(id).changes > 0
  }

  /** Remember what a draft is amending. */
  setDraftChain(draftId: string, path: string, seq: number, prev: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO draft_chain (draft_id, path, seq, prev) VALUES (?,?,?,?)')
      .run(draftId, path, seq, prev)
  }

  draftChain(draftId: string): { path: string; seq: number; prev: string } | null {
    const r = this.db.prepare('SELECT path, seq, prev FROM draft_chain WHERE draft_id = ?').get(draftId) as
      | { path: string; seq: number; prev: string }
      | undefined
    return r ?? null
  }

  clearDraftChain(draftId: string): void {
    this.db.prepare('DELETE FROM draft_chain WHERE draft_id = ?').run(draftId)
  }

  // ── Offers ─────────────────────────────────────────────────────────────────
  // A thing a relay advertised that we do not hold. Nothing here fetches
  // anything: an offer is a note saying something exists and where to get it,
  // and it stays a note until a human presses Fetch.

  /** How many offers are kept. A relay can advertise pointers forever, and this
   *  table is the one place that turns into disk, so the newest win and the
   *  rest are dropped. Losing an old offer costs nothing -- the thing still
   *  exists, and whoever is seeding it can advertise it again. */
  private maxOffers = 500

  /** Note that a relay is offering a thing. Ignored if we already hold it.
   *
   *  A second advertisement of the same thing refreshes where to get it, so a
   *  dead seeder can be superseded by a live one -- but never over a fetch
   *  that is already running, which would swap the locator mid-transfer. */
  recordOffer(o: {
    envelopeHash: string
    locator: string
    relayUrl: string
    poster: string
    type: string
    inGroup: string | null
    replyTo: string | null
    now: number
  }): boolean {
    if (this.get(o.envelopeHash)) return false
    const existing = this.offer(o.envelopeHash)
    if (existing && existing.state === 'fetching') return false
    this.db
      .prepare(
        `INSERT INTO offers
           (envelope_hash, locator, relay_url, poster, type, in_group, reply_to, state, reason, transfer_id, seen_at)
         VALUES (?,?,?,?,?,?,?,'offered','',NULL,?)
         ON CONFLICT(envelope_hash) DO UPDATE SET
           locator = excluded.locator, relay_url = excluded.relay_url, poster = excluded.poster,
           type = excluded.type, in_group = excluded.in_group, reply_to = excluded.reply_to,
           state = 'offered', reason = '', transfer_id = NULL, seen_at = excluded.seen_at`
      )
      .run(o.envelopeHash, o.locator, o.relayUrl, o.poster, o.type, o.inGroup, o.replyTo, o.now)
    this.db
      .prepare(
        `DELETE FROM offers WHERE envelope_hash NOT IN (
           SELECT envelope_hash FROM offers ORDER BY seen_at DESC, rowid DESC LIMIT ?
         )`
      )
      .run(this.maxOffers)
    return true
  }

  offer(envelopeHash: string): OfferRow | null {
    const r = this.db.prepare('SELECT * FROM offers WHERE envelope_hash = ?').get(envelopeHash) as
      | OfferDbRow
      | undefined
    return r ? toOfferRow(r) : null
  }

  /** Offers not yet fetched, newest first. `inGroup` filters to one forum. */
  offers(query: { inGroup?: string; limit?: number } = {}): OfferRow[] {
    const rows = query.inGroup
      ? (this.db
          .prepare('SELECT * FROM offers WHERE in_group = ? ORDER BY seen_at DESC LIMIT ?')
          .all(query.inGroup, query.limit ?? 200) as OfferDbRow[])
      : (this.db
          .prepare('SELECT * FROM offers ORDER BY seen_at DESC LIMIT ?')
          .all(query.limit ?? 200) as OfferDbRow[])
    return rows.map(toOfferRow)
  }

  setOfferState(envelopeHash: string, state: OfferRow['state'], reason = '', transferId: string | null = null): void {
    this.db
      .prepare('UPDATE offers SET state = ?, reason = ?, transfer_id = ? WHERE envelope_hash = ?')
      .run(state, reason, transferId, envelopeHash)
  }

  /** The offer a running transfer is discharging, if any. Survives a restart,
   *  which is the point: a magnet resumed on the next launch still has to
   *  deliver the thing it was started for. */
  offerForTransfer(transferId: string): OfferRow | null {
    const r = this.db.prepare('SELECT * FROM offers WHERE transfer_id = ?').get(transferId) as
      | OfferDbRow
      | undefined
    return r ? toOfferRow(r) : null
  }

  dropOffer(envelopeHash: string): boolean {
    return this.db.prepare('DELETE FROM offers WHERE envelope_hash = ?').run(envelopeHash).changes > 0
  }

  // ── Relays ─────────────────────────────────────────────────────────────────
  // Which relays this shell talks to, how far each subscription has read, and
  // who handed us each thing. Nothing here is connected to by itself: the
  // table is a list of relays the human added, and an empty table is the
  // default.

  relays(): string[] {
    return (this.db.prepare('SELECT url FROM relays ORDER BY added_at ASC').all() as { url: string }[]).map(
      (r) => r.url
    )
  }

  addRelay(url: string, now: number): void {
    this.db.prepare('INSERT OR IGNORE INTO relays (url, added_at) VALUES (?,?)').run(url, now)
  }

  removeRelay(url: string): boolean {
    return this.db.prepare('DELETE FROM relays WHERE url = ?').run(url).changes > 0
  }

  /** How far a subscription has read, so a reconnect resumes. */
  cursor(subId: string): number {
    const r = this.db.prepare('SELECT since FROM relay_cursor WHERE sub_id = ?').get(subId) as
      | { since: number }
      | undefined
    return r ? r.since : 0
  }

  setCursor(subId: string, since: number): void {
    this.db.prepare('INSERT OR REPLACE INTO relay_cursor (sub_id, since) VALUES (?,?)').run(subId, since)
  }

  /** The encryption key this thing's author bound to it, or null. */
  boundEncKey(envelopeHash: string): { scheme: string; key: string } | null {
    const r = this.db.prepare('SELECT scheme, key FROM thing_enc WHERE envelope_hash = ?').get(envelopeHash) as
      | { scheme: string; key: string }
      | undefined
    return r ?? null
  }

  /** Record that `poster` offered this thing on `url`. Kept per (thing, relay,
   *  poster) because "who relayed it" is a different fact per relayer, and the
   *  one the chrome must not confuse with authorship. */
  noteRelayArrival(envelopeHash: string, url: string, poster: string, selfPosted: boolean, at: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO relay_arrivals (envelope_hash, relay_url, poster, self_posted, at) VALUES (?,?,?,?,?)'
      )
      .run(envelopeHash, url, poster, selfPosted ? 1 : 0, at)
  }

  /** How a thing reached us over relays, newest first. */
  relayArrivals(envelopeHash: string): { relayUrl: string; poster: string; selfPosted: boolean; at: number }[] {
    const rows = this.db
      .prepare('SELECT relay_url, poster, self_posted, at FROM relay_arrivals WHERE envelope_hash = ? ORDER BY at DESC')
      .all(envelopeHash) as { relay_url: string; poster: string; self_posted: number; at: number }[]
    return rows.map((r) => ({
      relayUrl: r.relay_url,
      poster: r.poster,
      selfPosted: r.self_posted === 1,
      at: r.at
    }))
  }

  // ── Version chains ─────────────────────────────────────────────────────────
  // A chain is (author_key, path): the same author continuing their own line.
  // Someone else amending your thing shares the path but not the author, so it
  // is THEIR chain rooted at your thing -- never a new version of yours.

  /** What a version CLAIMS to follow, or null if it claims nothing. */
  claimedPrev(envelopeHash: string): string | null {
    const r = this.db.prepare('SELECT prev FROM thing_prev WHERE envelope_hash = ?').get(envelopeHash) as
      | { prev: string }
      | undefined
    return r ? r.prev : null
  }

  /** Every version in a chain, oldest first. */
  chainHistory(authorKey: string, path: string): ThingRow[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, p.name AS petname, 1 AS signatures, 0 AS cosignable,
                (SELECT ti.title FROM titles ti WHERE ti.envelope_hash = t.envelope_hash) AS title
           FROM things t
           LEFT JOIN petnames p ON p.author_scheme = t.author_scheme AND p.author_key = t.author_key
          WHERE t.author_key = ? AND t.path = ?
          ORDER BY t.seq ASC, t.rowid ASC`
      )
      .all(authorKey, path) as Row[]
    return rows.map(toThingRow)
  }

  /** The highest seq in a chain, or null if there is none. */
  chainLatest(authorKey: string, path: string): ThingRow | null {
    const row = this.db
      .prepare(
        `SELECT t.*, NULL AS petname, 1 AS signatures, 0 AS cosignable
           FROM things t WHERE t.author_key = ? AND t.path = ?
          ORDER BY t.seq DESC, t.rowid DESC LIMIT 1`
      )
      .get(authorKey, path) as Row | undefined
    return row ? toThingRow(row) : null
  }

  /** The people a group version lists. The author's claim, not consent. */
  groupMembers(envelopeHash: string): DeclaredSigner[] {
    const rows = this.db
      .prepare('SELECT scheme, key, role, name FROM group_members WHERE envelope_hash = ? ORDER BY idx ASC')
      .all(envelopeHash) as { scheme: string; key: string; role: string; name: string }[]
    return rows.map((r) => ({ scheme: r.scheme, key: r.key, role: r.role, name: r.name }))
  }

  /** Groups whose CURRENT version lists this key.
   *
   *  Resolved to the latest version of each chain on purpose: a roster you were
   *  written out of in version 2 should stop listing you, and a query that
   *  ignored that would report memberships that have been revoked. */
  groupsListing(scheme: string, key: string): { envelopeHash: string; authorKey: string }[] {
    const rows = this.db
      .prepare(
        `SELECT g.envelope_hash, t.author_key
           FROM group_members g
           JOIN things t ON t.envelope_hash = g.envelope_hash
          WHERE g.scheme = ? AND g.key = ?
            -- A superseded VERSION: a later seq on the same line.
            AND NOT EXISTS (
              SELECT 1 FROM things later
               WHERE later.author_key = t.author_key AND t.path IS NOT NULL
                 AND later.path = t.path AND later.seq > t.seq
            )
            -- A superseded ROOT: the thing a line was started on. Its own path
            -- is NULL, so the rule above cannot see it, and without this a
            -- roster's first version keeps reporting people written out of it.
            AND NOT EXISTS (
              SELECT 1 FROM things v
               WHERE v.author_key = t.author_key AND v.path = t.envelope_hash
            )`
      )
      .all(scheme, key) as { envelope_hash: string; author_key: string }[]
    return rows.map((r) => ({ envelopeHash: r.envelope_hash, authorKey: r.author_key }))
  }

  /** Every vouch pointing at a key, newest claim per voucher.
   *
   *  A voucher who vouches twice has only their LATEST word counted -- that is
   *  how a vouch is amended, since a signed thing cannot be unsaid, and without
   *  it a voucher would gain weight simply by repeating themselves.
   *
   *  The bare name/relation columns beside MAX(created) rely on SQLite's
   *  documented min/max special case: with a single min() or max() aggregate,
   *  the bare columns come from the row that matched it. */
  vouchesAbout(scheme: string, key: string): { voucherScheme: string; voucherKey: string; name: string; relation: string }[] {
    const rows = this.db
      .prepare(
        `SELECT voucher_scheme, voucher_key, name, relation, MAX(created) AS created
           FROM vouches WHERE about_scheme = ? AND about_key = ?
          GROUP BY voucher_scheme, voucher_key`
      )
      .all(scheme, key) as { voucher_scheme: string; voucher_key: string; name: string; relation: string }[]
    return rows.map((r) => ({
      voucherScheme: r.voucher_scheme,
      voucherKey: r.voucher_key,
      name: r.name,
      relation: r.relation
    }))
  }

  /** Who a key has vouched FOR (latest per subject). */
  private vouchedBy(scheme: string, key: string): { scheme: string; key: string }[] {
    const rows = this.db
      .prepare(
        `SELECT about_scheme, about_key, MAX(created) AS created
           FROM vouches WHERE voucher_scheme = ? AND voucher_key = ?
          GROUP BY about_scheme, about_key`
      )
      .all(scheme, key) as { about_scheme: string; about_key: string }[]
    return rows.map((r) => ({ scheme: r.about_scheme, key: r.about_key }))
  }

  /** Keys reachable from YOU by vouches, and how many hops away.
   *
   *  Only paths that start at your own key count. That is the whole defence:
   *  vouches are free to manufacture, so a key with a thousand vouches from
   *  strangers is a thousand strangers -- it means nothing until one of the
   *  people YOU vouched for is somewhere on the path.
   *
   *  Depth is capped low on purpose. Two hops is about the limit at which "a
   *  friend of someone I trust" still carries meaning. */
  tribe(myScheme: string, myKey: string, maxDepth = 2): Map<string, { hops: number; via: string[] }> {
    const out = new Map<string, { hops: number; via: string[] }>()
    let frontier: { scheme: string; key: string; via: string[] }[] = [{ scheme: myScheme, key: myKey, via: [] }]
    const seen = new Set([`${myScheme}:${myKey}`])
    for (let hop = 1; hop <= maxDepth && frontier.length > 0; hop++) {
      const next: { scheme: string; key: string; via: string[] }[] = []
      for (const node of frontier) {
        for (const subject of this.vouchedBy(node.scheme, node.key)) {
          const id = `${subject.scheme}:${subject.key}`
          if (seen.has(id)) continue // nearest hop wins; never revisit
          seen.add(id)
          // The intermediaries between you and this key, excluding both ends.
          // At hop 1 the node IS you, so you are not an intermediary -- which
          // is why the root contributes nothing rather than being prepended.
          const via = hop === 1 ? [] : [...node.via, node.key]
          out.set(id, { hops: hop, via })
          next.push({ ...subject, via })
        }
      }
      frontier = next
    }
    return out
  }

  // ── Votes ──────────────────────────────────────────────────────────────────
  // A vote is about a THING. A vouch is about a KEY. Keeping them apart is the
  // whole sybil story: tribe() walks vouch edges, so an upvote that was a vouch
  // would put every author you ever agreed with one hop inside your trust
  // graph. Votes are free to manufacture and are counted as such; what makes a
  // count mean anything is how much of it came from your tribe.

  // A key that votes twice has only its latest vote counted, exactly as a
  // voucher who vouches twice does: a signed thing cannot be unsaid, so
  // changing your mind means publishing a later vote, and repeating yourself
  // must not buy extra weight.
  //
  // Ordered by `created` and then by ROWID, which is not decoration. `created`
  // is an author claim in whole SECONDS, and pressing the up arrow and then
  // the down arrow happens well inside one of those -- with `created` alone
  // the two votes tie and SQLite picks whichever it likes. The rowid breaks
  // the tie by the only other fact available: the order they arrived HERE.
  // That is a local observation rather than the author's word, which is
  // exactly what makes it usable as a tiebreak.
  private static readonly LATEST_VOTE = `
    SELECT voter_scheme, voter_key, target_hash, dir, envelope_hash,
           ROW_NUMBER() OVER (
             PARTITION BY target_hash, voter_scheme, voter_key
             ORDER BY created DESC, rowid DESC
           ) AS rn
      FROM votes`

  /** Every voter's CURRENT word on a thing. */
  votesOn(targetHash: string): { voterScheme: string; voterKey: string; dir: number }[] {
    const rows = this.db
      .prepare(
        `SELECT voter_scheme, voter_key, dir FROM (${Library.LATEST_VOTE} WHERE target_hash = ?)
          WHERE rn = 1`
      )
      .all(targetHash) as { voter_scheme: string; voter_key: string; dir: number }[]
    return rows.map((r) => ({ voterScheme: r.voter_scheme, voterKey: r.voter_key, dir: r.dir }))
  }

  /** The same, for many things at once, so a listing is one query rather than
   *  one per row. */
  votesOnMany(targetHashes: string[]): Map<string, { voterScheme: string; voterKey: string; dir: number }[]> {
    const out = new Map<string, { voterScheme: string; voterKey: string; dir: number }[]>()
    if (targetHashes.length === 0) return out
    const holes = targetHashes.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT target_hash, voter_scheme, voter_key, dir
           FROM (${Library.LATEST_VOTE} WHERE target_hash IN (${holes}))
          WHERE rn = 1`
      )
      .all(...targetHashes) as { target_hash: string; voter_scheme: string; voter_key: string; dir: number }[]
    for (const r of rows) {
      const list = out.get(r.target_hash) ?? []
      list.push({ voterScheme: r.voter_scheme, voterKey: r.voter_key, dir: r.dir })
      out.set(r.target_hash, list)
    }
    return out
  }

  /** Your own current vote on a thing, or null. */
  myVote(scheme: string, key: string, targetHash: string): { dir: number; envelopeHash: string } | null {
    const r = this.db
      .prepare(
        `SELECT envelope_hash, dir
           FROM (${Library.LATEST_VOTE} WHERE target_hash = ? AND voter_scheme = ? AND voter_key = ?)
          WHERE rn = 1`
      )
      .get(targetHash, scheme, key) as { envelope_hash: string; dir: number } | undefined
    return r ? { dir: r.dir, envelopeHash: r.envelope_hash } : null
  }

  // ── Threads ────────────────────────────────────────────────────────────────

  /** Everything replying to a thing, however deep, breadth-first.
   *
   *  Deliberately a frontier walk rather than a recursive CTE, and modelled on
   *  tribe() for the same reason: replyTo is a free claim, so A replying to B
   *  while B replies to A is not a corrupt database, it is Tuesday. A walk with
   *  a `seen` set and two hard caps obviously terminates; a query that needs an
   *  argument about why it terminates does not.
   *
   *  The shallowest place a thing appears wins, so a reply claiming two parents
   *  is drawn once, nearest the root. */
  thread(rootHash: string, maxDepth = 32, maxNodes = 500): { row: ThingRow; parent: string; depth: number }[] {
    const out: { row: ThingRow; parent: string; depth: number }[] = []
    const seen = new Set([rootHash])
    let frontier = [rootHash]
    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && out.length < maxNodes; depth++) {
      const next: string[] = []
      for (const parent of frontier) {
        for (const row of this.feed({ replyTo: parent, limit: maxNodes })) {
          if (seen.has(row.envelopeHash)) continue
          seen.add(row.envelopeHash)
          out.push({ row, parent, depth })
          next.push(row.envelopeHash)
          if (out.length >= maxNodes) break
        }
        if (out.length >= maxNodes) break
      }
      frontier = next
    }
    return out
  }

  /** How many things reply to each of these, however deep: ONE query for the
   *  whole feed rather than a walk per row.
   *
   *  Bounded by depth in the CTE itself, and UNION (not UNION ALL) so a cycle
   *  cannot spin. A thing reachable by two paths is counted once, which is
   *  what a reader means by "12 replies". */
  descendantCounts(maxDepth = 32): Map<string, number> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(root, node, depth) AS (
           SELECT target_hash, envelope_hash, 1 FROM refs WHERE rel = 'replyTo'
           UNION
           SELECT s.root, r.envelope_hash, s.depth + 1
             FROM refs r JOIN sub s ON r.target_hash = s.node
            WHERE r.rel = 'replyTo' AND s.depth < ?
         )
         SELECT root, COUNT(DISTINCT node) AS n FROM sub GROUP BY root`
      )
      .all(maxDepth) as { root: string; n: number }[]
    return new Map(rows.map((r) => [r.root, r.n]))
  }

  /** How many votes point at each thing, in one query. Raw counts only -- what
   *  makes them mean anything is the tribe split, which needs YOUR key and so
   *  is computed above this layer. */
  voteCounts(): Map<string, { up: number; down: number }> {
    const rows = this.db
      .prepare(
        `SELECT target_hash, dir, COUNT(*) AS n
           FROM (${Library.LATEST_VOTE}) WHERE rn = 1
          GROUP BY target_hash, dir`
      )
      .all() as { target_hash: string; dir: number; n: number }[]
    const out = new Map<string, { up: number; down: number }>()
    for (const r of rows) {
      const cur = out.get(r.target_hash) ?? { up: 0, down: 0 }
      if (r.dir > 0) cur.up += r.n
      else cur.down += r.n
      out.set(r.target_hash, cur)
    }
    return out
  }

  // ── Forums ─────────────────────────────────────────────────────────────────
  // A forum is a GROUP: a roster with roles, kept by whoever founded it and
  // amended through its version chain. Its stable name is the root envelope
  // hash of that chain -- which is exactly what `path` is -- so a post says
  // `inGroup: <root>` and keeps pointing at the forum across every revision.

  /** The current version of a group chain, given its root hash. Null if the
   *  root is not held, or is not a group. */
  groupCurrent(rootHash: string): ThingRow | null {
    const root = this.get(rootHash)
    if (!root || root.type !== 'group') return null
    const history = this.chainHistory(root.authorKey, rootHash)
    return history.length > 0 ? history[history.length - 1]! : root
  }

  /** Everything claiming to belong to a group, newest first. Claims: being
   *  tagged into a forum is not the forum agreeing. */
  forumPosts(rootHash: string, limit = 200): ThingRow[] {
    return this.feed({ inGroup: rootHash, limit })
  }

  /** Attestations pointing at a thing, with their authors -- the raw material
   *  for a moderation verdict. WHO counts as a moderator is not decided here:
   *  that depends on the roster you hold, which is the caller's business. */
  attestationsOn(targetHash: string): ThingRow[] {
    return this.feed({ attests: targetHash, limit: 200 })
  }

  /** Your name for a key, or null. */
  petname(scheme: string, key: string): { name: string; note: string } | null {
    const r = this.db
      .prepare('SELECT name, note FROM petnames WHERE author_scheme = ? AND author_key = ?')
      .get(scheme, key) as { name: string; note: string } | undefined
    return r ?? null
  }

  /** Name a key, or clear it by passing an empty name. */
  setPetname(scheme: string, key: string, name: string, note: string, now: number): void {
    const trimmed = name.trim()
    if (!trimmed) {
      this.db.prepare('DELETE FROM petnames WHERE author_scheme = ? AND author_key = ?').run(scheme, key)
      return
    }
    this.db
      .prepare(
        `INSERT INTO petnames (author_scheme, author_key, name, note, set_at) VALUES (?,?,?,?,?)
         ON CONFLICT(author_scheme, author_key) DO UPDATE SET name = excluded.name, note = excluded.note,
           set_at = excluded.set_at`
      )
      .run(scheme, key, trimmed, note.trim(), now)
  }

  /** Every key that has authored something here, with your name for it and how
   *  much of what you hold came from it. The People view's whole content. */
  people(): { authorScheme: string; authorKey: string; name: string | null; note: string; things: number; lastSeen: number }[] {
    const rows = this.db
      .prepare(
        `SELECT t.author_scheme, t.author_key, COUNT(*) AS things, MAX(t.received_at) AS last_seen,
                p.name AS name, p.note AS note
           FROM things t
           LEFT JOIN petnames p ON p.author_scheme = t.author_scheme AND p.author_key = t.author_key
          GROUP BY t.author_scheme, t.author_key
          ORDER BY things DESC, last_seen DESC`
      )
      .all() as {
      author_scheme: string
      author_key: string
      things: number
      last_seen: number
      name: string | null
      note: string | null
    }[]
    return rows.map((r) => ({
      authorScheme: r.author_scheme,
      authorKey: r.author_key,
      name: r.name,
      note: r.note ?? '',
      things: r.things,
      lastSeen: r.last_seen
    }))
  }

  get(envelopeHash: string): ThingRow | null {
    const r = this.db
      .prepare(
        `SELECT t.*, p.name AS petname,
                (SELECT ti.title FROM titles ti WHERE ti.envelope_hash = t.envelope_hash) AS title
           FROM things t
           LEFT JOIN petnames p ON p.author_scheme = t.author_scheme AND p.author_key = t.author_key
          WHERE t.envelope_hash = ?`
      )
      .get(envelopeHash) as Row | undefined
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
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM things WHERE envelope_hash = ?').run(envelopeHash)
      // The claims this thing MADE go with it. Claims pointing AT it stay:
      // they are still real, the target just is not local any more — which is
      // exactly what the reply's header then says.
      this.db.prepare('DELETE FROM refs WHERE envelope_hash = ?').run(envelopeHash)
      this.db.prepare('DELETE FROM titles WHERE envelope_hash = ?').run(envelopeHash)
      // Stop remembering that we were serving it. The live torrent is stopped
      // by the caller (deleteThing); this is the record that would otherwise
      // resume seeding a thing the human deleted, on the next start.
      this.db.prepare('DELETE FROM seeding WHERE envelope_hash = ?').run(envelopeHash)
    })()
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
    // Draft ATTACHMENTS too: a draft holds bytes no `things` row may reference,
    // so scanning only things+programs would collect an image out from under
    // someone's unfinished article.
    for (const b of this.db.prepare('SELECT hash FROM draft_blobs').all() as { hash: string }[]) {
      referenced.add(b.hash)
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

  /** `args` seeds the draft — the shell uses it to prefill a reply's target
   *  (the program cannot learn a hash on its own). */
  createDraft(input: { type: string; progHash: string; args?: unknown; now?: number }): DraftRow {
    const now = input.now ?? Date.now()
    const args = input.args ?? null
    const row: DraftRow = {
      id: `${DRAFT_ID_PREFIX}${randomUUID()}`,
      type: input.type,
      progHash: input.progHash,
      args,
      created: now,
      updated: now
    }
    this.db
      .prepare('INSERT INTO drafts (id, type, prog_hash, args_json, created, updated) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.type, row.progHash, args === null ? null : JSON.stringify(args), now, now)
    // Whatever pointers came in the seed are the shell's from here on.
    const pins = pinsOf(args)
    if (Object.keys(pins).length > 0) {
      this.db.prepare('INSERT OR REPLACE INTO draft_pins (draft_id, pins_json) VALUES (?,?)').run(row.id, JSON.stringify(pins))
    }
    return row
  }

  /** The pointers the shell seeded into this draft; empty when it seeded none. */
  draftPins(id: string): Pins {
    const r = this.db.prepare('SELECT pins_json FROM draft_pins WHERE draft_id = ?').get(id) as
      | { pins_json: string }
      | undefined
    if (!r) return {}
    try {
      return pinsOf(JSON.parse(r.pins_json)) // re-filtered: never trust a stored shape
    } catch {
      return {}
    }
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
    const candidates = new Set<string>([row.progHash, ...this.draftBlobs(id).map((b) => b.hash)])
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM draft_blobs WHERE draft_id = ?').run(id)
      this.db.prepare('DELETE FROM draft_chain WHERE draft_id = ?').run(id)
      this.db.prepare('DELETE FROM draft_pins WHERE draft_id = ?').run(id)
      this.db.prepare('DELETE FROM drafts WHERE id = ?').run(id)
    })()
    this.gc(candidates)
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
