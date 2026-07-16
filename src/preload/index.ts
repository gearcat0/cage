import { contextBridge, ipcRenderer } from 'electron'

// ── The bridge (renderer side) ───────────────────────────────────────────────
// This preload runs with `sandbox: true` and `contextIsolation: true`. It is the
// ENTIRE trusted surface a thing can see. It exposes exactly two functions on a
// frozen object and nothing else — no ipcRenderer, no require, no Node.
//
// Phase 1 contract:
//   getArgs()            -> the fixed test payload for this thing (structured).
//   emit(channel, data)  -> forward a message to the shell (which logs it).
//
// Explicitly NOT exposed: signing, decryption, network, filesystem, storage,
// require/Node APIs. Adding anything here widens the thing's authority, so this
// file should change rarely and be reviewed hard.

const bridge = Object.freeze({
  getArgs(): unknown {
    // Synchronous by design: a thing renders from its args on first paint.
    return ipcRenderer.sendSync('cage:getArgs')
  },
  emit(channel: string, data: unknown): void {
    ipcRenderer.send('cage:emit', channel, data)
  }
})

contextBridge.exposeInMainWorld('bridge', bridge)
