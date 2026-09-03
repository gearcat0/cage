import { contextBridge, ipcRenderer } from 'electron'

// DIAGNOSTIC flag only. A sandboxed preload has a reduced `process`, so read it
// defensively and default to off: a probe must never be the reason the bridge
// fails to load.
let probeEmits = false
try {
  probeEmits = process.env.SHELL_EXIT_LOG !== undefined
} catch {
  probeEmits = false
}

// ── The bridge (renderer side) ───────────────────────────────────────────────
// This preload runs with `sandbox: true` and `contextIsolation: true`. It is the
// ENTIRE trusted surface a thing can see. It exposes exactly four functions on a
// frozen object and nothing else — no ipcRenderer, no require, no Node.
//
// Phase 2 contract:
//   getArgs()            -> decoded, read-only ThingArgs view (type/args/
//                           attachment names+metadata). NEVER the envelope:
//                           author/signature/timestamp live in chrome pixels
//                           the thing cannot touch.
//   getBlob(name)        -> a thing:// URL for a named attachment, or null.
//                           A string, not bytes — the protocol handler streams.
//   viewerInfo()         -> coarse, non-identifying: locale + colour scheme.
//   emit(channel, data)  -> fire-and-forget request; grants nothing. The thing
//                           cannot observe whether a human confirmed anything.
//
// getArgs/getBlob/viewerInfo are synchronous because a thing renders from them
// on first paint, and none of them moves large data.
//
// Explicitly NOT exposed: signing, decryption, network, filesystem, storage,
// require/Node APIs. Adding anything here widens the thing's authority, so this
// file should change rarely and be reviewed hard.
//
// LATER: bridge.requestFile() (shell-mediated file picking for publish drafts);
// a request/response emit variant. Neither exists in phase 2.

const bridge = Object.freeze({
  getArgs(): unknown {
    // Synchronous by design: a thing renders from its args on first paint.
    return ipcRenderer.sendSync('cage:getArgs')
  },
  getBlob(name: string): string | null {
    // Cheap: only computes a URL. The bytes stream through the thing://
    // handler, which is the actual authorization gate (table lookup + 404).
    return ipcRenderer.sendSync('cage:getBlob', name)
  },
  viewerInfo(): unknown {
    return ipcRenderer.sendSync('cage:viewerInfo')
  },
  emit(channel: string, data: unknown): void {
    // DIAGNOSTIC: say that the program CALLED emit, before the send. Main
    // records what it receives; without this there is no way to tell a
    // program that stopped emitting from an emit lost in transit. Console
    // only -- the preload has no filesystem, and the bridge surface the
    // program sees is unchanged.
    if (probeEmits) {
      try {
        // eslint-disable-next-line no-console
        console.log(`[bridge-probe] emit ${channel}`)
      } catch {
        /* never let a probe break the bridge */
      }
    }
    ipcRenderer.send('cage:emit', channel, data)
  }
})

contextBridge.exposeInMainWorld('bridge', bridge)
