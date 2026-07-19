import { app, ipcMain, nativeTheme } from 'electron'
import { createHash } from 'node:crypto'
import { cage as cageGlobals, record, recordTestEmit } from './events.js'
import { attachmentUrl } from './protocol.js'
import type { AttachmentTable } from './store.js'
import { DEFAULT_DRAFT_CAPS, validateDraft, type DraftCaps } from './draft.js'

// ── The bridge (shell side) ──────────────────────────────────────────────────
// The trusted half of the four-method bridge. Every method either hands the
// thing data it already came with, or accepts a REQUEST that grants nothing
// until a human confirms it in trusted chrome. No signing, decryption,
// network, filesystem, or storage. See src/preload/index.ts for the
// renderer-facing frozen surface.

/** The decoded, read-only view a thing renders from. NOT raw CBOR, NOT the
 *  envelope: the shell already decoded and validated the manifest at admission
 *  (spec §8.1 step 6), and a second CBOR decoder inside untrusted code would
 *  reintroduce the canonicalization surface the format works to contain.
 *
 *  Deliberately withheld:
 *   - the envelope (author/signature/timestamp/path/seq) — identity is
 *     chrome's exclusive job; a thing that draws "signed by alice.eth" can lie
 *   - `prog` — the thing IS the program
 *   - attachment hashes — things address blobs by NAME via getBlob() */
export interface ThingArgs {
  /** manifest.type — a display hint only (spec §4: MUST NOT be trusted). */
  type: string
  /** manifest.args — program-defined, opaque to the shell. */
  args: unknown
  /** Names + metadata of the attachments that travelled with the thing. */
  attachments: AttInfo[]
}

export interface AttInfo {
  name: string
  mime: string
  size: number
}

export interface ViewerInfo {
  locale: string
  colorScheme: 'light' | 'dark'
}

/** Everything the bridge needs to answer for one cage. */
export interface CageBinding {
  /** The thing's id — the host of its thing:// origin. */
  thingId: string
  thingArgs: ThingArgs
  /** The admitted attachment table; getBlob resolves names against it. */
  attachments: AttachmentTable
}

const bindings = new Map<number, CageBinding>()

// Cap emit payloads so a malicious thing cannot exhaust shell memory by flooding
// giant messages. The bridge grants nothing regardless; this just keeps the
// shell responsive under abuse (see the "bridge abuse" attacks).
const MAX_EMIT_BYTES = 256 * 1024

/** Draft caps for the publish path (see draft.ts). Env-overridable so the
 *  abuse tests can exercise the caps without shipping huge payloads. */
function capsFromEnv(): DraftCaps {
  const int = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    ...DEFAULT_DRAFT_CAPS,
    maxBlobBytes: int('CAGE_MAX_DRAFT_BLOB_BYTES', DEFAULT_DRAFT_CAPS.maxBlobBytes),
    maxTotalBlobBytes: int('CAGE_MAX_DRAFT_TOTAL_BYTES', DEFAULT_DRAFT_CAPS.maxTotalBlobBytes)
  }
}

let installed = false

/** Install the IPC handlers once. Idempotent. */
export function installBridge(): void {
  if (installed) return
  installed = true

  const draftCaps = capsFromEnv()

  // getArgs(): synchronous so a thing can render from its args on first paint.
  // Returns the structured-clone ThingArgs view for this cage.
  ipcMain.on('cage:getArgs', (event) => {
    event.returnValue = bindings.get(event.sender.id)?.thingArgs ?? null
  })

  // getBlob(name): resolve an attachment NAME to a thing:// URL, or null.
  // Synchronous and cheap — it only computes a string; the existing protocol
  // handler does the serving. This is a convenience, not the security gate:
  // the gate is the attachment table + handler (an unknown name 404s there
  // whether or not it came through getBlob).
  ipcMain.on('cage:getBlob', (event, name: unknown) => {
    const binding = bindings.get(event.sender.id)
    if (!binding || typeof name !== 'string' || !binding.attachments.has(name)) {
      event.returnValue = null
      return
    }
    event.returnValue = attachmentUrl(binding.thingId, name)
  })

  // viewerInfo(): coarse and non-identifying. Locale + colour scheme, nothing
  // else — no timezone, no unique id, no screen dimensions, nothing that
  // fingerprints. A thing that needs more can ask via emit and let the human
  // decide. When in doubt, leave a field out.
  ipcMain.on('cage:viewerInfo', (event) => {
    const info: ViewerInfo = {
      locale: app.getLocale(),
      colorScheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    event.returnValue = info
  })

  // emit(channel, data): a request that grants nothing. Fire-and-forget — the
  // thing cannot observe whether a human confirmed anything.
  ipcMain.on('cage:emit', (_event, channel: unknown, data: unknown) => {
    if (typeof channel !== 'string') {
      record({ type: 'emit-rejected', reason: 'channel not a string' })
      return
    }

    // The publish path carries binary blobs, so it gets its own validation and
    // caps (per-blob AND total — see draft.ts) instead of the JSON measure.
    if (channel === 'publish') {
      handlePublish(data, draftCaps)
      return
    }

    // Generic path: defensively measure size and swallow anything
    // unserialisable so the shell cannot be crashed from inside the cage.
    let json = ''
    let bytes = 0
    try {
      json = JSON.stringify(data ?? null)
      bytes = Buffer.byteLength(json)
    } catch {
      record({ type: 'emit-rejected', reason: 'data not serialisable' })
      return
    }
    if (bytes > MAX_EMIT_BYTES) {
      record({ type: 'emit-rejected', reason: `payload too large (${bytes} bytes)` })
      return
    }
    // Store size + a short content hash, NEVER the payload — a flood of
    // ≤256 KB messages must not grow the main-process log without bound
    // (P0-3). The payload is retained only in the test-only capture buffer.
    const hash = createHash('sha256').update(json).digest('hex').slice(0, 16)
    record({ type: 'emit', channel, bytes, hash })
    recordTestEmit(channel, data, bytes)
  })
}

/** Receipt side of `emit("publish", …)`: validate the draft shape, enforce the
 *  caps, hash inline blobs into an attachment table, and record the draft.
 *  Nothing is granted: signing, sealing, and the review/confirm UI are later
 *  phases; the thing never learns whether anything was accepted. */
function handlePublish(data: unknown, caps: DraftCaps): void {
  const result = validateDraft(data, caps)
  if (!result.ok) {
    record({ type: 'emit-rejected', reason: result.reason })
    return
  }
  // LATER: persist to a real drafts area and hand to the review/sign flow.
  cageGlobals.drafts.push(result.draft)
  record({
    type: 'draft-recorded',
    draftType: result.draft.type,
    att: result.draft.att,
    argsBytes: result.argsBytes,
    blobBytes: result.blobBytes
  })
}

/** Bind a cage's bridge data at mount time. */
export function bindCage(webContentsId: number, binding: CageBinding): void {
  bindings.set(webContentsId, binding)
}

/** Forget a cage when it is torn down. */
export function unbindCage(webContentsId: number): void {
  bindings.delete(webContentsId)
}
