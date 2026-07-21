import { randomUUID } from 'node:crypto'
import type { BaseWindow, WebContentsView, Rectangle } from 'electron'
import { createCage } from '../../main/cage.js'
import { bindCage, unbindCage, type ThingArgs } from '../../main/bridge.js'
import type { CageResources, ResourceMap } from '../../main/protocol.js'
import type { AttachmentTable } from '../../main/store.js'
import { toHex } from '../../format/index.js'
import type { StoredThing } from '../library/index.js'

// ── Mount — admitted thing → cage (brief §5) ─────────────────────────────────
// Build CageResources from a stored (admitted, verified) thing, create a
// hardened cage with a fresh random id, hand it the decoded ThingArgs via the
// bridge, and place its view beneath the chrome strip. The trust signals live
// in the chrome (a sibling native view); the thing only ever draws inside its
// own rectangle.

const PROGRAM_MIME = 'text/html; charset=utf-8'

// Cage id uniqueness invariant (cage prereq #4): a reused id would share a
// session. Mint fresh, tracked.
const mintedIds = new Set<string>()
function mintCageId(): string {
  for (let i = 0; i < 8; i++) {
    const id = randomUUID()
    if (!mintedIds.has(id)) {
      mintedIds.add(id)
      return id
    }
  }
  throw new Error('cage id mint failed (randomUUID collision)')
}

export interface MountedThing {
  id: string
  view: WebContentsView
  envelopeHash: string
  /** Public trust facts for the chrome header (identity is chrome's job). */
  header: {
    type: string
    authorScheme: string
    authorKey: string
    envelopeHash: string
    sealed: boolean
    isFork: boolean
  }
  destroy(): void
}

export interface MountOptions {
  win: BaseWindow
  preloadPath: string
  stored: StoredThing
  /** Rect the cage view occupies (below the chrome strip). */
  bounds: Rectangle
}

/** Mount a stored thing and return the live view + header facts. Attachments
 *  are served from the thing's store — the on-disk CAS for public things, the
 *  ephemeral in-memory store for sealed ones (§7.1). */
export async function mountThing(opts: MountOptions): Promise<MountedThing> {
  const { win, preloadPath, stored } = opts
  const id = mintCageId()

  // Attachment table (name -> hash/mime/size) from the manifest.
  const attachments: AttachmentTable = new Map()
  for (const [name, att] of stored.manifest.att) {
    attachments.set(name, { hash: toHex(att.h), mime: att.m, size: att.n })
  }

  const resources: ResourceMap = new Map()
  const cageResources: CageResources = {
    blobs: new Map([['index.html', { mime: PROGRAM_MIME, bytes: stored.program }]]),
    attachments,
    store: stored.store
  }
  resources.set(id, cageResources)

  const handle = await createCage({ id, preloadPath, resources })

  // The decoded, read-only view the thing renders from — NEVER the envelope.
  const thingArgs: ThingArgs = {
    type: stored.manifest.type,
    args: stored.manifest.args as ThingArgs['args'],
    attachments: [...attachments.entries()].map(([name, e]) => ({ name, mime: e.mime, size: e.size }))
  }
  const wc = handle.view.webContents
  bindCage(wc.id, { thingId: id, thingArgs, attachments })

  win.contentView.addChildView(handle.view)
  handle.view.setBounds(opts.bounds)

  wc.once('destroyed', () => {
    unbindCage(wc.id)
    resources.delete(id)
    mintedIds.delete(id)
  })

  await wc.loadURL(`thing://${id}/index.html`)

  const env = stored.row
  return {
    id,
    view: handle.view,
    envelopeHash: env.envelopeHash,
    header: {
      type: env.type,
      authorScheme: env.authorScheme,
      authorKey: env.authorKey,
      envelopeHash: env.envelopeHash,
      sealed: env.sealed,
      isFork: env.isFork
    },
    destroy: () => {
      try {
        win.contentView.removeChildView(handle.view)
      } catch {
        /* already removed */
      }
      handle.view.webContents.close()
    }
  }
}
