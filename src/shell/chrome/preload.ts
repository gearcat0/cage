import { contextBridge, ipcRenderer } from 'electron'

// ── Shell chrome preload ─────────────────────────────────────────────────────
// The TRUSTED chrome renderer's bridge to the shell main. This is NOT the cage
// preload (src/preload/index.ts) — that one is the untrusted thing's surface.
// The chrome draws the feed, omnibar, per-thing trust header, and confirm
// dialogs; every trust signal and every human-confirmation decision lives here,
// in pixels the thing cannot reach.

const shell = {
  identity: (): Promise<{ address: string; nostrPubkey: string; keyStorage: 'os' | 'software' }> =>
    ipcRenderer.invoke('shell:identity'),
  feed: (query?: unknown): Promise<unknown[]> => ipcRenderer.invoke('shell:feed', query ?? {}),
  ingest: (base64: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:ingest', base64),
  fetch: (locator: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:fetch', locator),
  /** Author a thing: HTML program (+ optional attachments) → signed .thing,
   *  ingested locally and offered for Save. */
  compose: (input: {
    programBase64: string
    type: string
    attachments?: { name: string; base64: string; mime?: string }[]
  }): Promise<{ outcome: Record<string, unknown>; path: string | null }> => ipcRenderer.invoke('shell:compose', input),
  open: (envelopeHash: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:open', envelopeHash),
  close: (): Promise<void> => ipcRenderer.invoke('shell:close'),
  /** Switch the open thing's view/edit mode; main answers the applied mode. */
  setMode: (mode: 'view' | 'edit'): Promise<'view' | 'edit'> => ipcRenderer.invoke('shell:set-mode', mode),
  /** Main pushes the authoritative mode (set on open and on every switch). */
  onModeChanged: (cb: (mode: 'view' | 'edit') => void): void => {
    ipcRenderer.on('shell:mode-changed', (_e, p: { mode: 'view' | 'edit' }) => cb(p.mode))
  },
  /** Main pushes this after the feed changes (e.g. an ingest). */
  onFeedChanged: (cb: () => void): void => {
    ipcRenderer.on('shell:feed-changed', () => cb())
  },
  /** Main pushes a publish request here; the human decides in chrome. */
  onConfirmRequest: (cb: (req: { id: number; kind: string; summary: Record<string, unknown> }) => void): void => {
    ipcRenderer.on('shell:confirm-request', (_e, req) => cb(req))
  },
  respondConfirm: (id: number, approved: boolean): void => {
    ipcRenderer.send('shell:confirm-response', id, approved)
  },
  /** Main pushes the outcome of an approved publish (admission summary). */
  onPublishResult: (cb: (outcome: Record<string, unknown>) => void): void => {
    ipcRenderer.on('shell:publish-result', (_e, outcome) => cb(outcome))
  }
}

contextBridge.exposeInMainWorld('shell', Object.freeze(shell))
