import { contextBridge, ipcRenderer } from 'electron'

// ── Shell chrome preload ─────────────────────────────────────────────────────
// The TRUSTED chrome renderer's bridge to the shell main. This is NOT the cage
// preload (src/preload/index.ts) — that one is the untrusted thing's surface.
// The chrome draws the feed, omnibar, per-thing trust header, and confirm
// dialogs; every trust signal and every human-confirmation decision lives here,
// in pixels the thing cannot reach.

export interface DownloadRow {
  id: string
  magnet: string
  infoHash: string
  name: string
  state: string
  bytes: number
  downloaded: number
  progress: number
  downloadSpeed: number
  peersConnected: number
  peersDiscovered: number
  silentSources: string[]
  error: string | null
  startedAt: number
}
export interface TransferState {
  downloads: DownloadRow[]
  sharing: { envelopeHash: string; magnet: string; peers: number; bytes: number; type?: string }[]
}

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
  /** Start an attestation about a thing, and read the ones pointing at it. */
  /** Everyone whose things you hold, and YOUR name for them. Local only. */
  people: (): Promise<
    { authorScheme: string; authorKey: string; name: string | null; note: string; things: number; lastSeen: number }[]
  > => ipcRenderer.invoke('shell:people'),
  setPetname: (p: { scheme: string; key: string; name: string; note?: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('shell:set-petname', p),
  onOpenPeople: (cb: () => void): void => {
    ipcRenderer.on('shell:open-people', () => cb())
  },
  newAttestation: (targetHash: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-attestation', targetHash),
  attestations: (targetHash: string): Promise<{ count: number; rows: unknown[]; fromTribe: number }> =>
    ipcRenderer.invoke('shell:attestations', targetHash),
  /** Add your signature to a document somebody else signed, and read who has
   *  signed one. The document is the MANIFEST, so it is keyed by manifest hash. */
  cosign: (envelopeHash: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:cosign', envelopeHash),
  document: (manifestHash: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:document', manifestHash),
  /** Start a vouch for a KEY (the shell seeds the subject, as with comments),
   *  and read who vouches for one. */
  newVouch: (scheme: string, key: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-vouch', scheme, key),
  vouchesFor: (
    scheme: string,
    key: string
  ): Promise<{
    rows: { voucherScheme: string; voucherKey: string; name: string; relation: string; petname: string | null; hops: number | null }[]
    count: number
    fromTribe: number
    hops: number | null
  }> => ipcRenderer.invoke('shell:vouches-for', scheme, key),
  /** Save a thing to a .thing file the human picks — the ORIGINAL admitted
   *  bytes, so it stays signed by its author and keeps its envelope hash. */
  exportThing: (envelopeHash: string): Promise<{ path: string | null; error?: string }> =>
    ipcRenderer.invoke('shell:export', envelopeHash),
  /** The same bytes as exportThing, base64 for the clipboard — what the Ingest
   *  box's paste path takes, so a thing can move machines with no network. */
  exportBase64: (envelopeHash: string): Promise<{ base64?: string; bytes?: number; error?: string }> =>
    ipcRenderer.invoke('shell:export-base64', envelopeHash),
  /** Start/stop serving a thing to peers over BitTorrent, and what is being
   *  served right now (live peer counts). */
  onOpenSharing: (cb: () => void): void => {
    ipcRenderer.on('shell:open-sharing', () => cb())
  },
  /** Start a NEW VERSION of a thing, read a chain's history, and ask which
   *  groups currently list a key. */
  amend: (envelopeHash: string): Promise<{ id?: string; error?: string; seq?: number }> =>
    ipcRenderer.invoke('shell:amend', envelopeHash),
  history: (authorKey: string, path: string): Promise<Record<string, unknown>[]> =>
    ipcRenderer.invoke('shell:history', authorKey, path),
  groupsListing: (scheme: string, key: string): Promise<{ envelopeHash: string; name: string; petname: string | null }[]> =>
    ipcRenderer.invoke('shell:groups-listing', scheme, key),
  /** Everything this shell is doing on the network: what it is fetching, and
   *  what it is serving. Pushed while anything is in flight, so a long transfer
   *  is watched rather than sampled. */
  transfers: (): Promise<TransferState> => ipcRenderer.invoke('shell:transfers'),
  cancelTransfer: (id: string): Promise<{ cancelled: boolean }> => ipcRenderer.invoke('shell:transfer-cancel', id),
  onTransfers: (cb: (s: TransferState) => void): void => {
    ipcRenderer.on('shell:transfers', (_e, s: TransferState) => cb(s))
  },
  seedStart: (envelopeHash: string): Promise<{ magnet?: string; error?: string }> =>
    ipcRenderer.invoke('shell:seed-start', envelopeHash),
  seedStop: (envelopeHash: string): Promise<{ stopped: boolean }> =>
    ipcRenderer.invoke('shell:seed-stop', envelopeHash),
  seedStatus: (): Promise<{ envelopeHash: string; magnet: string; peers: number; bytes: number; type: string }[]> =>
    ipcRenderer.invoke('shell:seed-status'),
  /** Things a relay says exist that you do not hold, and the press that
   *  fetches one. Nothing in the shell follows a pointer on its own. */
  offers: (inGroup?: string): Promise<Record<string, unknown>[]> => ipcRenderer.invoke('shell:offers', inGroup),
  fetchOffer: (envelopeHash: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:fetch-offer', envelopeHash),
  /** Votes. A vote is about a THING; saying you know a KEY is a vouch, and
   *  the shell keeps them apart because it walks vouch edges to build your
   *  tribe. Casting one signs immediately — the click was the intent. */
  vote: (envelopeHash: string, dir: 1 | -1): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:vote', envelopeHash, dir),
  votes: (envelopeHash: string): Promise<Record<string, number>> =>
    ipcRenderer.invoke('shell:votes', envelopeHash),
  /** The whole conversation under a thing, each entry with parent and depth. */
  thread: (envelopeHash: string): Promise<{ rows: Record<string, unknown>[]; count: number }> =>
    ipcRenderer.invoke('shell:thread', envelopeHash),
  /** Forums: a forum is a group, so these read the groups you already hold. */
  forums: (): Promise<Record<string, unknown>[]> => ipcRenderer.invoke('shell:forums'),
  forum: (rootHash: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:forum', rootHash),
  forumListing: (rootHash: string): Promise<{ rows: Record<string, unknown>[]; tribeEmpty: boolean }> =>
    ipcRenderer.invoke('shell:forum-listing', rootHash),
  newForumPost: (rootHash: string, starterKey?: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:forum-post', rootHash, starterKey),
  requestJoin: (rootHash: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:request-join', rootHash),
  newVerdict: (targetHash: string, rootHash: string, verdict: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-verdict', targetHash, rootHash, verdict),
  onOpenForums: (cb: () => void): void => {
    ipcRenderer.on('shell:open-forums', () => cb())
  },
  /** Relays: a way for a thing to reach someone who never asked for it.
   *  Nothing is connected to and nothing is posted unless the human says so. */
  relays: (): Promise<{
    relays: { url: string; state: string; error: string | null; received: number; refused: number }[]
    since: number
  }> => ipcRenderer.invoke('shell:relays'),
  addRelay: (url: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:relay-add', url),
  /** The project's suggested relay and welcome forum: what is on offer, and
   *  the one call that acts on the human's yes. Never invoked on load. */
  community: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:community'),
  joinCommunity: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:community-join'),
  removeRelay: (url: string): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:relay-remove', url),
  postToRelays: (envelopeHash: string): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('shell:relay-post', envelopeHash),
  /** Who OFFERED us a thing on a relay — never who authored it. */
  relayArrivals: (
    envelopeHash: string
  ): Promise<{ relayUrl: string; poster: string; selfPosted: boolean; at: number }[]> =>
    ipcRenderer.invoke('shell:relay-arrivals', envelopeHash),
  onOpenRelays: (cb: () => void): void => {
    ipcRenderer.on('shell:open-relays', () => cb())
  },
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
  newDraft: (key: string, args?: unknown): Promise<{ id?: string; type?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-draft', key, args),
  /** Start a comment on a thing; the shell seeds the target into its args. */
  newComment: (targetHash: string): Promise<{ id?: string; error?: string }> =>
    ipcRenderer.invoke('shell:new-comment', targetHash),
  /** Things in this library claiming to reply to a hash. */
  replies: (targetHash: string): Promise<{ count: number; rows: Record<string, unknown>[] }> =>
    ipcRenderer.invoke('shell:replies', targetHash),
  deleteDraft: (id: string): Promise<{ deleted: boolean }> => ipcRenderer.invoke('shell:delete-draft', id),
  /** Main opened a thing on its own initiative (a double-clicked file, the
   *  first-run welcome); the chrome follows so its header matches the mount. */
  onOpenedThing: (cb: (p: { envelopeHash: string }) => void): void => {
    ipcRenderer.on('shell:opened-thing', (_e, p: { envelopeHash: string }) => cb(p))
  },
  /** The same, for an open that happened before the chrome was listening. */
  pendingOpen: (): Promise<string | null> => ipcRenderer.invoke('shell:pending-open'),
  /** Main pushes the outcome of a .thing opened from the desktop. */
  onFileOpened: (cb: (r: Record<string, unknown>) => void): void => {
    ipcRenderer.on('shell:file-opened', (_e, r) => cb(r))
  },
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
  },
  // ── Updates: every network step is a human's yes (src/shell/update) ────────
  updateStatus: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:update-status'),
  updateCheck: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:update-check'),
  updateSetPref: (p: 'on' | 'off'): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:update-set-pref', p),
  updateDownload: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('shell:update-download'),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke('shell:update-install'),
  updateOpenRelease: (): Promise<boolean> => ipcRenderer.invoke('shell:update-open-release'),
  /** Main pushes the update state as it changes (found, progress, ready). */
  onUpdateState: (cb: (s: Record<string, unknown>) => void): void => {
    ipcRenderer.on('shell:update-state', (_e, s) => cb(s))
  },
  /** Help → Check for updates… */
  onOpenUpdates: (cb: () => void): void => {
    ipcRenderer.on('shell:open-updates', () => cb())
  }
}

contextBridge.exposeInMainWorld('shell', Object.freeze(shell))
