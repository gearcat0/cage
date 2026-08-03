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
  /** Main pushes the authoritative mode, whether an unpublished-draft preview
   *  is mounted, and whether a draft exists to publish (set on open, on every
   *  switch, and whenever the draft/preview state changes). */
  onModeChanged: (cb: (p: { mode: 'view' | 'edit'; preview: boolean; publishable: boolean }) => void): void => {
    ipcRenderer.on(
      'shell:mode-changed',
      (_e, p: { mode: 'view' | 'edit'; preview: boolean; publishable: boolean }) => cb(p)
    )
  },
  /** Raise the publish confirm for the open thing's LATEST streamed draft —
   *  exactly what the preview shows. The human decides in the confirm modal. */
  publishDraft: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:publish'),
  /** Copy a thing: a new instance, same program/args, signed by this identity. */
  copyThing: (envelopeHash: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:copy', envelopeHash),
  /** Delete a thing from the library (index row + blob GC + seed removal). */
  deleteThing: (envelopeHash: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('shell:delete', envelopeHash),
  /** Announce a chrome modal overlay opening (+1) / closing (-1) so main can
   *  hide the cage views, which would otherwise overpaint the modal. */
  overlay: (delta: 1 | -1): void => {
    ipcRenderer.send('shell:overlay', delta)
  },
  /** Derive the first accounts of a BIP-39 phrase (addresses only). */
  accountAccounts: (mnemonic: string, count?: number): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:account-accounts', mnemonic, count),
  /** Replace the identity from a phrase+index or a raw private key. Restarts
   *  the app on success (unless suppressed for tests). */
  accountImport: (input: { mnemonic: string; index: number } | { privkeyHex: string }): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:account-import', input),
  /** A fresh 12-word phrase + its account-0 address; main retains nothing. */
  accountGenerate: (): Promise<{ mnemonic: string; address: string }> => ipcRenderer.invoke('shell:account-generate'),
  /** The current private key — human-confirmed backup flow only. */
  accountExport: (): Promise<{ privkeyHex: string }> => ipcRenderer.invoke('shell:account-export'),
  /** Types the user can make something of: built-in starters + programs
   *  already in the library. */
  knownTypes: (): Promise<unknown[]> => ipcRenderer.invoke('shell:known-types'),
  /** Local, unsigned drafts (newest edit first). */
  drafts: (): Promise<unknown[]> => ipcRenderer.invoke('shell:drafts'),
  /** Start a draft of a known type; returns its id. */
  newDraft: (key: string): Promise<{ id?: string; type?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-draft', key),
  deleteDraft: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('shell:delete-draft', id),
  /** Main pushes this when the File menu's Account & Keys… is chosen. */
  onOpenAccount: (cb: () => void): void => {
    ipcRenderer.on('shell:open-account', () => cb())
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
