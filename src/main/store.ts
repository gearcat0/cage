import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// ── Attachment stores ────────────────────────────────────────────────────────
// Bytes behind the `att/<name>` route live in one of two stores, both
// shell-controlled and read-only to the thing:
//
//   CasStore       — the persistent, content-addressed on-disk store
//                    (`<dir>/blobs/<hex-hash>`). Public things only.
//   EphemeralStore — an in-memory map scoped to a cage's lifetime. Sealed
//                    things ONLY serve from here: their decrypted attachments
//                    must never touch the persistent CAS, or we would silently
//                    write someone's private bytes to disk in the clear.
//
// Integrity is verified at ADMISSION (spec §8.1 step 8), before any byte
// reaches a cage. The stores are keyed by hash and the thing cannot write to
// either, so serving does not re-hash. Local malware editing the CAS is out of
// scope — if local disk is compromised the game is already over.

/** One attachment's manifest row: name is the map key held by the caller. */
export interface AttEntry {
  /** Lowercase hex sha256 of the (plaintext) bytes. */
  hash: string
  mime: string
  size: number
}

/** name -> entry, from the admitted manifest's attachment table. */
export type AttachmentTable = Map<string, AttEntry>

export interface AttachmentStore {
  has(hashHex: string): boolean
  /**
   * Stream bytes [start, end] (inclusive) for a blob. Returns null if the
   * blob is not in the store. Callers pass a range already clamped to the
   * admitted size.
   */
  read(hashHex: string, start: number, end: number): ReadableStream<Uint8Array> | null
  /** Read a whole blob into memory by hex hash, or null if absent. */
  readAll(hashHex: string): Uint8Array | null
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Reject anything that is not a plain lowercase-hex sha256 before it goes
 *  anywhere near a path join. The CAS never sees thing-controlled input (the
 *  handler resolves names via the attachment table first), but the store
 *  refuses malformed keys on principle. */
const HEX_HASH = /^[0-9a-f]{64}$/

export class CasStore implements AttachmentStore {
  private readonly blobsDir: string

  constructor(dir: string) {
    this.blobsDir = join(dir, 'blobs')
    mkdirSync(this.blobsDir, { recursive: true })
  }

  /** Admission-side write: content-addressed, idempotent. Returns the hash. */
  put(bytes: Uint8Array): string {
    const hash = sha256Hex(bytes)
    const path = join(this.blobsDir, hash)
    if (!existsSync(path)) writeFileSync(path, bytes)
    return hash
  }

  has(hashHex: string): boolean {
    if (!HEX_HASH.test(hashHex)) return false
    return existsSync(join(this.blobsDir, hashHex))
  }

  read(hashHex: string, start: number, end: number): ReadableStream<Uint8Array> | null {
    if (!HEX_HASH.test(hashHex)) return null
    const path = join(this.blobsDir, hashHex)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return null
    }
    if (start < 0 || end >= size || start > end) return null
    const nodeStream = createReadStream(path, { start, end })
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  }

  /** Read a whole blob into memory by hex hash, or null if absent. For the
   *  library/mount path (small blobs like the program and manifest). */
  readAll(hashHex: string): Uint8Array | null {
    if (!HEX_HASH.test(hashHex)) return null
    const path = join(this.blobsDir, hashHex)
    try {
      return new Uint8Array(readFileSync(path))
    } catch {
      return null
    }
  }
}

export class EphemeralStore implements AttachmentStore {
  private readonly blobs = new Map<string, Uint8Array>()

  /** Admission-side write (decrypted sealed bytes). Returns the hash. */
  put(bytes: Uint8Array): string {
    const hash = sha256Hex(bytes)
    this.blobs.set(hash, bytes)
    return hash
  }

  /** Drop all decrypted bytes. Called when the cage is torn down so sealed
   *  plaintext does not outlive the thing that rendered it (1.3). */
  clear(): void {
    this.blobs.clear()
  }

  has(hashHex: string): boolean {
    return this.blobs.has(hashHex)
  }

  /** Read a whole blob into memory by hex hash, or null if absent. */
  readAll(hashHex: string): Uint8Array | null {
    return this.blobs.get(hashHex) ?? null
  }

  read(hashHex: string, start: number, end: number): ReadableStream<Uint8Array> | null {
    const bytes = this.blobs.get(hashHex)
    if (!bytes) return null
    if (start < 0 || end >= bytes.length || start > end) return null
    const slice = bytes.subarray(start, end + 1)
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(slice)
        controller.close()
      }
    })
  }
}
