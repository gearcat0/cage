import { ipcMain } from 'electron'
import { record } from './events.js'

// ── The bridge (shell side) ──────────────────────────────────────────────────
// The trusted half of the tiny message bridge. Phase 1 exposes exactly two
// capabilities and NOTHING else — no signing, decryption, network, filesystem,
// or storage. See src/preload/index.ts for the renderer-facing frozen surface.

/** Per-webContents args payload returned by the thing's getArgs(). */
const argsByContents = new Map<number, unknown>()

// Cap emit payloads so a malicious thing cannot exhaust shell memory by flooding
// giant messages. The bridge grants nothing regardless; this just keeps the
// shell responsive under abuse (see the "bridge abuse" attacks).
const MAX_EMIT_BYTES = 256 * 1024

let installed = false

/** Install the IPC handlers once. Idempotent. */
export function installBridge(): void {
  if (installed) return
  installed = true

  // getArgs(): synchronous so a thing can render from its args on first paint.
  // Returns a structured clone of the fixed test payload for this thing.
  ipcMain.on('cage:getArgs', (event) => {
    event.returnValue = argsByContents.get(event.sender.id) ?? null
  })

  // emit(channel, data): forward to the shell, which for now just logs it.
  // No capability is granted, ever. We defensively measure size and swallow
  // anything unserialisable so the shell cannot be crashed from inside the cage.
  ipcMain.on('cage:emit', (_event, channel: unknown, data: unknown) => {
    if (typeof channel !== 'string') {
      record({ type: 'emit-rejected', reason: 'channel not a string' })
      return
    }
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(data ?? null))
    } catch {
      record({ type: 'emit-rejected', reason: 'data not serialisable' })
      return
    }
    if (bytes > MAX_EMIT_BYTES) {
      record({ type: 'emit-rejected', reason: `payload too large (${bytes} bytes)` })
      return
    }
    record({ type: 'emit', channel, data, bytes })
  })
}

/** Set the args a given cage's getArgs() will return. */
export function setArgsFor(webContentsId: number, args: unknown): void {
  argsByContents.set(webContentsId, args)
}

/** Forget a cage's args when it is torn down. */
export function clearArgsFor(webContentsId: number): void {
  argsByContents.delete(webContentsId)
}
