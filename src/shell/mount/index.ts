import { randomUUID } from 'node:crypto'
import type { BaseWindow, WebContentsView, Rectangle } from 'electron'
import { createCage } from '../../main/cage.js'
import { bindCage, unbindCage, type ThingArgs, type ThingMode } from '../../main/bridge.js'
import type { CageResources, ResourceMap } from '../../main/protocol.js'
import type { AttachmentTable } from '../../main/store.js'
import { cborToJs, toHex } from '../../format/index.js'
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
  /** The render mode handed to the program via getArgs(). */
  mode: ThingMode
  /** Attach the view hidden (default visible). A background mount — e.g. a
   *  live-preview remount — must not steal focus or paint over the active
   *  cage while it loads; the caller reveals it via setVisible later. */
  visible?: boolean
  /** The app-level zoom factor. A cage must be BORN at the current zoom:
   *  correcting it after the fact leaves a window where a freshly mounted
   *  cage (e.g. a live-preview remount) renders at 1.0 while its siblings
   *  are zoomed. */
  zoomFactor?: number
  /** Called with the cage's webContents id once the bridge is bound — BEFORE
   *  the program loads, so anything keyed on the id (e.g. the publish confirm
   *  flow) is in place for emits that fire during the load itself. */
  onBound?: (webContentsId: number) => void
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
    // Decoded args are CborMaps, which don't survive the context bridge into
    // the thing — hand over the plain-JS shape instead.
    args: cborToJs(stored.manifest.args),
    attachments: [...attachments.entries()].map(([name, e]) => ({ name, mime: e.mime, size: e.size })),
    mode: opts.mode
  }
  const wc = handle.view.webContents
  let destroyed = false
  bindCage(wc.id, { thingId: id, thingArgs, attachments })
  opts.onBound?.(wc.id)

  // Visibility is set BEFORE attaching: a hidden mount must never flash or
  // grab focus during its load.
  handle.view.setVisible(opts.visible ?? true)
  win.contentView.addChildView(handle.view)
  handle.view.setBounds(opts.bounds)

  wc.once('destroyed', () => {
    unbindCage(wc.id)
    resources.delete(id)
    mintedIds.delete(id)
  })

  if (opts.zoomFactor !== undefined && opts.zoomFactor !== 1) {
    // Set before AND after the load: Electron resets the factor across some
    // navigations, and the post-load set is what actually sticks.
    wc.setZoomFactor(opts.zoomFactor)
    wc.once('did-finish-load', () => {
      if (!wc.isDestroyed()) wc.setZoomFactor(opts.zoomFactor!)
    })
  }

  await wc.loadURL(`thing://${id}/index.html`)
  if (opts.zoomFactor !== undefined && !wc.isDestroyed()) wc.setZoomFactor(opts.zoomFactor)

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
      // Idempotent, and guarded against a view that is already gone. A cage is
      // torn down from several places -- destroyCurrent, preview supersession,
      // a render-process-gone handler -- so a second call is normal, and
      // calling into a freed native view is not a catchable error.
      //
      // Deliberately does NOT stop an in-flight load. An earlier version did,
      // reasoning that closing a loading view was the crash; measurement said
      // otherwise (it crashed at the same rate), and stop() actively harms --
      // it rejects the pending loadURL inside mountThing with ERR_FAILED,
      // which surfaces as "Error occurred in handler for 'shell:open'". The
      // real fix for the crash is the barrier in openThing.
      if (destroyed) return
      destroyed = true
      const wc = handle.view.webContents
      // Hidden before detaching: a torn-down cage should stop being drawn
      // before it stops existing.
      try {
        if (!wc.isDestroyed()) handle.view.setVisible(false)
      } catch {
        /* already gone */
      }
      try {
        if (!win.isDestroyed()) win.contentView.removeChildView(handle.view)
      } catch {
        /* already removed, or the window went first */
      }
      try {
        if (!wc.isDestroyed()) wc.close()
      } catch {
        /* already closed */
      }
    }
  }
}
