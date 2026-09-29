import './evm-ui.css'
import './shell.css'
import { shortAddress, toChecksumAddress } from '../address.js'

// ── The shell chrome (trusted renderer) ──────────────────────────────────────
// Draws the omnibar, feed, per-thing trust header, and confirm dialogs. Every
// trust signal lives here, in chrome pixels the thing cannot reach (the thing
// renders into a separate native view composited into the main area only).
// Styled with the evm-ui design language (dark, teal accent) via CSS classes.

interface ShellApi {
  identity(): Promise<{ address: string; nostrPubkey: string; keyStorage: 'os' | 'software' }>
  feed(query?: unknown): Promise<ThingRow[]>
  ingest(base64: string): Promise<Outcome>
  fetch(locator: string): Promise<Outcome>
  compose(input: {
    programBase64: string
    type: string
    attachments?: { name: string; base64: string; mime?: string }[]
  }): Promise<{ outcome: Outcome; path: string | null }>
  open(envelopeHash: string): Promise<HeaderFacts>
  onOpenedThing(cb: (p: { envelopeHash: string }) => void): void
  pendingOpen(): Promise<string | null>
  close(): Promise<void>
  setMode(mode: 'view' | 'edit'): Promise<'view' | 'edit'>
  onModeChanged(cb: (p: { mode: 'view' | 'edit'; preview: boolean; publishable: boolean }) => void): void
  publishDraft(): Promise<Record<string, unknown>>
  copyThing(envelopeHash: string): Promise<Record<string, unknown>>
  exportThing(envelopeHash: string): Promise<{ path: string | null; error?: string }>
  exportBase64(envelopeHash: string): Promise<{ base64?: string; bytes?: number; error?: string }>
  seedStart(envelopeHash: string): Promise<{ magnet?: string; error?: string }>
  seedStop(envelopeHash: string): Promise<{ stopped: boolean }>
  seedStatus(): Promise<{ envelopeHash: string; magnet: string; peers: number; bytes: number; type: string }[]>
  offers(inGroup?: string): Promise<OfferRow[]>
  fetchOffer(envelopeHash: string): Promise<Record<string, unknown>>
  vote(envelopeHash: string, dir: 1 | -1): Promise<Record<string, unknown>>
  votes(envelopeHash: string): Promise<Record<string, number>>
  thread(envelopeHash: string): Promise<{ rows: Record<string, unknown>[]; count: number }>
  forums(): Promise<Record<string, unknown>[]>
  forum(rootHash: string): Promise<Record<string, unknown>>
  forumListing(rootHash: string): Promise<{ rows: Record<string, unknown>[]; tribeEmpty: boolean }>
  newForumPost(rootHash: string, starterKey?: string): Promise<{ id?: string; error?: string }>
  requestJoin(rootHash: string): Promise<{ id?: string; error?: string }>
  newVerdict(targetHash: string, rootHash: string, verdict: string): Promise<{ id?: string; error?: string }>
  onOpenForums(cb: () => void): void
  relays(): Promise<{
    relays: { url: string; state: string; error: string | null; received: number; refused: number }[]
    since: number
  }>
  addRelay(url: string): Promise<Record<string, unknown>>
  community(): Promise<CommunityState>
  joinCommunity(): Promise<CommunityState & { error?: string }>
  removeRelay(url: string): Promise<Record<string, unknown>>
  postToRelays(envelopeHash: string): Promise<Record<string, unknown>>
  relayArrivals(envelopeHash: string): Promise<{ relayUrl: string; poster: string; selfPosted: boolean; at: number }[]>
  onOpenRelays(cb: () => void): void
  deleteThing(envelopeHash: string): Promise<{ deleted: boolean }>
  overlay(delta: 1 | -1): void
  accountAccounts(mnemonic: string, count?: number): Promise<
    { ok: true; accounts: { index: number; address: string }[] } | { ok: false; error: string }
  >
  accountImport(
    input: { mnemonic: string; index: number } | { privkeyHex: string }
  ): Promise<{ ok: true; address: string; willRestart: boolean } | { ok: false; error: string }>
  accountGenerate(): Promise<{ mnemonic: string; address: string }>
  accountExport(): Promise<{ privkeyHex: string }>
  onOpenAccount(cb: () => void): void
  onOpenSharing(cb: () => void): void
  onFileOpened(cb: (r: Record<string, unknown>) => void): void
  knownTypes(): Promise<KnownTypeEntry[]>
  drafts(): Promise<DraftRow[]>
  newDraft(key: string, args?: unknown): Promise<{ id?: string; type?: string; error?: string }>
  newComment(targetHash: string): Promise<{ id?: string; error?: string }>
  newAttestation(targetHash: string): Promise<{ id?: string; error?: string }>
  people(): Promise<
    { authorScheme: string; authorKey: string; name: string | null; note: string; things: number; lastSeen: number }[]
  >
  setPetname(p: { scheme: string; key: string; name: string; note?: string }): Promise<{ ok: boolean }>
  onOpenPeople(cb: () => void): void
  attestations(targetHash: string): Promise<{ count: number; rows: (ThingRow & { hops: number | null })[]; fromTribe: number }>
  amend(envelopeHash: string): Promise<{ id?: string; error?: string; seq?: number }>
  history(authorKey: string, path: string): Promise<ThingRow[]>
  groupsListing(scheme: string, key: string): Promise<{ envelopeHash: string; name: string; petname: string | null }[]>
  transfers(): Promise<TransferState>
  cancelTransfer(id: string): Promise<{ cancelled: boolean }>
  onTransfers(cb: (s: TransferState) => void): void
  cosign(envelopeHash: string): Promise<{ status?: string; reason?: string; id?: number }>
  document(manifestHash: string): Promise<DocumentFacts>
  newVouch(scheme: string, key: string): Promise<{ id?: string; error?: string }>
  vouchesFor(
    scheme: string,
    key: string
  ): Promise<{
    rows: {
      voucherScheme: string
      voucherKey: string
      name: string
      relation: string
      petname: string | null
      hops: number | null
    }[]
    count: number
    fromTribe: number
    hops: number | null
  }>
  replies(targetHash: string): Promise<{ count: number; rows: ThingRow[] }>
  deleteDraft(id: string): Promise<{ deleted: boolean }>
  onFeedChanged(cb: () => void): void
  onConfirmRequest(cb: (req: { id: number; kind: string; summary: Record<string, unknown> }) => void): void
  respondConfirm(id: number, approved: boolean): void
  onPublishResult(cb: (outcome: Record<string, unknown>) => void): void
  updateStatus(): Promise<UpdateStatus>
  updateCheck(): Promise<UpdateStatus>
  updateSetPref(p: 'on' | 'off'): Promise<UpdateStatus>
  updateDownload(): Promise<UpdateStatus>
  updateInstall(): Promise<boolean>
  updateOpenRelease(): Promise<boolean>
  onUpdateState(cb: (s: UpdateStatus) => void): void
  onOpenUpdates(cb: () => void): void
}
/** Mirrors src/shell/update's UpdateState, plus what the chrome needs. */
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'inactive' }
  | { phase: 'current'; checkedAt: number }
  | { phase: 'available'; version: string; notes: string; canInstall: boolean }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }
interface UpdateStatus {
  pref: 'ask' | 'on' | 'off'
  state: UpdateState
  prompt: boolean
  current: string
}
/** What the project suggests, and how much of it this install already has. */
interface CommunityState {
  relay: string
  relayAdded: boolean
  forumAvailable: boolean
  forumHeld: boolean
  forumHash: string | null
}

interface ThingRow {
  envelopeHash: string
  authorScheme: string
  authorKey: string
  /** What the letter calls itself: sanitized in main, a claim, may be absent. */
  title?: string | null
  type: string
  receivedAt: number
  created: number
  sealed: boolean
  read: boolean
  isFork: boolean
  /** Its place in the author's version chain, when it is in one. */
  path?: string | null
  seq?: number | null
  /** Only on a rolled-up feed: what folded into this row — the whole reply
   *  subtree, and the votes cast on it. */
  activity?: { replies: number; up: number; down: number }
}
/** A thing a relay says exists that you do not hold — a draft in reverse.
 *  Everything here except the hash is the poster's CLAIM, and there is
 *  deliberately no author: nobody has read the envelope yet. */
interface OfferRow {
  envelopeHash: string
  locator: string
  relayUrl: string
  poster: string
  type: string
  inGroup: string | null
  replyTo: string | null
  state: 'offered' | 'fetching' | 'failed'
  reason: string
  seenAt: number
}
interface KnownTypeEntry {
  key: string
  /** Identifier-safe key for data-testids. */
  testKey: string
  source: 'starter' | 'library'
  type: string
  progHash: string
  label: string
  description: string
  count: number
}
interface DraftRow {
  id: string
  type: string
  progHash: string
  args: unknown
  created: number
  updated: number
}
interface HeaderFacts {
  type: string
  authorScheme: string
  authorKey: string
  envelopeHash: string
  sealed: boolean
  isFork: boolean
  /** Verified primary name for the author, or null if none confirmed. */
  name?: string | null
  nameStatus?: 'verified' | 'mismatch' | 'unresolvable' | null
  /** YOUR name for the author. Never shown as verification — see authorLabel. */
  petname?: string | null
  /** True when this is a local, unsigned draft — the header must NOT claim it
   *  is signed. The renderer never parses ids; this is the discriminant. */
  draft?: boolean
  /** What this thing CLAIMS to reply to (unauthenticated), whether that target
   *  is in this library, and how many things claim to reply to THIS one. */
  replyTo?: string | null
  replyToKnown?: boolean
  replyCount?: number
  /** What this thing attests to, and how many things attest to IT. Claims, as
   *  replyTo is — the header labels them, never verifies them. */
  attests?: string | null
  attestsKnown?: boolean
  attestCount?: number
  /** Which forum this claims to belong to, and whether you hold that group.
   *  A claim like replyTo: a roster never consented to what is tagged into it. */
  inGroup?: string | null
  inGroupKnown?: boolean
  /** What the votes on this are worth: the raw counts everyone sees, and the
   *  part of them that came from inside your own tribe. Both, always. */
  votes?: { up: number; down: number; score: number; tribeUp: number; tribeDown: number; tribeScore: number; mine: number } | null
  /** How far the author sits from you through your own vouches, or null for
   *  outside your tribe (and for a draft, which nobody has signed). */
  authorHops?: number | null
  /** Co-signing: several envelopes over ONE manifest. Present only when the
   *  document names signatories -- an ordinary thing is not a contract. */
  cosignable?: boolean
  /** The DOCUMENT's identity — what signatures are grouped by. */
  manifestHash?: string
  signedCount?: number
  namedCount?: number
  namedSignedCount?: number
  unnamedSignedCount?: number
  signedByMe?: boolean
  iAmNamed?: boolean
  /** Where this sits in its author's version chain, and whether the link back
   *  holds up. Null everywhere when the thing is in no chain at all. */
  chainPath?: string | null
  version?: number | null
  versionCount?: number | null
  supersededBy?: string | null
  prevClaimed?: string | null
  prevKnown?: boolean
  prevMatches?: boolean | null
  /** Whether amending continues YOUR line or starts one on someone else's. */
  mine?: boolean
  /** When this thing IS a vouch: the key it speaks about. */
  vouchAbout?: string | null
  vouchAboutScheme?: string | null
  vouchAboutKnown?: boolean
  vouchAboutName?: string | null
}
type Outcome =
  | { status: 'valid'; type: string; author?: { k: string } }
  | { status: 'invalid'; reason: string }
  | { status: 'unverifiable'; scheme: string }
  | { status: 'not-for-me' }
  // A magnet does not resolve here: it STARTS something that may run for hours.
  | { status: 'started'; transferId: string; infoHash: string }

const shell = (window as unknown as { shell: ShellApi }).shell

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}
const short = (hex: string, n = 6): string => (hex.length > 2 * n ? `${hex.slice(0, n)}…${hex.slice(-4)}` : hex)
const fmtTime = (ms: number): string => new Date(ms).toLocaleString()

// ── Layout scaffold ──────────────────────────────────────────────────────────
const app = document.getElementById('app')!
const topbar = el('header', 'sh-topbar')
const feedPane = el('aside', 'sh-feed')
const main = el('section', 'sh-main')
const thingHeader = el('div', 'sh-thing-header')
const cageArea = el('div', 'sh-cage-area') // the native cage view is composited over this
main.append(thingHeader, cageArea)
app.append(topbar, feedPane, main)

// ── Omnibar ──────────────────────────────────────────────────────────────────
const identityEl = el('span', 'evm-address evm-address--muted', 'loading…')
const ingestInput = el('input', 'evm-input evm-input--mono') as HTMLInputElement
ingestInput.placeholder = 'Paste a letter someone sent you — or a magnet:, bundle: or https: link'
ingestInput.setAttribute('aria-label', 'paste bundle or locator')
const ingestBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Ingest') as HTMLButtonElement
const fileBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Open file…') as HTMLButtonElement
const newBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'New') as HTMLButtonElement
newBtn.setAttribute('data-testid', 'new-thing')
const fileInput = el('input') as HTMLInputElement
fileInput.type = 'file'
fileInput.style.display = 'none'
const toast = el('span', 'sh-toast')

// ── What a fetch discloses ───────────────────────────────────────────────────
// Most locators stay on this machine: a file: is a local read, a bundle: hash
// comes out of the seed store. Two do not. Fetching a URL tells that host your
// IP address, and a magnet contacts the swarm, where peers learn it. Seeding
// says this plainly before its toggle; this is the same statement on the
// receiving side, at the moment the human can still change their mind.
//
// It lives IN the topbar row rather than under the input on purpose. The cage
// is a native view composited ABOVE the chrome, so anything drawn into the
// content area is hidden behind it, and making the topbar taller would mean
// moving TOP_BAR (main.ts) — which sets the cage's own offset — on every
// keystroke.
const fetchWarn = el('span', 'evm-badge evm-badge--warning sh-fetchwarn')
fetchWarn.setAttribute('data-testid', 'ingest-disclosure')
fetchWarn.style.display = 'none'

/** What this locator would reveal, or null when it never leaves the machine. */
function fetchDisclosure(input: string): { short: string; full: string } | null {
  const text = input.trim()
  if (/^magnet:/i.test(text)) {
    return {
      short: '⚠ contacts the BitTorrent network',
      full:
        'Fetching this contacts the BitTorrent network: the peers serving it learn your IP address. ' +
        'What arrives is still verified by admission — but who you asked is not private.'
    }
  }
  if (!/^https?:/i.test(text)) return null
  let host: string
  try {
    host = new URL(text).host
  } catch {
    return null // not a URL yet — say nothing until it is
  }
  if (!host) return null
  return {
    short: `⚠ tells ${host} your IP`,
    full:
      `Fetching this tells ${host} your IP address. ` +
      'And a URL is not content-addressed: it names a place, so you get whatever is served there. ' +
      'Admission proves what arrives is a validly signed letter — not that it is the letter you asked for.'
  }
}

function updateFetchDisclosure(): void {
  const d = fetchDisclosure(ingestInput.value)
  if (!d) {
    fetchWarn.style.display = 'none'
    fetchWarn.textContent = ''
    fetchWarn.removeAttribute('title')
    return
  }
  fetchWarn.style.display = ''
  fetchWarn.textContent = d.short
  fetchWarn.title = d.full
}
const keyWarn = el('button', 'evm-badge evm-badge--warning sh-keywarn') as HTMLButtonElement
keyWarn.style.display = 'none'
// Two rows, so the Ingest box can be long enough to READ its own hint.
//
// It is the only control in here whose text has to be read rather than
// recognised -- it is the answer to "what can I paste?" -- and in one row it
// could not be. The hint needs ~550px; the row is 640 CSS px on Linux (the
// chrome runs at SHELL_SCALE=2, so a 1280px window is 640 here) and the other
// controls take ~390px of it. Widening the input inside one row pushed Ingest,
// Open file… and the identity clean off the screen, which is a worse answer
// than a clipped hint. So the input gets a row to itself, with the controls
// that are recognisable at a glance moved below it.
const topRow = el('div', 'sh-topbar-row')
const bottomRow = el('div', 'sh-topbar-row')
topRow.append(ingestInput, fetchWarn, ingestBtn)
bottomRow.append(
  newBtn,
  fileBtn,
  fileInput,
  toast,
  el('span', 'sh-spacer'),
  keyWarn,
  el('span', 'sh-id-label', 'you:'),
  identityEl
)
topbar.append(topRow, bottomRow)

function showToast(o: Outcome): void {
  const tone =
    o.status === 'valid' ? 'success' : o.status === 'invalid' ? 'danger' : o.status === 'unverifiable' ? 'warning' : 'neutral'
  const label =
    o.status === 'valid'
      ? `admitted (${o.type})`
      : o.status === 'invalid'
        ? `INVALID — ${o.reason}`
        : o.status === 'unverifiable'
          ? `unverifiable scheme: ${o.scheme}`
          : 'not for you'
  toast.className = `sh-toast evm-badge evm-badge--${tone}`
  toast.textContent = label
  toast.setAttribute('data-status', o.status)
  window.setTimeout(() => {
    if (toast.getAttribute('data-status') === o.status) toast.textContent = ''
  }, 6000)
}

// A locator (https:/magnet:/bundle:/file:/thing:) or a name (alice.eth, user@host) is
// fetched (naming/transport → admission); anything else is a pasted base64
// bundle ingested directly.
//
// This regex is the ONLY thing choosing fetch over ingest, which is how http(s)
// shipped unreachable from here: the transport existed and its tests passed,
// but they all called fetchLocator directly, so nothing exercised this line and
// a pasted URL was quietly treated as base64.
const FETCHABLE_RE = /^(https?|magnet|bundle|file|thing):|^[a-z0-9-]+(\.[a-z0-9-]+)+$|^[^@\s]+@[^@\s]+$/i

async function doIngest(input: string): Promise<void> {
  const text = input.trim()
  if (!text) return
  const outcome = FETCHABLE_RE.test(text) ? await shell.fetch(text) : await shell.ingest(text)
  // A magnet does not finish here — it starts a transfer that may run for
  // hours. Open the window on it rather than leaving a toast to imply the work
  // is done, or that nothing happened.
  if (outcome.status === 'started' && typeof outcome.transferId === 'string') {
    openTransfersModal(outcome.transferId)
    ingestInput.value = ''
    updateFetchDisclosure()
    return
  }
  showToast(outcome)
  ingestInput.value = ''
  updateFetchDisclosure() // the box is empty now; the warning must go with it
  await refreshFeed()
}
ingestBtn.addEventListener('click', () => void doIngest(ingestInput.value))
ingestInput.addEventListener('input', updateFetchDisclosure)
ingestInput.addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void doIngest(ingestInput.value)
})
fileBtn.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0]
  if (!f) return
  const buf = new Uint8Array(await f.arrayBuffer())
  await doIngest(bytesToBase64(buf))
  fileInput.value = ''
})
// Drag-and-drop a bundle file anywhere.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', async (e) => {
  e.preventDefault()
  const f = (e as DragEvent).dataTransfer?.files?.[0]
  if (!f) return
  const buf = new Uint8Array(await f.arrayBuffer())
  await doIngest(bytesToBase64(buf))
})

// ── Create a thing (author → sign → save) ────────────────────────────────────
const MIME: Record<string, string> = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', wasm: 'application/wasm',
  txt: 'text/plain', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg'
}
const mimeOf = (name: string): string => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
const readAsBase64 = async (f: File): Promise<string> => bytesToBase64(new Uint8Array(await f.arrayBuffer()))

function showText(msg: string, tone: 'success' | 'danger' | 'neutral'): void {
  toast.className = `sh-toast evm-badge evm-badge--${tone}`
  toast.textContent = msg
  toast.setAttribute('data-status', tone)
  window.setTimeout(() => {
    if (toast.textContent === msg) toast.textContent = ''
  }, 8000)
}

/** Announce a modal overlay to main — the cage views hide while any chrome
 *  modal is open (they are native siblings composited ABOVE the chrome and
 *  would overpaint it). Patches remove() so every close path announces the
 *  close without per-modal bookkeeping. */
function trackOverlay(overlay: HTMLElement, onEscape?: () => void): HTMLElement {
  shell.overlay(1)
  // ESC dismisses. Modals that own a decision pass an explicit handler so
  // escaping RESOLVES it (a publish confirm dismissed without a response
  // would leave the cages hidden behind a modal that is no longer there).
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // Overlays stack (a danger dialog over the account modal) and each one
    // listens on the document — only the TOPMOST may take the key, or one
    // press would close the whole stack.
    const open = document.querySelectorAll('.evm-modal-overlay')
    if (open.length && open[open.length - 1] !== overlay) return
    e.preventDefault()
    if (onEscape) onEscape()
    else overlay.remove()
  }
  document.addEventListener('keydown', onKey)
  const origRemove = overlay.remove.bind(overlay)
  let closed = false
  overlay.remove = () => {
    if (!closed) {
      closed = true
      shell.overlay(-1)
      document.removeEventListener('keydown', onKey)
    }
    origRemove()
  }
  return overlay
}

/** A small chrome-local confirm for destructive actions. Resolves the choice. */
function confirmDanger(title: string, text: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', 'evm-modal-overlay')
    const modal = el('div', 'evm-modal')
    const header = el('div', 'evm-modal-header')
    header.append(el('span', 'evm-modal-title', title))
    const body = el('div', 'evm-modal-body')
    body.append(el('p', 'sh-hint', text))
    const footer = el('div', 'evm-modal-footer')
    const cancel = el('button', 'evm-btn evm-btn--ghost', 'Cancel')
    const ok = el('button', 'evm-btn evm-btn--danger', action)
    ok.setAttribute('data-testid', 'danger-confirm')
    cancel.setAttribute('data-testid', 'danger-cancel')
    const done = (v: boolean): void => {
      overlay.remove()
      resolve(v)
    }
    cancel.addEventListener('click', () => done(false))
    ok.addEventListener('click', () => done(true))
    footer.append(cancel, ok)
    modal.append(header, body, footer)
    overlay.append(modal)
    document.body.append(trackOverlay(overlay, () => done(false)))
  })
}

/** Delete via either the header button or a feed row: confirm, delete, and
 *  clear the header if the deleted thing was the open one. */
async function deleteWithConfirm(id: string, type: string, isDraft = false): Promise<void> {
  const ok = isDraft
    ? await confirmDanger(
        'Discard draft',
        `Discard this unsigned ${type} draft? It was never signed and never left this machine, so there is nothing to recall — but the work in it is gone.`,
        'Discard'
      )
    : await confirmDanger(
        'Delete letter',
        `Delete this ${type} from your library? Its bundle stops being seeded from this machine. Copies already shared are unaffected — a signed letter is public and permanent once shared.`,
        'Delete'
      )
  if (!ok) return
  if (isDraft) await shell.deleteDraft(id)
  else await shell.deleteThing(id)
  if (selected === id) {
    selected = null
    renderHeader(null)
  }
  showText(isDraft ? 'Draft discarded' : 'Deleted from your library', 'neutral')
  await refreshFeed()
}

// ── Account & Keys ───────────────────────────────────────────────────────────
// Identity setup for humans: view/copy the identity, back up the secret, or
// replace it from a BIP-39 phrase (MetaMask account picker) or a raw private
// key. Mnemonics live only in this modal's DOM/locals — main derives, persists
// the chosen account key, and never stores the phrase.

/** A labelled value with a Copy button (the evm-copyfield component). Tests
 *  read the value's textContent — never the clipboard. */
function copyField(label: string, value: string, testid: string): HTMLElement {
  const wrap = el('div', 'evm-copyfield')
  const val = el('div', 'evm-copyfield__value', value)
  val.setAttribute('data-testid', testid)
  const btn = el('button', 'evm-copyfield__btn', 'Copy')
  btn.setAttribute('data-testid', `${testid}-copy`)
  btn.addEventListener('click', () => {
    void navigator.clipboard?.writeText(value).catch(() => {})
    btn.textContent = 'Copied'
    btn.classList.add('evm-copyfield__btn--copied')
    window.setTimeout(() => {
      btn.textContent = 'Copy'
      btn.classList.remove('evm-copyfield__btn--copied')
    }, 1500)
  })
  wrap.append(el('div', 'evm-copyfield__label', label), val, btn)
  return wrap
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el('div', 'evm-field')
  wrap.append(el('label', 'evm-field-label', label), control)
  if (hint) wrap.append(el('div', 'evm-field-hint', hint))
  return wrap
}

async function openAccountModal(): Promise<void> {
  const id = await shell.identity()
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-account')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Account & Keys'))
  const body = el('div', 'evm-modal-body')

  /** Every identity replacement passes through here: one confirmation that
   *  names what is actually lost. */
  const confirmReplace = (): Promise<boolean> =>
    confirmDanger(
      'Replace your identity?',
      `This permanently replaces the identity on this machine. Anything sealed to your current nostr key (${short(id.nostrPubkey)}) becomes PERMANENTLY UNOPENABLE — the new key cannot decrypt it. Letters you already authored stay signed by your old address (${shortAddress(id.address)}) and will no longer read as "you". A timestamped backup of the current encrypted key file is kept beside it (identity.key.enc.bak-<time>); restoring that file is the only way back.`,
      'Replace identity'
    )

  async function commit(input: { mnemonic: string; index: number } | { privkeyHex: string }): Promise<void> {
    if (!(await confirmReplace())) return
    try {
      const r = await shell.accountImport(input)
      if (!r.ok) {
        showText(r.error, 'danger')
        return
      }
      if (r.willRestart) {
        showText('Restarting with your new identity…', 'neutral')
      } else {
        overlay.remove()
        showText('New identity written — restart Souspli to use it', 'success')
      }
    } catch {
      // The invoke can reject if the app is already restarting.
      showText('Restarting with your new identity…', 'neutral')
    }
  }

  // ── Your identity ──
  body.append(el('h3', 'sh-account-h', 'Your identity'))
  body.append(copyField('eth address', toChecksumAddress(id.address), 'account-address'))
  body.append(copyField('nostr pubkey', id.nostrPubkey, 'account-nostr'))
  const storage = el(
    'span',
    `evm-badge evm-badge--${id.keyStorage === 'software' ? 'danger' : 'success'}`,
    id.keyStorage === 'software' ? 'key storage: software (not protected)' : 'key storage: OS keychain'
  )
  storage.setAttribute('data-testid', 'account-storage')
  body.append(storage)

  // ── Backup ──
  body.append(el('h3', 'sh-account-h', 'Back up'))
  const backupHint = el(
    'p',
    'sh-hint',
    'Your private key IS your identity — the nostr key derives from it. Anyone who has it can author as you and read everything sealed to you.'
  )
  const reveal = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Reveal private key…') as HTMLButtonElement
  reveal.setAttribute('data-testid', 'account-export-reveal')
  const secretSlot = el('div')
  reveal.addEventListener('click', async () => {
    const ok = await confirmDanger(
      'Reveal private key',
      'Anyone who sees this key IS you — they can author as you and read everything sealed to you, forever. Make sure nobody can see your screen.',
      'Reveal'
    )
    if (!ok) return
    const { privkeyHex } = await shell.accountExport()
    secretSlot.replaceChildren(copyField('private key', privkeyHex, 'account-secret'))
    reveal.disabled = true
  })
  body.append(backupHint, reveal, secretSlot)

  // ── Replace: from a seed phrase ──
  body.append(el('h3', 'sh-account-h', 'Replace identity'))
  const mnemonicInput = el('textarea', 'evm-input evm-input--mono') as HTMLTextAreaElement
  mnemonicInput.setAttribute('data-testid', 'account-mnemonic-input')
  mnemonicInput.placeholder = 'twelve or twenty-four words…'
  mnemonicInput.rows = 2
  body.append(
    field(
      'Seed phrase',
      mnemonicInput,
      'MetaMask path m/44′/60′/0′/0/i. Only the account you pick is stored — the phrase is never saved. Use a throwaway seed, not one holding funds.'
    )
  )
  const seedError = el('div', 'evm-field-error')
  seedError.setAttribute('data-testid', 'account-mnemonic-error')
  const accountList = el('div', 'sh-account-list')
  const deriveBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Derive accounts')
  deriveBtn.setAttribute('data-testid', 'account-derive')
  const moreBtn = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Show more')
  moreBtn.setAttribute('data-testid', 'account-show-more')
  moreBtn.style.display = 'none'
  const useSeedBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Use selected account') as HTMLButtonElement
  useSeedBtn.setAttribute('data-testid', 'account-use-seed')
  useSeedBtn.disabled = true
  useSeedBtn.style.display = 'none'
  let shown = 5
  // The phrase the addresses on screen were derived FROM. The list is a claim
  // about one specific wallet, so it is only meaningful paired with the words
  // that produced it -- keep them together rather than trusting the input to
  // still say the same thing later.
  let derivedFrom: string | null = null
  let deriveSeq = 0

  /** Compare by words, so cosmetic whitespace does not count as a change. */
  const words = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

  function forgetDerived(): void {
    derivedFrom = null
    seedError.textContent = '' // callers set their own message after this
    accountList.replaceChildren()
    moreBtn.style.display = 'none'
    useSeedBtn.style.display = 'none'
    useSeedBtn.disabled = true
    shown = 5
  }

  // Editing the phrase makes the listed addresses a statement about a
  // DIFFERENT wallet. Drop them: leaving them up invites picking an account
  // from one wallet and importing the same index from another -- an identity
  // whose address was never on screen.
  mnemonicInput.addEventListener('input', () => {
    seedError.textContent = '' // a complaint about the old text, now retyped
    if (derivedFrom !== null && words(mnemonicInput.value) !== words(derivedFrom)) forgetDerived()
  })

  async function derive(): Promise<void> {
    const seq = ++deriveSeq
    // Capture the phrase THIS derivation is about; the box may change under us.
    const phrase = mnemonicInput.value
    seedError.textContent = ''
    const r = await shell.accountAccounts(phrase, shown)
    if (seq !== deriveSeq) return // a later derive superseded this one
    if (!r.ok) {
      forgetDerived()
      seedError.textContent = r.error
      return
    }
    derivedFrom = phrase
    accountList.replaceChildren()
    // Nothing is selected in a freshly built list, so the button must not look
    // armed from a selection that no longer exists.
    useSeedBtn.disabled = true
    for (const acct of r.accounts) {
      const row = el('label', 'sh-account-row')
      const radio = el('input') as HTMLInputElement
      radio.type = 'radio'
      radio.name = 'hd-account'
      radio.value = String(acct.index)
      radio.setAttribute('data-testid', `account-option-${acct.index}`)
      radio.addEventListener('change', () => {
        useSeedBtn.disabled = false
      })
      row.append(
        radio,
        el('span', 'sh-account-path', `m/44'/60'/0'/0/${acct.index}`),
        el('span', 'evm-address', toChecksumAddress(acct.address))
      )
      accountList.append(row)
    }
    moreBtn.style.display = ''
    useSeedBtn.style.display = ''
  }
  deriveBtn.addEventListener('click', () => void derive())
  moreBtn.addEventListener('click', () => {
    shown += 5
    void derive()
  })
  useSeedBtn.addEventListener('click', () => {
    const picked = accountList.querySelector('input[name=hd-account]:checked') as HTMLInputElement | null
    if (!picked) return
    // Import from the phrase these addresses CAME FROM, never from whatever
    // the box says now: the human approved the address they were shown, and
    // that address is only reproducible from the phrase that produced it.
    if (derivedFrom === null) return
    void commit({ mnemonic: derivedFrom, index: Number(picked.value) })
  })
  body.append(deriveBtn, seedError, accountList, moreBtn, useSeedBtn)

  // ── Replace: from a private key ──
  const pkInput = el('input', 'evm-input evm-input--mono') as HTMLInputElement
  pkInput.setAttribute('data-testid', 'account-privkey-input')
  pkInput.placeholder = '0x… (64 hex characters)'
  const pkError = el('div', 'evm-field-error')
  pkError.setAttribute('data-testid', 'account-privkey-error')
  const pkBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Import key')
  pkBtn.setAttribute('data-testid', 'account-import-privkey')
  pkBtn.addEventListener('click', () => {
    pkError.textContent = ''
    void commit({ privkeyHex: pkInput.value })
  })
  const pkBlock = el('div', 'sh-account-col')
  pkBlock.append(field('Private key', pkInput, 'Imports this exact account.'), pkError, pkBtn)

  // ── Replace: generate a new identity ──
  const genBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Generate new identity') as HTMLButtonElement
  genBtn.setAttribute('data-testid', 'account-generate')
  const genSlot = el('div')
  genBtn.addEventListener('click', async () => {
    const { mnemonic, address } = await shell.accountGenerate()
    const words = el('div', 'sh-draft', mnemonic)
    words.setAttribute('data-testid', 'account-new-mnemonic')
    const hint = el(
      'p',
      'sh-warn',
      'These 12 words are shown ONCE and stored nowhere. Write them down now — they are the only way to recover this identity.'
    )
    const addrLine = el('p', 'sh-hint', `account 0 → ${toChecksumAddress(address)}`)
    const ack = el('input') as HTMLInputElement
    ack.type = 'checkbox'
    ack.setAttribute('data-testid', 'account-wrote-down')
    const ackRow = el('label', 'sh-account-row')
    ackRow.append(ack, el('span', undefined, 'I wrote the 12 words down'))
    const useBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Use this identity') as HTMLButtonElement
    useBtn.setAttribute('data-testid', 'account-use-generated')
    useBtn.disabled = true
    ack.addEventListener('change', () => {
      useBtn.disabled = !ack.checked
    })
    useBtn.addEventListener('click', () => void commit({ mnemonic, index: 0 }))
    genSlot.replaceChildren(words, hint, addrLine, ackRow, useBtn)
    genBtn.disabled = true
  })
  const genBlock = el('div', 'sh-account-col')
  genBlock.append(el('div', 'evm-field-label', 'No key yet?'), genBtn, genSlot)
  const cols = el('div', 'sh-account-cols')
  cols.append(pkBlock, genBlock)
  body.append(cols)

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'account-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** The New chooser: built-in starters, then programs already in the library,
 *  then the raw "bring your own HTML" path. Picking a type starts a local
 *  DRAFT — nothing is signed until the human publishes it. */
async function openNewMenu(): Promise<void> {
  // Fetch before the overlay exists: an await afterwards would hide the cage
  // views for longer than the modal is actually up.
  const types = await shell.knownTypes()
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-new-modal')
  modal.setAttribute('data-testid', 'new-menu')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'New'))
  const body = el('div', 'evm-modal-body')
  body.append(el('p', 'sh-hint', 'Pick what to make. It starts as a draft on this machine — nothing is signed or shared until you publish it.'))

  for (const entry of types) {
    const btn = el('button', 'evm-btn evm-btn--ghost sh-new-type')
    btn.setAttribute('data-testid', `new-type-${entry.testKey}`)
    btn.setAttribute('data-type', entry.type)
    btn.setAttribute('data-source', entry.source)
    btn.append(
      el('span', 'evm-badge evm-badge--neutral', entry.type),
      (() => {
        const text = el('span', 'sh-new-type-text')
        text.append(el('span', 'sh-new-type-label', entry.label), el('span', 'sh-hint', entry.description))
        return text
      })()
    )
    btn.addEventListener('click', async () => {
      overlay.remove()
      const r = await shell.newDraft(entry.key)
      if (!r.id) {
        showText(`Could not start a draft: ${String(r.error ?? 'unknown type')}`, 'danger')
        return
      }
      await openThing(r.id)
    })
    body.append(btn)
  }

  body.append(el('div', 'sh-new-sep'))
  const fromHtml = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'New from HTML…')
  fromHtml.setAttribute('data-testid', 'new-from-html')
  fromHtml.addEventListener('click', () => {
    overlay.remove()
    openComposeModal()
  })
  body.append(fromHtml)

  const footer = el('div', 'evm-modal-footer')
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Cancel')
  cancel.setAttribute('data-testid', 'new-menu-cancel')
  cancel.addEventListener('click', () => overlay.remove())
  footer.append(cancel)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

function openComposeModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Create a letter'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'Pick a self-contained HTML page. It is signed with your identity into a shareable .thing file — hand it to anyone over any channel.'
    )
  )

  // Program (required).
  const progInput = el('input') as HTMLInputElement
  progInput.type = 'file'
  progInput.accept = '.html,.htm,text/html'
  const progRow = el('label', 'sh-compose-row')
  progRow.append(el('span', 'sh-compose-label', 'Page (HTML)'), progInput)

  // Type (display hint).
  const typeInput = el('input', 'evm-input') as HTMLInputElement
  typeInput.value = 'page'
  typeInput.setAttribute('aria-label', 'type')
  const typeRow = el('label', 'sh-compose-row')
  typeRow.append(el('span', 'sh-compose-label', 'Type'), typeInput)

  // Attachments (optional, multiple).
  const attInput = el('input') as HTMLInputElement
  attInput.type = 'file'
  attInput.multiple = true
  const attRow = el('label', 'sh-compose-row')
  attRow.append(el('span', 'sh-compose-label', 'Attachments'), attInput)

  body.append(progRow, typeRow, attRow)

  const footer = el('div', 'evm-modal-footer')
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Cancel')
  const create = el('button', 'evm-btn evm-btn--primary', 'Sign & save…') as HTMLButtonElement
  footer.append(cancel, create)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))

  cancel.addEventListener('click', () => overlay.remove())
  create.addEventListener('click', async () => {
    const prog = progInput.files?.[0]
    if (!prog) {
      showText('Choose an HTML page first.', 'danger')
      return
    }
    create.disabled = true
    try {
      const attachments = await Promise.all(
        [...(attInput.files ?? [])].map(async (f) => ({ name: f.name, base64: await readAsBase64(f), mime: mimeOf(f.name) }))
      )
      const { outcome, path } = await shell.compose({
        programBase64: await readAsBase64(prog),
        type: typeInput.value,
        attachments
      })
      if (outcome.status === 'valid') {
        overlay.remove()
        showText(path ? `Created & saved to ${path}` : 'Created (save cancelled — it is in your feed)', 'success')
        await refreshFeed()
      } else {
        showToast(outcome)
        create.disabled = false
      }
    } catch (e) {
      showText(`Create failed: ${(e as Error).message}`, 'danger')
      create.disabled = false
    }
  })
}
newBtn.addEventListener('click', () => void openNewMenu())

// ── Safety notice (experimental alpha + real key custody) ────────────────────
function safetyModal(keyStorage: 'os' | 'software', onClose?: () => void): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', '⚠ Experimental alpha'))
  const body = el('div', 'evm-modal-body')
  const storageLine =
    keyStorage === 'software'
      ? 'Your identity key is stored in SOFTWARE on this device — anyone with access to this machine can read it. It is not protected by your OS keychain.'
      : 'Your identity key is stored via your OS keychain, but this is still pre-release software.'
  body.append(
    el('p', 'sh-hint', 'This is an early build for concept testing. Please do not rely on it.'),
    el('p', 'sh-warn', storageLine),
    el(
      'p',
      'sh-hint',
      'Do not use this identity for anything valuable, and do not put anything in a letter that you could not bear to leak — a signed letter is public and permanent once shared.'
    )
  )
  const footer = el('div', 'evm-modal-footer')
  const ok = el('button', 'evm-btn evm-btn--primary', 'I understand')
  ok.setAttribute('data-testid', 'safety-ack')
  ok.addEventListener('click', () => {
    try {
      localStorage.setItem('sh-safety-ack', '1')
    } catch {
      /* private mode — show again next time, harmless */
    }
    overlay.remove()
    onClose?.()
  })
  footer.append(ok)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

// ── Updates ──────────────────────────────────────────────────────────────────
// Each network step is a separate yes: checking at all (asked once, here),
// downloading a version the human was shown, and restarting into it.
const UPDATE_COST = 'Each check tells GitHub your IP address and which version of Souspli you run.'

/** Asked once, after the safety notice. Escape leaves the question open. */
function updateConsentModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Check for updates?'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el('p', 'sh-hint', 'Souspli can look for a new version once a day, so you hear about security fixes.'),
    el('p', 'sh-warn', UPDATE_COST),
    el('p', 'sh-hint', 'Nothing is downloaded without asking you. Help → Check for updates… works either way.')
  )
  const footer = el('div', 'evm-modal-footer')
  const no = el('button', 'evm-btn evm-btn--ghost', "Don't check")
  const yes = el('button', 'evm-btn evm-btn--primary', 'Check daily')
  no.setAttribute('data-testid', 'update-consent-off')
  yes.setAttribute('data-testid', 'update-consent-on')
  const answer = (p: 'on' | 'off'): void => {
    overlay.remove()
    void shell.updateSetPref(p)
  }
  no.addEventListener('click', () => answer('off'))
  yes.addEventListener('click', () => answer('on'))
  footer.append(no, yes)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

let updatesPaint: ((s: UpdateStatus) => void) | null = null

/** Help → Check for updates…, and where a background check reports a find. */
function openUpdatesModal(initial: UpdateStatus, checkNow: boolean): void {
  if (updatesPaint) {
    updatesPaint(initial)
    return
  }
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'updates-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Updates'))
  const body = el('div', 'evm-modal-body')
  const statusSlot = el('div')
  const auto = el('input') as HTMLInputElement
  auto.type = 'checkbox'
  auto.setAttribute('data-testid', 'update-auto')
  auto.addEventListener('change', () => void shell.updateSetPref(auto.checked ? 'on' : 'off').then(paint))
  const autoRow = el('label', 'sh-account-row')
  autoRow.append(auto, el('span', undefined, 'Check once a day'))
  body.append(statusSlot, autoRow, el('p', 'sh-hint', UPDATE_COST))
  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.addEventListener('click', () => overlay.remove())
  const action = el('button', 'evm-btn evm-btn--primary') as HTMLButtonElement
  action.setAttribute('data-testid', 'update-action')
  footer.append(close, action)

  function paint(st: UpdateStatus): void {
    auto.checked = st.pref === 'on'
    const s = st.state
    const line = (text: string, cls = 'sh-hint'): HTMLElement => {
      const p = el('p', cls, text)
      p.setAttribute('data-testid', 'update-status')
      p.setAttribute('data-phase', s.phase)
      return p
    }
    action.style.display = 'none'
    action.disabled = false
    action.onclick = null
    const show = (label: string, fn: () => void): void => {
      action.textContent = label
      action.style.display = ''
      action.onclick = () => {
        action.disabled = true
        fn()
      }
    }
    if (s.phase === 'idle' || s.phase === 'checking') {
      statusSlot.replaceChildren(line(s.phase === 'checking' ? 'Checking…' : `You have version ${st.current}.`))
      if (s.phase === 'idle') show('Check now', () => void shell.updateCheck().then(paint))
    } else if (s.phase === 'current') {
      statusSlot.replaceChildren(line(`You have the latest version (${st.current}).`))
      show('Check again', () => void shell.updateCheck().then(paint))
    } else if (s.phase === 'inactive') {
      statusSlot.replaceChildren(line("This build can't update itself. New versions are on the releases page."))
    } else if (s.phase === 'available') {
      const notes = el('pre', 'sh-hint')
      notes.textContent = s.notes || '(no release notes)'
      notes.style.whiteSpace = 'pre-wrap'
      notes.style.maxHeight = '240px'
      notes.style.overflow = 'auto'
      statusSlot.replaceChildren(line(`Version ${s.version} is available. You have ${st.current}.`), notes)
      if (s.canInstall) show('Download', () => void shell.updateDownload().then(paint))
      else show('Open release page', () => void shell.updateOpenRelease().then(() => overlay.remove()))
    } else if (s.phase === 'downloading') {
      statusSlot.replaceChildren(line(`Downloading ${s.version}… ${s.percent}%`))
    } else if (s.phase === 'ready') {
      statusSlot.replaceChildren(line(`Version ${s.version} is ready. Souspli will close and reopen.`))
      show('Restart to update', () => void shell.updateInstall())
    } else {
      statusSlot.replaceChildren(line(`Update failed: ${s.message}`, 'sh-warn'))
      show('Try again', () => void shell.updateCheck().then(paint))
    }
  }
  modal.append(header, body, footer)
  overlay.append(modal)
  const origRemove = overlay.remove.bind(overlay)
  overlay.remove = () => {
    updatesPaint = null
    origRemove()
  }
  document.body.append(trackOverlay(overlay))
  updatesPaint = paint
  paint(initial)
  if (checkNow) void shell.updateCheck().then(paint)
}

shell.onOpenUpdates(() => void shell.updateStatus().then((s) => openUpdatesModal(s, true)))
let announcedVersion: string | null = null
shell.onUpdateState((s) => {
  if (updatesPaint) updatesPaint(s)
  // A background check found something: say so once per version, without
  // downloading. Dismissed, it waits in Help → Check for updates….
  else if (s.state.phase === 'available' && s.state.version !== announcedVersion) {
    announcedVersion = s.state.version
    openUpdatesModal(s, false)
  }
})

function renderSafety(keyStorage: 'os' | 'software'): void {
  keyWarn.style.display = ''
  keyWarn.textContent = keyStorage === 'software' ? '⚠ software keys · alpha' : '⚠ alpha'
  keyWarn.className = `evm-badge evm-badge--${keyStorage === 'software' ? 'danger' : 'warning'} sh-keywarn`
  keyWarn.title = 'Experimental build. Click for details.'
  keyWarn.addEventListener('click', () => safetyModal(keyStorage))
  let acked = false
  try {
    acked = localStorage.getItem('sh-safety-ack') === '1'
  } catch {
    /* ignore */
  }
  // First-run questions come one at a time: the safety notice, then updates.
  const askUpdates = (): void =>
    void shell.updateStatus().then((s) => {
      if (s.prompt) updateConsentModal()
    })
  if (!acked) safetyModal(keyStorage, askUpdates)
  else askUpdates()
}

// ── Feed ─────────────────────────────────────────────────────────────────────
let selected: string | null = null

/** This shell's own author key (bare lowercase hex), once identity resolves.
 *  Used ONLY to label rows as yours — the comparison is on the admitted
 *  envelope's author key, so it says what the signature says. */
let myAuthorKey: string | null = null
let feedScope: 'all' | 'mine' = 'all'

/** Is this row signed by the identity currently loaded in this shell? */
/** How an author is written, everywhere one appears.
 *
 *  Three kinds of name meet here and they are NOT interchangeable:
 *
 *    verified  proven to belong to this key (ENS, reverse+forward confirmed).
 *              Carries the ✓ treatment; the shell vouches for it.
 *    petname   what YOU call this key. Local, and the one name nobody else can
 *              influence -- an author may claim anything and may even prove an
 *              ENS name, but they cannot make you call them something.
 *    neither   the key itself, shortened.
 *
 *  A petname must never be mistaken for verification, so it is rendered plainly
 *  and the address stays reachable in the title. */
function authorLabel(row: { authorScheme: string; authorKey: string; petname?: string | null }): {
  text: string
  title: string
  named: boolean
} {
  const addr = row.authorScheme === 'eth-eip191' ? shortAddress(row.authorKey) : short(row.authorKey)
  const full = `${row.authorScheme}:${row.authorKey}`
  if (row.petname) {
    return { text: row.petname, title: `${row.petname} — your name for ${full}`, named: true }
  }
  return { text: addr, title: full, named: false }
}

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

export interface DocumentFacts {
  cosignable: boolean
  signedCount: number
  namedCount: number
  namedSignedCount: number
  unnamedSignedCount: number
  signedByMe: boolean
  iAmNamed: boolean
  signatures: {
    envelopeHash: string
    authorScheme: string
    authorKey: string
    created: number
    receivedAt: number
    petname: string | null
    named: boolean
  }[]
  namedSigners: { scheme: string; key: string; role: string; name: string; signed: boolean }[]
}

/** "2 of 4 signed" -- and never a percentage, a bar, or a tick.
 *
 *  A half-signed contract is not half-valid: it is a document two people have
 *  not signed. The wording says who is missing, not how complete it is. */
function signedLabel(f: {
  namedSignedCount?: number
  namedCount?: number
  signedCount?: number
  unnamedSignedCount?: number
}): string {
  const named = f.namedCount ?? 0
  const signedNamed = f.namedSignedCount ?? 0
  const extra = f.unnamedSignedCount ?? 0
  const base = `${signedNamed} of ${named} signed`
  if (extra === 0) return base
  // A signature the document never asked for is still a real signature.
  return `${base}, plus ${extra} not named`
}

/** Where a key sits relative to you, in words rather than a number.
 *
 *  Deliberately not a score: distance is a fact about YOUR vouches, and it
 *  stops meaning anything past a hop or two, so it is never summed, averaged,
 *  or compared between keys. */
function tribeSeat(hops: number): string {
  return hops === 1 ? 'you vouched' : hops === 2 ? 'vouched by someone you vouched for' : `${hops} hops`
}

function isMine(row: { authorScheme: string; authorKey: string }): boolean {
  return myAuthorKey !== null && row.authorScheme === 'eth-eip191' && row.authorKey === myAuthorKey
}

/** The line a letter calls itself by, for any list of letters.
 *
 *  This is program-supplied text in trusted chrome, so it is held to terms: it
 *  arrives already sanitized (library/title.ts -- one line, no controls or bidi
 *  tricks, and no check marks, which are the chrome's word for VERIFIED); it is
 *  set as TEXT, never markup; it sits BELOW the author line and in secondary
 *  ink, so the signer stays the fact a row leads with; and its tooltip says
 *  whose wording it is. Returns null when a letter offers no title -- a row
 *  then reads exactly as it did before there were titles. */
function titleLine(title: unknown): HTMLElement | null {
  if (typeof title !== 'string' || title.length === 0) return null
  const line = el('div', 'sh-feed-called', title)
  line.setAttribute('data-testid', 'feed-title')
  line.title = 'What this letter calls itself — the author’s wording, not something Souspli checked.'
  return line
}

/** One feed row. Three grid cells — type | author | flags — so the author
 *  column lines up across rows regardless of how long the type name is. */
function thingItem(row: ThingRow): HTMLElement {
  const item = el('button', 'sh-feed-item')
  if (row.envelopeHash === selected) item.classList.add('sh-feed-item--active')
  const line1 = el('div', 'sh-feed-line')
  // Your own things read "by you" rather than your address — the whole point
  // of the column is telling authors apart at a glance.
  const mine = isMine(row)
  const lab = authorLabel(row)
  // A named key drops the monospace address styling: it is a name now, and
  // should read like one rather than like a hash.
  const author = mine
    ? el('span', 'sh-feed-author sh-feed-you', 'by you')
    : el('span', `sh-feed-author${lab.named ? ' sh-feed-named' : ' evm-address evm-address--muted'}`, lab.text)
  if (mine) author.setAttribute('data-testid', 'feed-you')
  if (!mine && lab.named) author.setAttribute('data-testid', 'feed-petname')
  author.setAttribute('title', mine ? `${row.authorScheme}:${row.authorKey}` : lab.title)
  const flags = el('span', 'sh-feed-flags')
  if (row.isFork) flags.append(el('span', 'evm-badge evm-badge--danger', 'FORK'))
  if (row.sealed) flags.append(el('span', 'evm-badge evm-badge--purple', 'sealed'))
  if (!row.read) flags.append(el('span', 'sh-unread', '●'))
  // Per-row delete — usable WITHOUT opening the thing (you may not want to
  // mount something before removing it). A span, not a button: the row itself
  // is a button and buttons must not nest.
  const del = el('span', 'sh-feed-del', '×')
  del.title = 'Delete from library'
  del.setAttribute('role', 'button')
  del.setAttribute('data-testid', 'feed-delete')
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    void deleteWithConfirm(row.envelopeHash, row.type)
  })
  flags.append(del)
  line1.append(el('span', 'evm-badge evm-badge--neutral', row.type), author, flags)
  const meta = el('div', 'sh-feed-meta', fmtTime(row.receivedAt))
  // What folded into this row. Shown only when there IS any, so an ordinary
  // thing reads exactly as it did before.
  const act = row.activity
  if (act && (act.replies > 0 || act.up > 0 || act.down > 0)) {
    const bits: string[] = []
    if (act.replies > 0) bits.push(act.replies === 1 ? '1 reply' : `${act.replies} replies`)
    const votes = act.up + act.down
    if (votes > 0) bits.push(votes === 1 ? '1 vote' : `${votes} votes`)
    const badge = el('span', 'sh-feed-activity', bits.join(' · '))
    badge.setAttribute('data-testid', 'feed-activity')
    badge.setAttribute('data-replies', String(act.replies))
    meta.append(el('span', undefined, ' · '), badge)
  }
  const called = titleLine(row.title)
  item.append(line1, ...(called ? [called] : []), meta)
  item.addEventListener('click', () => void openThing(row.envelopeHash))
  return item
}

/** One offered thing: a stub for something a relay says exists.
 *
 *  The mirror of a draft row, and the wording carries the whole difference
 *  between this and a real feed row. Nothing here is verified: the type is the
 *  poster's label, and there is NO author, because the only key in the event is
 *  the one that posted it and posting is not authoring.
 *
 *  Fetch is the press. It is the entire security boundary of this feature: the
 *  locator is shown beside it because pressing it is what contacts that
 *  address. */
function offerItem(o: OfferRow): HTMLElement {
  const wrap = el('div', 'sh-offer')
  wrap.setAttribute('data-testid', 'offer-item')
  wrap.setAttribute('data-envelope-hash', o.envelopeHash)
  wrap.setAttribute('data-state', o.state)

  const line = el('div', 'sh-feed-line')
  line.append(el('span', 'evm-badge evm-badge--neutral', o.type || 'letter'))
  const claim = el('span', 'sh-offer-claim', 'offered — not fetched')
  line.append(claim)
  const fetchBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm sh-offer-fetch', 'Fetch') as HTMLButtonElement
  fetchBtn.setAttribute('data-testid', 'offer-fetch')
  fetchBtn.disabled = o.state === 'fetching'
  if (o.state === 'fetching') fetchBtn.textContent = 'Fetching…'
  fetchBtn.addEventListener('click', async () => {
    fetchBtn.disabled = true
    fetchBtn.textContent = 'Fetching…'
    const r = await shell.fetchOffer(o.envelopeHash)
    if (r.status === 'started' && typeof r.transferId === 'string') {
      // A magnet may run for hours; show it where progress lives rather than
      // leaving a button to imply it is done.
      openTransfersModal(r.transferId)
    } else if (r.error || r.status === 'invalid') {
      showText(String(r.error ?? r.reason ?? 'could not fetch it'), 'danger')
    }
    await refreshFeed()
  })
  line.append(fetchBtn)
  wrap.append(line)

  // What pressing Fetch will actually contact, and who said so. Both before
  // the press, because after it they are no longer a choice.
  const from = el('div', 'sh-offer-meta')
  from.setAttribute('data-testid', 'offer-locator')
  from.textContent = `${o.locator.length > 64 ? `${o.locator.slice(0, 61)}…` : o.locator}`
  from.title = `${o.locator}\n\nOffered by ${o.poster || 'an unknown key'}${
    o.relayUrl ? ` on ${o.relayUrl}` : ''
  }. That is who told you about it — not who wrote it, which nobody here knows until it is fetched.`
  wrap.append(from)

  if (o.state === 'failed' && o.reason) {
    const why = el('div', 'sh-offer-meta sh-offer-failed', o.reason)
    why.setAttribute('data-testid', 'offer-failed')
    wrap.append(why)
  }
  return wrap
}

/** A local, unsigned draft. Same grid so the columns still line up. */
function draftItem(d: DraftRow): HTMLElement {
  const item = el('button', 'sh-feed-item sh-feed-item--draft')
  item.setAttribute('data-testid', 'draft-item')
  item.setAttribute('data-draft-id', d.id)
  if (d.id === selected) item.classList.add('sh-feed-item--active')
  const line1 = el('div', 'sh-feed-line')
  const label = el('span', 'sh-feed-author sh-feed-draft-label', 'only on this machine')
  const flags = el('span', 'sh-feed-flags')
  const badge = el('span', 'evm-badge evm-badge--warning', 'DRAFT')
  badge.setAttribute('data-testid', 'draft-badge')
  flags.append(badge)
  const del = el('span', 'sh-feed-del', '×')
  del.title = 'Discard draft'
  del.setAttribute('role', 'button')
  // NOT `feed-delete`: specs query the first match of that id, and drafts
  // render above the feed.
  del.setAttribute('data-testid', 'draft-delete')
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    void deleteWithConfirm(d.id, d.type, true)
  })
  flags.append(del)
  line1.append(el('span', 'evm-badge evm-badge--neutral', d.type), label, flags)
  item.append(line1, el('div', 'sh-feed-meta', `edited ${fmtTime(d.updated)}`))
  item.addEventListener('click', () => void openThing(d.id))
  return item
}

/** All | Mine. "Mine" filters on the author key in the library, so it means
 *  "signed by the identity this shell currently holds" — swap identities and
 *  the set changes, truthfully. */
function feedFilter(): HTMLElement {
  const wrap = el('span', 'sh-feed-filter')
  const mk = (scope: 'all' | 'mine', label: string): HTMLElement => {
    const b = el('button', 'evm-btn evm-btn--ghost evm-btn--sm sh-feed-filter-btn', label)
    b.setAttribute('data-testid', `feed-filter-${scope}`)
    if (feedScope === scope) b.classList.add('sh-feed-filter-btn--active')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      if (feedScope === scope) return
      feedScope = scope
      void refreshFeed()
    })
    return b
  }
  wrap.append(mk('all', 'All'), mk('mine', 'Mine'))
  return wrap
}

async function refreshFeed(): Promise<void> {
  // "Mine" is a library-side author filter; with no identity yet (boot race)
  // fall back to everything rather than showing a misleading empty list.
  // Rolled up: a reply belongs under the thing it answers and a vote is
  // activity rather than content. Without this a busy forum thread would push
  // a memo addressed to you off the bottom of the list.
  const query = feedScope === 'mine' && myAuthorKey ? { author: myAuthorKey, rollUp: true } : { rollUp: true }
  const [drafts, rows, offers] = await Promise.all([shell.drafts(), shell.feed(query), shell.offers()])
  feedPane.replaceChildren()
  // Drafts are yours by definition and are never published, so the Mine/All
  // scope does not apply to them — they always show.
  if (drafts.length > 0) {
    const title = el('div', 'sh-feed-title', `Drafts · ${drafts.length}`)
    title.setAttribute('data-testid', 'feed-drafts-title')
    feedPane.append(title)
    for (const d of drafts) feedPane.append(draftItem(d))
  }
  // Offered: things a relay said exist that are not here. A draft in reverse,
  // and shown the same way — its own section, never mixed into the feed, so
  // nothing unfetched can be mistaken for something you hold. Like drafts, the
  // Mine/All scope does not apply: nobody knows who wrote these yet.
  if (offers.length > 0) {
    const title = el('div', 'sh-feed-title', `Offered · ${offers.length}`)
    title.setAttribute('data-testid', 'feed-offers-title')
    title.title = 'Letters a relay says exist. Nothing has been downloaded — pressing Fetch is what contacts anybody.'
    feedPane.append(title)
    for (const o of offers) feedPane.append(offerItem(o))
  }
  const head = el('div', 'sh-feed-title sh-feed-head')
  head.append(el('span', undefined, `${feedScope === 'mine' ? 'By you' : 'Feed'} · ${rows.length}`), feedFilter())
  feedPane.append(head)
  if (rows.length === 0) {
    const empty =
      feedScope === 'mine'
        ? 'Nothing published by you yet.'
        : drafts.length > 0
          ? 'Nothing published yet.'
          : 'Nothing yet. Press New to make something.'
    feedPane.append(el('div', 'evm-empty', empty))
    return
  }
  for (const row of rows) feedPane.append(thingItem(row))
}

// ── View | Edit mode toggle ──────────────────────────────────────────────────
// The SHELL owns mode switching — this control lives in chrome pixels the
// thing cannot reach; the program just renders whichever mode it is told.
// Main is the source of truth: it pushes shell:mode-changed on open and on
// every switch, so this local state is only a render cache.
let currentMode: 'view' | 'edit' = 'view'
let previewActive = false
let publishable = false
let modeButtons: { view: HTMLElement; edit: HTMLElement } | null = null
let trustBadge: HTMLElement | null = null
let previewBadge: HTMLElement | null = null
let publishBtn: HTMLButtonElement | null = null

function styleModeButtons(): void {
  modeButtons?.view.classList.toggle('sh-mode-btn--active', currentMode === 'view')
  modeButtons?.edit.classList.toggle('sh-mode-btn--active', currentMode === 'edit')
  // The trust badge must NEVER sit above unsigned draft content: when view
  // mode is showing the draft preview, swap "✓ signed" for the preview badge.
  // Swapped via VISIBILITY inside a fixed-size status slot (not display), so
  // the wider badge never reflows the controls to its right — buttons must
  // stay put while the user is working.
  const showingPreview = previewActive && currentMode === 'view'
  if (trustBadge) trustBadge.style.visibility = showingPreview ? 'hidden' : 'visible'
  if (previewBadge) previewBadge.style.visibility = showingPreview ? 'visible' : 'hidden'
  // Publish enables once the program has streamed a draft — which is also how
  // the chrome detects that this program supports the edit contract at all.
  if (publishBtn) {
    publishBtn.disabled = !publishable
    publishBtn.title = publishable
      ? 'Sign the previewed draft as a new instance'
      : 'Nothing to publish yet — edit it first (the program streams its state as you edit)'
  }
}

function renderModeToggle(): HTMLElement {
  const wrap = el('span', 'sh-mode')
  const mk = (m: 'view' | 'edit', label: string, testid: string): HTMLElement => {
    const b = el('button', 'evm-btn evm-btn--ghost evm-btn--sm sh-mode-btn', label)
    b.setAttribute('data-testid', testid)
    b.addEventListener('click', () => void shell.setMode(m)) // main pushes mode-changed back
    return b
  }
  const view = mk('view', 'View', 'mode-view')
  const edit = mk('edit', 'Edit', 'mode-edit')
  modeButtons = { view, edit }
  wrap.append(view, edit)
  styleModeButtons()
  return wrap
}

/** Every way a thing can leave this machine, in one place.
 *
 *  Copy carries the whole bundle as text, which is what the Ingest box's paste
 *  path takes — no network, so it is the way to move something between two
 *  machines today. Save writes the same bytes to a .thing file. Both hand over
 *  the ORIGINAL admitted bundle, so the thing keeps its author, its signature
 *  and its hash wherever it lands. */
function openShareModal(envelopeHash: string, type: string): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-share')
  modal.setAttribute('data-testid', 'share-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', `Share this ${type}`))
  const body = el('div', 'evm-modal-body')
  body.append(
    el('p', 'sh-hint', 'Whatever leaves here is the bundle exactly as it was signed — same author, same content hash. Nothing is re-signed on the way out.')
  )

  const copyRow = el('div', 'sh-share-row')
  const copyBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Copy bundle')
  copyBtn.setAttribute('data-testid', 'share-copy')
  const copyNote = el('div', 'sh-hint sh-share-note')
  copyNote.setAttribute('data-testid', 'share-copy-note')
  copyNote.textContent = 'As text, for pasting into the Ingest box of another Souspli.'
  copyBtn.addEventListener('click', async () => {
    const r = await shell.exportBase64(envelopeHash)
    if (r.error || !r.base64) {
      copyNote.textContent = `Could not copy: ${String(r.error ?? 'unknown')}`
      return
    }
    try {
      await navigator.clipboard.writeText(r.base64)
      copyNote.textContent = `Copied ${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB — paste it into Ingest on the other machine.`
    } catch {
      // Clipboard can be refused. Say so rather than claiming success.
      copyNote.textContent = 'The clipboard refused it — use Save as a file instead.'
    }
  })
  copyRow.append(copyBtn, copyNote)

  const saveRow = el('div', 'sh-share-row')
  const saveBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Save as file…')
  saveBtn.setAttribute('data-testid', 'share-save')
  const saveNote = el('div', 'sh-hint sh-share-note')
  saveNote.setAttribute('data-testid', 'share-save-note')
  saveNote.textContent = 'A .thing file to copy across however you like.'
  saveBtn.addEventListener('click', async () => {
    const r = await shell.exportThing(envelopeHash)
    if (r.error) saveNote.textContent = `Save failed: ${r.error}`
    else if (r.path) saveNote.textContent = `Saved to ${r.path}`
    // Cancelled: the human closed the dialog, which needs no announcement.
  })
  saveRow.append(saveBtn, saveNote)

  // ── Seed over BitTorrent ────────────────────────────────────────────────
  // The only row here that exposes anything: the others hand bytes to the
  // human, this one announces to the network. So it says what that means
  // BEFORE the control, in the same register as the software-keys warning,
  // and it is off until asked.
  const seedRow = el('div', 'sh-share-row sh-share-row--seed')
  const seedBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Seed over BitTorrent') as HTMLButtonElement
  seedBtn.setAttribute('data-testid', 'share-seed')
  const seedNote = el('div', 'sh-hint sh-share-note')
  seedNote.setAttribute('data-testid', 'share-seed-note')
  const magnetSlot = el('div', 'sh-share-magnet')
  magnetSlot.setAttribute('data-testid', 'share-magnet-slot')

  const warn = el('p', 'sh-share-warn')
  warn.textContent =
    'Seeding announces this to the BitTorrent DHT: anyone with the link learns the address of whoever is serving it. A sealed letter stays encrypted, but that you hold it does not.'

  const paintSeed = (magnet: string | null): void => {
    magnetSlot.replaceChildren()
    if (magnet) {
      seedBtn.textContent = 'Stop seeding'
      seedNote.textContent = 'Being served to peers. The link works while Souspli is running.'
      magnetSlot.append(copyField('magnet link', magnet, 'share-magnet'))
    } else {
      seedBtn.textContent = 'Seed over BitTorrent'
      seedNote.textContent = 'Off. Nothing about this letter is announced.'
    }
  }

  let seeding: string | null = null
  seedBtn.addEventListener('click', async () => {
    seedBtn.disabled = true
    try {
      if (seeding) {
        await shell.seedStop(envelopeHash)
        seeding = null
        paintSeed(null)
      } else {
        seedNote.textContent = 'Starting…'
        const r = await shell.seedStart(envelopeHash)
        if (r.error || !r.magnet) {
          seedNote.textContent = `Could not seed: ${String(r.error ?? 'unknown')}`
          return
        }
        seeding = r.magnet
        paintSeed(r.magnet)
      }
    } finally {
      seedBtn.disabled = false
    }
  })

  seedNote.textContent = 'Checking…'
  // Reflect what is ALREADY being seeded, so reopening this does not offer to
  // start something that is already running. Deliberately NOT awaited before
  // the modal is shown: a dialog that waits on anything before appearing feels
  // broken, and this only decides which label the button carries.
  void shell
    .seedStatus()
    .then((current) => {
      seeding = current.find((x) => x.envelopeHash === envelopeHash)?.magnet ?? null
      paintSeed(seeding)
    })
    .catch(() => paintSeed(null))

  seedRow.append(seedBtn, seedNote)

  // ── Post to a relay ──────────────────────────────────────────────────────
  // The other row here that exposes something, and the only one that reaches
  // people who never asked. Same rule as seeding: say what it means before the
  // control, and do nothing until asked.
  const relayRow = el('div', 'sh-share-row sh-share-row--relay')
  const relayBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Post to relays') as HTMLButtonElement
  relayBtn.setAttribute('data-testid', 'share-relay-post')
  const relayNote = el('div', 'sh-hint sh-share-note')
  relayNote.setAttribute('data-testid', 'share-relay-note')
  relayNote.textContent = 'Checking…'
  const relayWarn = el('p', 'sh-share-warn')
  relayWarn.textContent =
    'Posting hands this letter to every relay you have added, for anyone reading them. The bundle is unchanged and still signed by you — but the relay learns your address, and its readers learn that your key published this.'
  relayBtn.addEventListener('click', async () => {
    relayBtn.disabled = true
    relayNote.textContent = 'Posting…'
    try {
      const r = await shell.postToRelays(envelopeHash)
      if (r.error) {
        relayNote.textContent = String(r.error)
        return
      }
      const n = Number(r.posted ?? 0)
      relayNote.textContent =
        n === 0
          ? 'No relay took it — none are connected right now.'
          : `Posted to ${n === 1 ? '1 relay' : `${n} relays`}${r.inline === false ? ', as a link to the bundle' : ''}.`
    } finally {
      relayBtn.disabled = false
    }
  })
  // How many relays there are decides whether this control can do anything, so
  // say which it is rather than letting the human find out by pressing it.
  void shell
    .relays()
    .then((state) => {
      const open = state.relays.filter((r) => r.state === 'open').length
      relayBtn.disabled = state.relays.length === 0
      relayNote.textContent =
        state.relays.length === 0
          ? 'No relays yet — add one under File → Relays.'
          : open === 0
            ? 'No relay is connected right now.'
            : `Ready: ${open === 1 ? '1 relay' : `${open} relays`} connected.`
    })
    .catch(() => {
      relayNote.textContent = ''
    })
  relayRow.append(relayBtn, relayNote)

  body.append(copyRow, saveRow, warn, seedRow, magnetSlot, relayWarn, relayRow)

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'share-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}


// ── Transfers ────────────────────────────────────────────────────────────────
// Downloads in flight and things being served, in one window, because they are
// one question: what is this shell doing on the network right now.

const bytesLabel = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

const etaLabel = (row: DownloadRow): string => {
  if (row.downloadSpeed <= 0 || row.bytes <= 0) return ''
  const left = row.bytes - row.downloaded
  if (left <= 0) return ''
  const secs = Math.round(left / row.downloadSpeed)
  if (secs < 60) return `${secs}s left`
  if (secs < 3600) return `${Math.round(secs / 60)}m left`
  return `${(secs / 3600).toFixed(1)}h left`
}

/** What is happening, and when it is going badly, WHY.
 *
 *  The distinction this whole window exists for: a swarm with nobody in it and
 *  a swarm whose only peer will not answer are different problems, and the app
 *  used to report both as "timed out". */
function downloadDiagnosis(row: DownloadRow): string {
  switch (row.state) {
    case 'starting':
      return 'Starting…'
    case 'finding-peers': {
      const silent = row.silentSources.length > 0 ? ` Nothing found yet via ${row.silentSources.join(', ')}.` : ''
      return `Looking for peers.${silent}`
    }
    case 'peers-unreachable':
      return (
        `Found ${row.peersDiscovered} ${row.peersDiscovered === 1 ? 'peer' : 'peers'}, but ` +
        `${row.peersDiscovered === 1 ? 'it has not' : 'none have'} accepted a connection. ` +
        'They may be behind NAT without port forwarding, or no longer running.'
      )
    case 'stalled':
      return `Connected to ${row.peersConnected} ${row.peersConnected === 1 ? 'peer' : 'peers'}, but nothing is arriving.`
    case 'downloading':
      return `${bytesLabel(row.downloadSpeed)}/s from ${row.peersConnected} of ${row.peersDiscovered} known ${row.peersDiscovered === 1 ? 'peer' : 'peers'}.`
    case 'verifying':
      return 'Downloaded. Reading it back…'
    case 'admitting':
      return 'Checking the signature and hashes…'
    case 'failed':
      return row.error ?? 'Failed.'
    default:
      return row.state
  }
}

function downloadRow(row: DownloadRow, expanded: boolean): HTMLElement {
  const wrap = el('div', expanded ? 'sh-transfer sh-transfer--open' : 'sh-transfer')
  wrap.setAttribute('data-testid', 'download-row')
  wrap.setAttribute('data-id', row.id)
  wrap.setAttribute('data-state', row.state)

  const head = el('div', 'sh-transfer-head')
  head.append(
    el('span', 'sh-transfer-name', row.name || row.infoHash.slice(0, 12)),
    el('span', 'evm-badge evm-badge--neutral sh-transfer-state', row.state)
  )
  const cancel = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Cancel')
  cancel.setAttribute('data-testid', 'download-cancel')
  cancel.addEventListener('click', () => void shell.cancelTransfer(row.id))
  head.append(el('span', 'sh-spacer'), cancel)
  wrap.append(head)

  // A bar only where there is something to measure: before metadata arrives the
  // size is unknown, and a bar at 0% would imply progress that is not happening.
  if (row.bytes > 0) {
    const bar = el('div', 'sh-progress')
    const fill = el('div', 'sh-progress-fill')
    fill.style.width = `${Math.round(row.progress * 100)}%`
    bar.setAttribute('data-percent', String(Math.round(row.progress * 100)))
    bar.append(fill)
    wrap.append(bar)
    wrap.append(
      el(
        'div',
        'sh-transfer-meta',
        `${bytesLabel(row.downloaded)} of ${bytesLabel(row.bytes)}` +
          (etaLabel(row) ? ` · ${etaLabel(row)}` : '')
      )
    )
  }

  const why = el('div', 'sh-transfer-why', downloadDiagnosis(row))
  why.setAttribute('data-testid', 'download-diagnosis')
  wrap.append(why)
  if (expanded) wrap.append(copyField('magnet link', row.magnet, `download-magnet-${row.id.slice(0, 8)}`))
  return wrap
}

/** Everything this shell is doing on the network: what it is fetching, and
 *  what it is serving. One window, because it is one question -- and because
 *  the honest answer to "what am I exposing right now" should not be in two
 *  places.
 *
 *  Live: main pushes while anything is in flight, so a long transfer is watched
 *  rather than sampled. Closing this does NOT cancel anything. */
function openTransfersModal(focusId?: string): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-transfers')
  modal.setAttribute('data-testid', 'transfers-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Transfers'))
  const body = el('div', 'evm-modal-body')

  const downloads = el('div')
  downloads.setAttribute('data-testid', 'downloads-list')
  const sharing = el('div', 'sh-sharing-list')
  sharing.setAttribute('data-testid', 'sharing-list')

  body.append(
    el('h3', 'sh-transfers-h', 'Downloads'),
    el(
      'p',
      'sh-hint',
      'Fetching runs in the background — closing this window does not stop it, and a transfer resumes if you quit and come back.'
    ),
    downloads,
    el('h3', 'sh-transfers-h', 'Sharing'),
    el(
      'p',
      'sh-hint',
      'Letters this machine is serving to peers. Each one announces to the BitTorrent DHT while it runs — anyone with the link learns the address serving it.'
    ),
    sharing
  )

  const paint = (state: TransferState): void => {
    downloads.replaceChildren()
    downloads.setAttribute('data-count', String(state.downloads.length))
    if (state.downloads.length === 0) {
      const none = el('p', 'sh-hint', 'Nothing is being fetched.')
      none.setAttribute('data-testid', 'downloads-empty')
      downloads.append(none)
    } else {
      // The one just started is shown open, with its magnet and full detail.
      for (const row of state.downloads) downloads.append(downloadRow(row, row.id === focusId))
    }

    sharing.replaceChildren()
    sharing.setAttribute('data-count', String(state.sharing.length))
    if (state.sharing.length === 0) {
      const none = el('p', 'sh-hint', 'Nothing is being shared.')
      none.setAttribute('data-testid', 'sharing-empty')
      sharing.append(none)
      return
    }
    for (const r of state.sharing) {
      const row = el('div', 'sh-sharing-row')
      row.setAttribute('data-envelope-hash', r.envelopeHash)
      const head = el('div', 'sh-sharing-head')
      head.append(el('span', 'evm-badge evm-badge--neutral', r.type ?? 'letter'))
      head.append(el('span', 'sh-hash evm-address evm-address--muted', short(r.envelopeHash, 8)))
      // Peers is the honest measure of whether sharing is doing anything.
      head.append(el('span', 'sh-hint', r.peers === 1 ? '1 peer' : `${r.peers} peers`))
      const stop = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Stop')
      stop.setAttribute('data-testid', 'sharing-stop')
      stop.addEventListener('click', () => void shell.seedStop(r.envelopeHash))
      head.append(stop)
      row.append(head, copyField('magnet link', r.magnet, `sharing-magnet-${r.envelopeHash.slice(0, 8)}`))
      sharing.append(row)
    }
  }

  transfersPainter = paint
  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'transfers-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(
    trackOverlay(overlay, () => {
      transfersPainter = null
    })
  )
  void shell.transfers().then(paint).catch(() => undefined)
}

/** The relays this shell talks to.
 *
 *  Every other transport in the shell is a PULL: you fetch a locator, or
 *  somebody hands you a file. A relay is the first one that brings you things
 *  nobody handed you — which is the point, and is also the exposure, so both
 *  are said here rather than in a footnote.
 *
 *  Two disclosures, because they are two different leaks:
 *   - posting tells the relay and its readers that this key published this
 *     thing, and tells the relay your address;
 *   - SUBSCRIBING tells the relay what you are interested in. None of the
 *     other transports leak that, and it is the one people do not expect. */
function openRelaysModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-relays')
  modal.setAttribute('data-testid', 'relays-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Relays'))
  const body = el('div', 'evm-modal-body')

  const list = el('div', 'sh-relay-list')
  list.setAttribute('data-testid', 'relay-list')

  const addRow = el('div', 'sh-relay-add')
  const input = el('input', 'evm-input sh-relay-input') as HTMLInputElement
  input.type = 'text'
  input.placeholder = 'wss://relay.example'
  input.setAttribute('data-testid', 'relay-input')
  const addBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Add relay') as HTMLButtonElement
  addBtn.setAttribute('data-testid', 'relay-add')
  const note = el('div', 'sh-hint sh-relay-note')
  note.setAttribute('data-testid', 'relay-note')
  addRow.append(input, addBtn)

  const paint = (state: {
    relays: { url: string; state: string; error: string | null; received: number; refused: number }[]
  }): void => {
    list.replaceChildren()
    list.setAttribute('data-count', String(state.relays.length))
    if (state.relays.length === 0) {
      const none = el('p', 'sh-hint', 'No relays. Nothing is being sent or received over one.')
      none.setAttribute('data-testid', 'relay-empty')
      list.append(none)
      appendCommunityOffer(list, 'The project runs one:')
      return
    }
    for (const r of state.relays) {
      const row = el('div', 'sh-relay-row')
      row.setAttribute('data-relay-url', r.url)
      const head = el('div', 'sh-relay-head')
      const badge = el(
        'span',
        `evm-badge evm-badge--${r.state === 'open' ? 'success' : r.state === 'connecting' ? 'neutral' : 'warning'}`,
        r.state
      )
      badge.setAttribute('data-testid', 'relay-state')
      head.append(badge, el('span', 'sh-relay-url', r.url))
      // Refused is worth showing beside received: a relay sending mostly
      // rubbish is a fact about that relay, and the only place it is visible.
      head.append(el('span', 'sh-hint', `${r.received} in · ${r.refused} refused`))
      const remove = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Remove')
      remove.setAttribute('data-testid', 'relay-remove')
      remove.addEventListener('click', async () => {
        await shell.removeRelay(r.url)
        void refresh()
      })
      head.append(remove)
      row.append(head)
      if (r.error) row.append(el('div', 'sh-hint', r.error))
      list.append(row)
    }
  }

  const refresh = async (): Promise<void> => {
    try {
      paint(await shell.relays())
    } catch {
      /* the window is closing */
    }
  }

  addBtn.addEventListener('click', async () => {
    const url = input.value.trim()
    if (!url) return
    addBtn.disabled = true
    try {
      const r = await shell.addRelay(url)
      if (r.error) {
        note.textContent = String(r.error)
        return
      }
      note.textContent = `Connected to ${url}. You will start receiving letters posted there.`
      input.value = ''
      await refresh()
    } finally {
      addBtn.disabled = false
    }
  })
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addBtn.click()
  })

  body.append(
    el(
      'p',
      'sh-hint',
      'A relay is how a letter reaches you when nobody handed you its bytes. It has no authority: everything a relay sends is checked exactly like a file from a stranger, and the signature — never the relay — says who wrote it.'
    ),
    list,
    el('h3', 'sh-transfers-h', 'Add a relay'),
    addRow,
    note,
    el(
      'p',
      'sh-share-warn',
      'Subscribing tells the relay what you are interested in, and your address. Posting tells it — and everyone reading it — that your key published that letter. Nothing is posted automatically: each one is a separate act, from Share.'
    )
  )

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'relays-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(
    trackOverlay(overlay, () => {
      if (relayPoll !== null) clearInterval(relayPoll)
      relayPoll = null
    })
  )
  void refresh()
  // A connection's state changes without anything telling the chrome, so this
  // one window polls. Cheap, and it stops when the window closes.
  relayPoll = setInterval(() => void refresh(), 1_000)
}

/** Set while the Relays window is open, so its poll can be stopped. */
let relayPoll: ReturnType<typeof setInterval> | null = null

/** Set while the Transfers window is open, so pushes land somewhere. */
let transfersPainter: ((s: TransferState) => void) | null = null

/** Name a key, or change/clear the name you gave it.
 *
 *  This is the one name in the system nobody else can influence. An author may
 *  call themselves anything, and may even prove an ENS name — but what you call
 *  them is yours, stays on this machine, and never enters a thing. */
function openPetnameModal(scheme: string, key: string, current: string | null): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-petname')
  modal.setAttribute('data-testid', 'petname-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', current ? 'Rename this key' : 'Name this key'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el('p', 'sh-hint', 'Your name for this key, kept on this machine. It never enters a letter and nobody else sees it — which is exactly why it is worth something: they cannot choose it.')
  )
  body.append(copyField('key', `${scheme}:${key}`, 'petname-key'))

  const nameField = el('div', 'e-field')
  nameField.append(el('label', 'Name'))
  const name = el('input', 'evm-input') as HTMLInputElement
  name.setAttribute('data-testid', 'petname-input')
  name.value = current ?? ''
  name.placeholder = 'e.g. Ada, or “the ops account”'
  nameField.append(name)

  const noteField = el('div', 'e-field')
  noteField.append(el('label', 'Note (optional)'))
  const note = el('input', 'evm-input') as HTMLInputElement
  note.setAttribute('data-testid', 'petname-note')
  note.placeholder = 'How you know them, or how you checked'
  noteField.append(note)
  body.append(nameField, noteField)

  const footer = el('div', 'evm-modal-footer')
  const save = el('button', 'evm-btn evm-btn--primary', 'Save')
  save.setAttribute('data-testid', 'petname-save')
  save.addEventListener('click', async () => {
    await shell.setPetname({ scheme, key, name: name.value, note: note.value })
    overlay.remove()
    if (selected) await openThing(selected) // repaint the header with the new name
  })
  const clear = el('button', 'evm-btn evm-btn--ghost', 'Clear name')
  clear.setAttribute('data-testid', 'petname-clear')
  clear.style.display = current ? '' : 'none'
  clear.addEventListener('click', async () => {
    await shell.setPetname({ scheme, key, name: '' })
    overlay.remove()
    if (selected) await openThing(selected)
  })
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Cancel')
  cancel.setAttribute('data-testid', 'petname-cancel')
  cancel.addEventListener('click', () => overlay.remove())
  footer.append(clear, cancel, save)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
  name.focus()
  name.select()
}

/** Everyone whose things you hold, and what you call them.
 *
 *  Deliberately just a list of keys and names: there is no reputation here, no
 *  score, and no notion of anyone being trustworthy. Naming someone records
 *  that YOU recognise them, and nothing more. */
function openPeopleModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-people')
  modal.setAttribute('data-testid', 'people-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'People'))
  const body = el('div', 'evm-modal-body')
  const list = el('div', 'sh-people-list')
  list.setAttribute('data-testid', 'people-list')
  body.append(
    el('p', 'sh-hint', 'Every key whose letters you hold. A name here is yours alone — it stays on this machine, and says you recognise the key, not that you trust it.'),
    el(
      'p',
      'sh-hint',
      'A vouch is the opposite: it is signed, it travels, and it tells whoever receives it that you know this key. Naming is private; vouching is public.'
    ),
    list
  )

  const paint = async (): Promise<void> => {
    const rows = await shell.people().catch(() => [])
    // Standing is per key, so it is fetched alongside rather than joined into
    // people() -- the People list is small and this keeps the query honest.
    const standing = await Promise.all(
      rows.map((r) => shell.vouchesFor(r.authorScheme, r.authorKey).catch(() => null))
    )
    list.replaceChildren()
    list.setAttribute('data-count', String(rows.length))
    if (rows.length === 0) {
      list.append(el('p', 'sh-hint', 'Nobody yet — admit something and its author appears here.'))
      return
    }
    for (const [i, r] of rows.entries()) {
      const row = el('div', 'sh-people-row')
      row.setAttribute('data-author-key', r.authorKey)
      const lab = authorLabel({ authorScheme: r.authorScheme, authorKey: r.authorKey, petname: r.name })
      const nameEl = el('span', lab.named ? 'sh-name sh-name--pet' : 'evm-address evm-address--muted', lab.text)
      nameEl.setAttribute('title', lab.title)
      const count = el('span', 'sh-hint', r.things === 1 ? '1 letter' : `${r.things} letters`)
      const mine = isMine(r)
      const btn = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', r.name ? 'Rename' : 'Name…') as HTMLButtonElement
      btn.setAttribute('data-testid', 'people-name')
      btn.disabled = mine
      btn.title = mine ? 'This is your own key' : ''
      btn.addEventListener('click', () => {
        openPetnameModal(r.authorScheme, r.authorKey, r.name)
      })
      const actions = el('span', 'sh-people-actions')
      if (mine) {
        actions.append(el('span', 'sh-feed-you', 'you'))
      } else {
        const vouch = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Vouch…') as HTMLButtonElement
        vouch.setAttribute('data-testid', 'people-vouch')
        vouch.title = 'Sign a statement that you know this key. This one travels.'
        vouch.addEventListener('click', () => {
          void shell.newVouch(r.authorScheme, r.authorKey).then((res) => {
            if (res.error) return showText(`Could not start a vouch: ${res.error}`, 'danger')
            overlay.remove() // the draft is now open; get out of its way
          })
        })
        actions.append(btn, vouch)
      }
      row.append(nameEl, count, actions)

      // Who already vouches for this key, and how much of that reaches YOU.
      const st = standing[i]
      if (st && st.count > 0) {
        const line = el('div', 'sh-people-note sh-tribe-line')
        line.setAttribute('data-testid', 'people-vouches')
        line.setAttribute('data-count', String(st.count))
        line.setAttribute('data-from-tribe', String(st.fromTribe))
        const n = st.count === 1 ? '1 vouch' : `${st.count} vouches`
        line.textContent =
          st.fromTribe === 0
            ? `${n}, none from your tribe — nobody you have vouched for reaches this key.`
            : `${n}, ${st.fromTribe} from your tribe.`
        row.append(line)
      }
      if (r.note) row.append(el('div', 'sh-people-note', r.note))
      list.append(row)
    }
  }

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'people-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
  void paint()
}

let repliesBadge: HTMLElement | null = null
let attestBadge: HTMLElement | null = null

const replyLabel = (n: number): string => (n === 0 ? 'no comments' : n === 1 ? '1 comment' : `${n} comments`)
const attestLabel = (n: number): string =>
  n === 0 ? 'no attestations' : n === 1 ? '1 attestation' : `${n} attestations`

/** Who has put their signature behind a statement about this thing.
 *
 *  The count is deliberately not a score. A signature proves WHO said
 *  something, never that it is so, and an attestation from a key you know
 *  nothing about tells you nothing — so this lists them with their authors and
 *  leaves the judgement where it belongs. */
async function openAttestationsModal(target: string): Promise<void> {
  const { rows, fromTribe } = await shell.attestations(target)
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'attestations-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Attestations'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'Letters in your library that put a signature behind a statement about this. Each signature proves who said it — not that it is true, and not that this letter’s author agreed.'
    )
  )
  // "5 attestations, 3 from your tribe" -- the second half is the part that
  // carries, because the first is free to manufacture.
  if (rows.length > 0) {
    const standing = el('p', 'sh-hint sh-tribe-line')
    standing.setAttribute('data-testid', 'attestations-tribe')
    standing.setAttribute('data-from-tribe', String(fromTribe))
    standing.textContent =
      fromTribe === 0
        ? `${attestLabel(rows.length)}, none from anyone you have vouched for.`
        : `${attestLabel(rows.length)}, ${fromTribe} from your tribe — signers you reached through your own vouches.`
    body.append(standing)
  }
  if (rows.length === 0) body.append(el('div', 'evm-empty', 'Nothing in your library attests to this.'))
  for (const row of rows) {
    const item = el('button', 'sh-feed-item')
    item.setAttribute('data-testid', 'attestation-item')
    item.setAttribute('data-envelope-hash', row.envelopeHash)
    const line = el('div', 'sh-feed-line')
    line.append(
      el('span', 'evm-badge evm-badge--neutral', row.type),
      el(
        'span',
        'sh-feed-author evm-address evm-address--muted',
        authorLabel(row).text
      ),
      el('span', 'sh-feed-flags')
    )
    if (row.hops !== null) {
      const seat = el('span', 'evm-badge evm-badge--neutral sh-tribe-badge', tribeSeat(row.hops))
      seat.setAttribute('data-testid', 'attestation-tribe')
      seat.setAttribute('data-hops', String(row.hops))
      line.append(seat)
    }
    item.append(line)
    item.addEventListener('click', () => {
      overlay.remove()
      void openThing(row.envelopeHash)
    })
    body.append(item)
  }
  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'attestations-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** Who has signed this document, and who it named but has not.
 *
 *  The two are kept apart on purpose. A signature is a fact about a key; being
 *  named is a claim by whoever drafted the document, and carries no weight of
 *  its own. Neither is a verdict on the document. */
async function openSignaturesModal(manifestHash: string): Promise<void> {
  const facts = await shell.document(manifestHash)
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'signatures-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Signatures'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'Each signature is a separate envelope over these exact document bytes — independently verified, and none of them privileged over the others. A signature proves the key signed this text; it does not prove they read it, and it is not a verdict on what the document says.'
    )
  )

  const signed = el('div')
  signed.setAttribute('data-testid', 'signatures-signed')
  signed.setAttribute('data-count', String(facts.signatures.length))
  for (const sig of facts.signatures) {
    const item = el('button', 'sh-feed-item')
    item.setAttribute('data-testid', 'signature-item')
    item.setAttribute('data-author-key', sig.authorKey)
    const line = el('div', 'sh-feed-line')
    const lab = authorLabel({ authorScheme: sig.authorScheme, authorKey: sig.authorKey, petname: sig.petname })
    line.append(
      el('span', 'evm-badge evm-badge--neutral', 'signed'),
      el('span', 'sh-feed-author evm-address evm-address--muted', lab.text),
      // Said plainly rather than hidden: the document did not name them, and
      // their signature is real all the same.
      el('span', 'sh-feed-flags', sig.named ? '' : 'not named by the document')
    )
    item.append(line)
    item.addEventListener('click', () => {
      overlay.remove()
      void openThing(sig.envelopeHash)
    })
    body.append(item)
  }
  body.append(signed)

  const missing = facts.namedSigners.filter((n) => !n.signed)
  if (missing.length > 0) {
    body.append(
      el(
        'p',
        'sh-hint',
        'Named by the document, but no signature from them is in your library. That may mean they have not signed, or only that their signature has not reached you.'
      )
    )
    for (const n of missing) {
      const row = el('div', 'sh-people-row')
      row.setAttribute('data-testid', 'signature-missing')
      row.setAttribute('data-author-key', n.key)
      const lab = authorLabel({ authorScheme: n.scheme, authorKey: n.key, petname: null })
      row.append(
        el('span', 'evm-badge evm-badge--neutral', n.role || 'party'),
        el('span', 'evm-address evm-address--muted', n.name || lab.text)
      )
      body.append(row)
    }
  }

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'signatures-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** Every version of a thing, oldest first.
 *
 *  A chain is one author continuing their own line. Someone else amending your
 *  thing shares the path but not the author, so it is their chain rooted at
 *  yours -- which is why this is always scoped to one author's key. */
async function openHistoryModal(authorKey: string, path: string, currentHash: string): Promise<void> {
  const rows = await shell.history(authorKey, path).catch(() => [])
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'history-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'History'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'Every version this author has published on this line, oldest first. Each one is its own signed letter — an earlier version is not deleted or corrected, it is simply superseded.'
    )
  )
  body.setAttribute('data-count', String(rows.length))
  for (const row of rows) {
    const item = el('button', 'sh-feed-item')
    item.setAttribute('data-testid', 'history-item')
    item.setAttribute('data-seq', String(row.seq ?? 0))
    const line = el('div', 'sh-feed-line')
    const isCurrent = row.envelopeHash === currentHash
    line.append(
      el('span', 'evm-badge evm-badge--neutral', `v${row.seq ?? 0}`),
      el('span', 'sh-feed-author evm-address evm-address--muted', short(row.envelopeHash, 8)),
      el('span', 'sh-feed-flags', isCurrent ? 'you are here' : '')
    )
    item.append(line)
    item.addEventListener('click', () => {
      overlay.remove()
      void openThing(row.envelopeHash)
    })
    body.append(item)
  }
  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'history-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

// ── Forums ───────────────────────────────────────────────────────────────────
// A forum is a GROUP: a roster with roles, kept by whoever founded it. There is
// no forum thing type and there never was one -- if a forum had needed new
// primitives, the primitives would have been wrong.
//
// Two sentences this UI exists to say, and must never stop saying:
//   · a ranking you cannot explain is worse than none, so the raw count and
//     the tribe count both appear, next to each other;
//   · a moderator hides nothing from you. A verdict folds a post behind a line
//     naming who and why, with the post one click away, because disagreeing
//     has to stay possible.

/** Every group you hold, as somewhere people post. */
async function openForumsModal(): Promise<void> {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-forums')
  modal.setAttribute('data-testid', 'forums-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Forums'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'A forum is a group you hold: its roster says who keeps it and who moderates. Anyone can post into one — being tagged into a group is the author’s claim, never the roster agreeing.'
    )
  )

  const list = el('div')
  list.setAttribute('data-testid', 'forums-list')
  body.append(list)

  const paint = (forums: Record<string, unknown>[]): void => {
    list.replaceChildren()
    list.setAttribute('data-count', String(forums.length))
    if (forums.length === 0) {
      const none = el('p', 'sh-hint', 'No groups in your library yet. Make one with New → Group.')
      none.setAttribute('data-testid', 'forums-empty')
      list.append(none)
      appendCommunityOffer(list, 'Or start with the project’s own:')
      return
    }
    for (const f of forums) {
      const item = el('button', 'sh-feed-item')
      item.setAttribute('data-testid', 'forum-item')
      item.setAttribute('data-root', String(f.root))
      const line = el('div', 'sh-feed-line')
      line.append(el('span', 'sh-forum-name', String(f.name || 'unnamed group')))
      const flags = el('span', 'sh-feed-flags')
      if (f.iAmModerator) flags.append(el('span', 'evm-badge evm-badge--info', 'you moderate'))
      else if (f.iAmMember) flags.append(el('span', 'evm-badge evm-badge--neutral', 'you are listed'))
      line.append(flags)
      item.append(
        line,
        el(
          'div',
          'sh-feed-meta',
          `${f.posts === 1 ? '1 post' : `${String(f.posts)} posts`} · ${
            f.members === 1 ? '1 on the roster' : `${String(f.members)} on the roster`
          }`
        )
      )
      item.addEventListener('click', () => {
        overlay.remove()
        void openForumModal(String(f.root))
      })
      list.append(item)
    }
  }

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'forums-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
  paint(await shell.forums().catch(() => []))
}

/** One forum: its posts ranked, its roster, and what you can do here. */
async function openForumModal(rootHash: string): Promise<void> {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-forum')
  modal.setAttribute('data-testid', 'forum-modal')
  modal.setAttribute('data-root', rootHash)
  const header = el('div', 'evm-modal-header')
  const title = el('span', 'evm-modal-title', 'Forum')
  header.append(title)
  const body = el('div', 'evm-modal-body')
  const footer = el('div', 'evm-modal-footer')

  const facts: Record<string, unknown> = await shell
    .forum(rootHash)
    .catch(() => ({ error: 'could not read that group' }))
  if (facts.error) {
    body.append(el('div', 'evm-empty', String(facts.error)))
  } else {
    title.textContent = String(facts.name || 'Forum')
    if (facts.purpose) body.append(el('p', 'sh-forum-purpose', String(facts.purpose)))

    const mods = facts.moderators as { key: string; name: string }[]
    body.append(
      el(
        'p',
        'sh-hint',
        mods.length === 0
          ? 'This roster names no moderators, so nothing here is moderated for you.'
          : `Moderated by ${mods.map((m) => m.name || short(m.key, 6)).join(', ')} — because the roster YOU hold says so. Hold a different revision and that changes.`
      )
    )

    const listing = await shell.forumListing(rootHash).catch(() => ({ rows: [], tribeEmpty: true }))
    // The warning that must never be quiet. With no vouches of your own every
    // tribe score is zero and the order degrades to raw popularity -- which is
    // precisely the ranking anyone can manufacture.
    if (listing.tribeEmpty) {
      const warn = el(
        'p',
        'sh-share-warn',
        'You have vouched for nobody, so these are ordered by raw vote count — the kind anyone can manufacture with a thousand throwaway keys. Vouch for someone you actually know and the order starts meaning something.'
      )
      warn.setAttribute('data-testid', 'forum-no-tribe')
      body.append(warn)
    }

    const posts = el('div')
    posts.setAttribute('data-testid', 'forum-posts')
    posts.setAttribute('data-count', String(listing.rows.length))
    if (listing.rows.length === 0) posts.append(el('div', 'evm-empty', 'Nothing posted here yet.'))
    for (const row of listing.rows) posts.append(forumPostRow(row, rootHash, overlay, facts.iAmModerator === true))
    body.append(posts)

    if (facts.pending && (facts.pending as unknown[]).length > 0) {
      body.append(el('h3', 'sh-transfers-h', 'Asking to join'))
      body.append(
        el(
          'p',
          'sh-hint',
          facts.keeperIsMe
            ? 'Publish a new version of the group naming them — that, and only that, puts somebody on a roster.'
            : 'Only the keeper can admit them, by publishing a new version of the group.'
        )
      )
      const pend = el('div')
      pend.setAttribute('data-testid', 'forum-pending')
      pend.setAttribute('data-count', String((facts.pending as unknown[]).length))
      for (const p of facts.pending as { envelopeHash: string; authorKey: string; petname: string | null }[]) {
        const item = el('button', 'sh-feed-item')
        item.setAttribute('data-testid', 'forum-pending-item')
        item.append(
          el('div', 'sh-feed-line', p.petname ?? short(p.authorKey, 8)),
          el('div', 'sh-feed-meta', 'asked to be listed')
        )
        item.addEventListener('click', () => {
          overlay.remove()
          void openThing(p.envelopeHash)
        })
        pend.append(item)
      }
      body.append(pend)
    }

    const write = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Write a post')
    write.setAttribute('data-testid', 'forum-write')
    write.addEventListener('click', async () => {
      const r = await shell.newForumPost(rootHash)
      if (!r.id) return showText(`Could not start a post: ${String(r.error ?? 'unknown')}`, 'danger')
      overlay.remove()
      await openThing(r.id)
    })
    footer.append(write)

    if (!facts.iAmMember) {
      const join = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Request to join')
      join.setAttribute('data-testid', 'forum-join')
      join.title = 'Asking is not joining: only the keeper can publish a roster that names you.'
      join.addEventListener('click', async () => {
        const r = await shell.requestJoin(rootHash)
        if (!r.id) return showText(`Could not start a request: ${String(r.error ?? 'unknown')}`, 'danger')
        overlay.remove()
        await openThing(r.id)
      })
      footer.append(join)
    }
  }

  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'forum-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** One ranked post. A hidden one is FOLDED, never dropped: the line says who
 *  hid it and why, and the post is still one press away. */
function forumPostRow(
  row: Record<string, unknown>,
  rootHash: string,
  overlay: HTMLElement,
  iAmModerator = false
): HTMLElement {
  const wrap = el('div', 'sh-forum-row')
  wrap.setAttribute('data-envelope-hash', String(row.envelopeHash))
  const verdict = row.verdict as { verdict: string; byName: string; by: string; why: string } | null
  const hidden = verdict?.verdict === 'hide'

  if (hidden) {
    const fold = el('div', 'sh-forum-folded')
    fold.setAttribute('data-testid', 'forum-hidden')
    const who = verdict.byName || short(verdict.by, 6)
    fold.append(
      el('span', 'sh-hint', verdict.why ? `Hidden by ${who} — ${verdict.why}` : `Hidden by ${who}`)
    )
    const anyway = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Show anyway')
    anyway.setAttribute('data-testid', 'forum-show-anyway')
    anyway.addEventListener('click', () => {
      fold.remove()
      wrap.append(forumPostBody(row, rootHash, overlay, verdict))
    })
    fold.append(anyway)
    wrap.append(fold)
    return wrap
  }
  wrap.append(forumPostBody(row, rootHash, overlay, verdict))
  // A moderator's two words. Only where they would count: the roster YOU hold
  // names you, the post is actually here (an offer has nothing to judge yet),
  // and nobody has ruled on it. Outside the row's own button -- buttons must
  // not nest -- and deliberately small: moderating is rare, reading is not.
  if (iAmModerator && !verdict && row.offered !== true) wrap.append(moderatorControls(String(row.envelopeHash), rootHash, overlay))
  return wrap
}

/** Hide / Endorse. Each starts an ordinary draft -- an attestation naming the
 *  post, the forum and the verdict -- which opens for the moderator to say WHY
 *  and is signed through the same Publish-and-confirm as anything else. No
 *  verdict is ever issued by this click alone. */
function moderatorControls(targetHash: string, rootHash: string, overlay: HTMLElement): HTMLElement {
  const bar = el('div', 'sh-forum-mod')
  bar.setAttribute('data-testid', 'forum-mod')
  bar.append(el('span', 'sh-hint', 'You moderate this forum:'))
  const tips: Record<string, string> = {
    hide: 'Start a signed verdict that folds this post behind a line saying who hid it and why. It deletes nothing, readers can still open it, and it only counts for people whose copy of the roster names you a moderator.',
    endorse: 'Start a signed verdict that marks this post as endorsed by you, for people whose copy of the roster names you a moderator.'
  }
  for (const verdict of ['hide', 'endorse'] as const) {
    const btn = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', verdict === 'hide' ? 'Hide…' : 'Endorse…')
    btn.setAttribute('data-testid', `forum-mod-${verdict}`)
    btn.title = tips[verdict]!
    btn.addEventListener('click', async () => {
      const r = await shell.newVerdict(targetHash, rootHash, verdict)
      if (!r.id) return showText(`Could not start a verdict: ${String(r.error ?? 'unknown')}`, 'danger')
      overlay.remove()
      await openThing(r.id)
      showText('Say why, then Publish. Post it to the forum’s relay for other readers to see it.', 'success')
    })
    bar.append(btn)
  }
  return bar
}

function forumPostBody(
  row: Record<string, unknown>,
  rootHash: string,
  overlay: HTMLElement,
  verdict: { verdict: string; byName: string; by: string; why: string } | null
): HTMLElement {
  // Not held: it ranks here because votes point at a hash whether or not you
  // have the thing, but it cannot be opened and has no author to show.
  if (row.offered === true) {
    const stub = offerItem({
      envelopeHash: String(row.envelopeHash),
      locator: String(row.locator ?? ''),
      relayUrl: String(row.relayUrl ?? ''),
      poster: String(row.poster ?? ''),
      type: String(row.type ?? 'letter'),
      inGroup: rootHash,
      replyTo: null,
      state: (row.offerState as OfferRow['state']) ?? 'offered',
      reason: String(row.offerReason ?? ''),
      seenAt: Number(row.receivedAt ?? 0)
    })
    const v = row.votes as { score: number; tribeUp: number; tribeDown: number; up: number; down: number }
    const score = el('span', 'sh-forum-score', v.score > 0 ? `+${v.score}` : String(v.score))
    score.setAttribute('data-testid', 'forum-score')
    score.title = voteTitle(v)
    stub.prepend(score)
    return stub
  }
  const item = el('button', 'sh-feed-item')
  item.setAttribute('data-testid', 'forum-post')
  item.setAttribute('data-envelope-hash', String(row.envelopeHash))
  const line = el('div', 'sh-feed-line')
  const v = row.votes as { score: number; tribeScore: number; up: number; down: number; tribeUp: number; tribeDown: number }
  const score = el('span', 'sh-forum-score', v.score > 0 ? `+${v.score}` : String(v.score))
  score.setAttribute('data-testid', 'forum-score')
  score.setAttribute('data-tribe', String(v.tribeScore))
  // The number that decided the order, beside the number everyone sees.
  score.title = voteTitle(v)
  line.append(score)
  line.append(el('span', 'evm-badge evm-badge--neutral', String(row.type)))
  line.append(
    el(
      'span',
      'sh-feed-author evm-address evm-address--muted',
      authorLabel(row as unknown as ThingRow).text
    )
  )
  const flags = el('span', 'sh-feed-flags')
  if (v.tribeUp + v.tribeDown > 0) {
    const badge = el('span', 'evm-badge evm-badge--info', `${v.tribeUp + v.tribeDown} yours`)
    badge.setAttribute('data-testid', 'forum-tribe-votes')
    flags.append(badge)
  }
  if (verdict?.verdict === 'endorse') flags.append(el('span', 'evm-badge evm-badge--success', 'endorsed'))
  line.append(flags)
  const replies = Number(row.replies ?? 0)
  const called = titleLine(row.title)
  item.append(line, ...(called ? [called] : []), el('div', 'sh-feed-meta', `${replies === 1 ? '1 reply' : `${replies} replies`}`))
  item.addEventListener('click', () => {
    overlay.remove()
    void openThing(String(row.envelopeHash))
  })
  void rootHash
  return item
}

/** The whole conversation under a thing, as a tree.
 *
 *  Threading is `replyTo` followed as deep as it goes — no new relation, just
 *  the one that was already there read recursively. Every level is still a
 *  CLAIM: nothing binds a reply to the thing it answers, and a reply whose
 *  target you do not hold is the commonest shape of that. */
async function openRepliesModal(target: string): Promise<void> {
  const { rows } = await shell.thread(target)
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'replies-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Comments on this'))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      'Letters in your library that claim to reply to this, and to each other. A reply is the commenter’s claim — like a timestamp, nothing binds it to this letter or its author.'
    )
  )
  if (rows.length === 0) body.append(el('div', 'evm-empty', 'Nothing in your library replies to this.'))
  for (const entry of rows) {
    const row = entry as unknown as ThingRow & {
      depth: number
      votes: { score: number; tribeScore: number; up: number; down: number; tribeUp: number; tribeDown: number }
    }
    const item = el('button', 'sh-feed-item sh-reply-item')
    item.setAttribute('data-testid', 'reply-item')
    item.setAttribute('data-envelope-hash', row.envelopeHash)
    item.setAttribute('data-depth', String(row.depth))
    // Indent by depth, capped: a thread 30 deep must stay readable rather than
    // walking off the right edge of the pane.
    item.style.marginLeft = `${Math.min(row.depth - 1, 8) * 14}px`
    const line = el('div', 'sh-feed-line')
    const score = el('span', 'sh-forum-score', row.votes.score > 0 ? `+${row.votes.score}` : String(row.votes.score))
    score.title = voteTitle(row.votes)
    line.append(
      score,
      el('span', 'evm-badge evm-badge--neutral', row.type),
      el('span', 'sh-feed-author evm-address evm-address--muted', authorLabel(row).text),
      el('span', 'sh-feed-flags')
    )
    const called = titleLine(row.title)
    item.append(line, ...(called ? [called] : []), el('div', 'sh-feed-meta', fmtTime(row.receivedAt)))
    item.addEventListener('click', () => {
      overlay.remove()
      void openThing(row.envelopeHash)
    })
    body.append(item)
  }
  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'replies-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** "12 · 3 yours" — the raw count, and how much of it came from your tribe.
 *
 *  Both numbers, always. The raw one is what everyone sees and is free to
 *  manufacture: a thousand keys cost nothing. The second cannot be forged
 *  without first getting inside your own vouches, and it is the only reason
 *  any of this means anything. Showing one score would hide which was which. */
function voteTitle(v: { up: number; down: number; tribeUp: number; tribeDown: number }): string {
  const total = v.up + v.down
  const tribe = v.tribeUp + v.tribeDown
  if (total === 0) return 'Nobody has voted on this.'
  const plural = total === 1 ? '1 vote' : `${total} votes`
  return tribe === 0
    ? `${plural}, none from anyone your vouches reach. A raw count is free to manufacture.`
    : `${plural}, ${tribe} from people you reached through your own vouches.`
}

/** ▲ score ▼ — the vote control, in chrome pixels the thing cannot reach.
 *
 *  A press signs a vote immediately. That is not a hole in the confirm rule:
 *  the dialog exists because a PROGRAM asked to publish in your name, and this
 *  came from a control you pressed, on a thing on your screen. */
function voteControl(envelopeHash: string, facts: NonNullable<HeaderFacts['votes']>): HTMLElement {
  const wrap = el('span', 'sh-votes')
  wrap.setAttribute('data-testid', 'header-votes')
  wrap.setAttribute('data-envelope-hash', envelopeHash)

  const up = el('button', 'evm-btn evm-btn--ghost evm-btn--sm sh-vote-btn', '▲') as HTMLButtonElement
  const down = el('button', 'evm-btn evm-btn--ghost evm-btn--sm sh-vote-btn', '▼') as HTMLButtonElement
  up.setAttribute('data-testid', 'vote-up')
  down.setAttribute('data-testid', 'vote-down')
  const score = el('span', 'sh-vote-score')
  score.setAttribute('data-testid', 'vote-score')
  const tribe = el('span', 'sh-vote-tribe')
  tribe.setAttribute('data-testid', 'vote-tribe')

  const paint = (v: NonNullable<HeaderFacts['votes']>): void => {
    score.textContent = v.score > 0 ? `+${v.score}` : String(v.score)
    // The tribe number sits beside the score rather than inside it: it is a
    // different claim about the same thing, and merging them into one number
    // would be exactly the unexplainable ranking this is trying to avoid.
    const t = v.tribeUp + v.tribeDown
    tribe.textContent = t === 0 ? '' : `${t} yours`
    wrap.setAttribute('data-score', String(v.score))
    wrap.setAttribute('data-tribe', String(v.tribeScore))
    wrap.setAttribute('data-mine', String(v.mine))
    up.classList.toggle('sh-vote-btn--cast', v.mine === 1)
    down.classList.toggle('sh-vote-btn--cast', v.mine === -1)
    up.disabled = false
    down.disabled = false
    wrap.title = voteTitle(v)
  }

  const cast = async (dir: 1 | -1): Promise<void> => {
    up.disabled = true
    down.disabled = true
    const r = await shell.vote(envelopeHash, dir)
    if (r.error) {
      // "already voted that way" is the common one and is not a failure worth
      // a red banner -- the control just goes back to showing the truth.
      showText(String(r.error), 'neutral')
      paint(await (shell.votes(envelopeHash) as Promise<NonNullable<HeaderFacts['votes']>>))
      return
    }
    paint(r as unknown as NonNullable<HeaderFacts['votes']>)
    await refreshFeed()
  }
  up.addEventListener('click', () => void cast(1))
  down.addEventListener('click', () => void cast(-1))

  paint(facts)
  wrap.append(up, score, tribe, down)
  return wrap
}

// ── Per-thing trust header ───────────────────────────────────────────────────
/** "Join the Souspli forum": the one place the app proposes talking to a
 *  server of its own accord -- so it proposes, and nothing more. Opening this
 *  dialog contacts nobody. It says what would be added and EXACTLY what that
 *  tells whom, in the words the Relays window uses, and acts only on the press.
 *  The relay list starting empty is a promise; this is how it stays one. */
async function openCommunityModal(): Promise<void> {
  const state = await shell.community()
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  modal.setAttribute('data-testid', 'community-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', state.forumAvailable ? 'Join the Souspli forum' : 'Add the Souspli relay'))
  const body = el('div', 'evm-modal-body')
  const host = state.relay.replace(/^wss?:\/\//, '')
  body.append(
    el(
      'p',
      undefined,
      state.forumAvailable
        ? 'Souspli is more use with people in it. The project runs a small relay, and a forum on it where you can ask questions, show what you have made, and find others to exchange letters with.'
        : 'Souspli is more use with people in it. The project runs a small relay: a place letters can reach you from people who have never been handed your address.'
    ),
    el('p', 'sh-hint', 'Saying yes does this, and only this:')
  )
  const does = el('ul', 'sh-community-list')
  does.append(el('li', undefined, `Adds ${state.relay} to your relays, and subscribes to the letters posted there.`))
  if (state.forumAvailable) does.append(el('li', undefined, 'Adds the forum’s roster — an ordinary signed letter, checked like any other — to your library, so File → Forums lists it.'))
  body.append(does, el('p', 'sh-hint', 'What it costs you:'))
  const costs = el('ul', 'sh-community-list')
  costs.append(
    el('li', undefined, `${host} learns your IP address, and that you are interested in what is posted there. It is run by the Souspli project on Cloudflare.`),
    el('li', undefined, 'Letters anyone posts there will arrive in your feed. Each is verified before it is shown, and a relay can never make one look like someone else wrote it — but strangers can reach you.'),
    el('li', undefined, 'Nothing of yours is sent. Posting stays a separate act, letter by letter, from Share…')
  )
  body.append(costs, el('p', 'sh-hint', 'You can remove it again at any time under File → Relays.'))
  const footer = el('div', 'evm-modal-footer')
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Not now')
  cancel.addEventListener('click', () => overlay.remove())
  const yes = el('button', 'evm-btn evm-btn--primary', state.forumAvailable ? 'Join' : 'Add the relay') as HTMLButtonElement
  yes.setAttribute('data-testid', 'community-join')
  yes.addEventListener('click', async () => {
    yes.disabled = true
    const r = await shell.joinCommunity()
    overlay.remove()
    if (r.error) return showText(`Could not add the relay: ${r.error}`, 'danger')
    showText(r.forumHash ? 'Joined. The forum is under File → Forums.' : `Added ${host}.`, 'success')
    await refreshFeed()
    if (!selected) renderHeader(null) // the offer in the empty state is spent
    if (r.forumHash) void openForumModal(r.forumHash)
  })
  footer.append(cancel, yes)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** A one-line offer for an empty list, shown only while there is something
 *  left to offer. Filled in after the list renders; asks main, contacts nobody. */
function appendCommunityOffer(into: HTMLElement, lead: string): void {
  void shell.community().then((c) => {
    if (c.relayAdded && (!c.forumAvailable || c.forumHeld)) return
    if (!into.isConnected) return
    const line = el('p', 'sh-hint sh-community-offer')
    line.setAttribute('data-testid', 'community-offer')
    const go = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', c.forumAvailable ? 'Join the Souspli forum…' : 'Add the Souspli relay…')
    go.setAttribute('data-testid', 'community-open')
    go.addEventListener('click', () => void openCommunityModal())
    line.append(el('span', undefined, lead + ' '), go)
    into.append(line)
  })
}

/** What fills the content area while no letter is open. It used to be nothing:
 *  a new install was a black rectangle under "Select a letter from the feed."
 *  The native cage view is only attached while something is mounted, so this
 *  space is the chrome's to draw in -- and it says what the app is and offers
 *  the two ways in. It is cleared the moment a letter takes the area. */
function renderWelcomePane(show: boolean): void {
  cageArea.replaceChildren()
  if (!show) return
  const pane = el('div', 'sh-welcome')
  pane.setAttribute('data-testid', 'welcome-pane')
  pane.append(
    el('h2', 'sh-welcome-title', 'Letters, not servers.'),
    el(
      'p',
      'sh-welcome-lede',
      'A letter is one signed file. Its words, pictures and layout travel together, nobody can change it once it is signed, and it opens in a sealed container that cannot phone home. Nothing here touches the network unless you ask it to.'
    )
  )
  const actions = el('div', 'sh-welcome-actions')
  const write = el('button', 'evm-btn evm-btn--primary', 'Write a letter') as HTMLButtonElement
  write.setAttribute('data-testid', 'welcome-write')
  write.addEventListener('click', () => void openNewMenu())
  const open = el('button', 'evm-btn evm-btn--secondary', 'Open a letter file…') as HTMLButtonElement
  open.setAttribute('data-testid', 'welcome-open')
  open.addEventListener('click', () => fileInput.click())
  actions.append(write, open)
  // The third way in: people. Present only while there is an offer to make.
  void shell.community().then((c) => {
    if (c.relayAdded && (!c.forumAvailable || c.forumHeld)) return
    if (!actions.isConnected) return
    const people = el('button', 'evm-btn evm-btn--secondary', 'Find people…') as HTMLButtonElement
    people.setAttribute('data-testid', 'welcome-people')
    people.addEventListener('click', () => void openCommunityModal())
    actions.append(people)
  })
  pane.append(
    actions,
    el(
      'p',
      'sh-hint',
      'You can also drag a .thing file onto this window, or paste a letter or a link into the box at the top. Whatever arrives is verified — signature, program and every attachment — before any of it is shown.'
    ),
    el('p', 'sh-hint', 'Guides and the full specification: souspli.org')
  )
  cageArea.append(pane)
}

function renderHeader(h: HeaderFacts | null): void {
  thingHeader.replaceChildren()
  refitHeader = null
  thingHeader.classList.remove('sh-thing-header--tight')
  // Which thing this row is describing. The header is rebuilt per open, so
  // anything filled in asynchronously must check this before touching it.
  if (h) thingHeader.setAttribute('data-envelope-hash', h.envelopeHash)
  else thingHeader.removeAttribute('data-envelope-hash')
  renderWelcomePane(!h)
  if (!h) {
    modeButtons = null
    trustBadge = null
    previewBadge = null
    publishBtn = null
    repliesBadge = null
    thingHeader.append(el('span', 'sh-hint', 'Select a letter from the feed.'))
    return
  }
  // Signature status: everything in the library is admission-`valid`, so a
  // mounted thing is signed-and-verified. The badge uses the DS success token —
  // this is the trust signal the thing must never be able to forge.
  // A draft is UNSIGNED: the trust badge must never claim otherwise.
  const badge = h.draft
    ? el('span', 'evm-badge evm-badge--warning sh-verified', 'DRAFT — not signed')
    : el('span', 'evm-badge evm-badge--success sh-verified', '✓ signed')
  badge.setAttribute('data-trust', h.draft ? 'draft' : 'verified')
  if (h.draft) badge.setAttribute('data-testid', 'header-draft-badge')
  trustBadge = badge
  // Hidden until view mode shows an unpublished-draft preview (see
  // styleModeButtons) — then it REPLACES the trust badge.
  // Short on purpose: the status slot is sized to the WIDER of its two badges
  // for the life of the header, so every character here is width the row pays
  // for even while it says "✓ signed". The tooltip carries the sentence.
  previewBadge = el('span', 'evm-badge evm-badge--warning', 'PREVIEW')
  previewBadge.title = 'A preview of your unpublished draft. Nothing here is signed until you press Publish and confirm.'
  previewBadge.setAttribute('data-testid', 'preview-badge')
  previewBadge.style.visibility = 'hidden'
  // Both badges share one grid cell; the slot is permanently sized to the
  // wider of the two, so swapping them never moves the controls after it.
  const statusSlot = el('span', 'sh-status-slot')
  statusSlot.append(badge, previewBadge)
  // Author identity: a VERIFIED name (confirmed to map to the author key) is
  // shown as a name; otherwise the raw key, marked unverified. The name lives in
  // chrome pixels the thing cannot reach.
  let authorEl: HTMLElement
  if (h.name) {
    authorEl = el('span', 'evm-badge evm-badge--info sh-name', `✓ ${h.name}`)
    authorEl.setAttribute('data-name', 'verified')
    authorEl.setAttribute('title', `${h.authorScheme}:${h.authorKey}`)
  } else {
    const mine = isMine(h)
    // A petname is YOUR label, so it reads as a name but never borrows the
    // verified treatment above: data-name stays 'petname', not 'verified'.
    const lab = authorLabel(h)
    authorEl = mine
      ? el('span', 'sh-feed-you', 'you')
      : el('span', lab.named ? 'sh-name sh-name--pet' : 'evm-address evm-address--muted', lab.text)
    authorEl.setAttribute('data-name', mine ? 'self' : lab.named ? 'petname' : 'unverified')
    if (mine) authorEl.setAttribute('data-testid', 'header-you')
    authorEl.setAttribute('title', mine ? `${h.authorScheme}:${h.authorKey}` : lab.title)
  }
  // Naming a key is a per-author action, so it hangs off the author itself
  // rather than adding another control to a crowded row.
  if (!isMine(h)) {
    authorEl.setAttribute('role', 'button')
    authorEl.setAttribute('data-testid', 'header-author')
    authorEl.classList.add('sh-nameable')
    authorEl.addEventListener('click', () => openPetnameModal(h.authorScheme, h.authorKey, h.petname ?? null))
  }
  const typeBadge = el('span', 'evm-badge evm-badge--neutral', h.type)
  const hashEl = el('span', 'sh-hash evm-address evm-address--muted', short(h.envelopeHash, 8))
  // Copy: the shell-level "edit this object" primitive — things are immutable,
  // so editing starts by making your own instance with the same program+args.
  const copyBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Copy')
  if (h.draft) copyBtn.style.display = 'none' // nothing to copy until it is signed
  copyBtn.setAttribute('data-testid', 'header-copy')
  copyBtn.addEventListener('click', async () => {
    const outcome = await shell.copyThing(h.envelopeHash)
    if (outcome.status === 'valid' && outcome.duplicate !== true) {
      showText('Copied — your new instance is in the feed', 'success')
    } else if (outcome.status === 'valid') {
      // An envelope hash covers author + content + the claimed second. Copying
      // your OWN thing inside that second reproduces it exactly, so there is
      // nothing to add -- and saying "your new instance is in the feed" when
      // no row appeared would be a plain falsehood.
      showText('That would be identical to the original, so nothing was added', 'neutral')
    } else {
      showText(`Copy failed: ${String(outcome.reason ?? outcome.status)}`, 'danger')
    }
    await refreshFeed()
  })
  // New version. On your own thing this continues your line; on someone
  // else's it starts YOUR line rooted on theirs, because a chain is
  // (author, path) and you cannot sign as them. The label says which, rather
  // than letting "New version" imply you are editing their document.
  const amendBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', h.mine ? 'New version…' : 'Your version…')
  amendBtn.setAttribute('data-testid', 'header-amend')
  if (h.draft) amendBtn.style.display = 'none' // nothing published to amend yet
  amendBtn.title = h.mine
    ? 'Publish a new version, chained to this one'
    : 'Start your own version of this. It is chained to theirs, but it is your line — you cannot publish a new version of someone else’s letter.'
  amendBtn.addEventListener('click', () => {
    void shell.amend(h.envelopeHash).then((r) => {
      if (!r.id) return showText(`Could not start a version: ${String(r.error ?? 'unknown')}`, 'danger')
      void openThing(r.id)
    })
  })

  // Share: every way this thing can leave the machine, behind one control.
  // Deliberately ONE button rather than three -- this row already carries nine
  // and overflows its pane at the default window size.
  const exportBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Share\u2026')
  if (h.draft) exportBtn.style.display = 'none' // nothing signed to hand over yet
  exportBtn.setAttribute('data-testid', 'header-export')
  exportBtn.addEventListener('click', () => openShareModal(h.envelopeHash, h.type))
  const delBtn = el('button', 'evm-btn evm-btn--danger evm-btn--sm', h.draft ? 'Discard' : 'Delete')
  delBtn.setAttribute('data-testid', 'header-delete')
  delBtn.addEventListener('click', () => void deleteWithConfirm(h.envelopeHash, h.type, h.draft === true))
  // Publish: signs the LATEST streamed draft — exactly what the preview shows.
  // Disabled until the program streams one (see styleModeButtons).
  const pub = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Publish') as HTMLButtonElement
  pub.setAttribute('data-testid', 'header-publish')
  pub.addEventListener('click', async () => {
    const r = await shell.publishDraft()
    if (r.status === 'invalid') showText(String(r.reason), 'danger')
  })
  publishBtn = pub

  // ── Replies ────────────────────────────────────────────────────────────────
  // A reply is an author CLAIM: anyone may claim to reply to anything, and the
  // target's author never consented. So: never the ✓ vocabulary, always scoped
  // to "your library", and honest when the target is missing.
  const replyBits: HTMLElement[] = []
  // The rarer actions. This row carried sixteen things and scrolled sideways
  // even in a 1440px window; what is left in it is what you read (who, what,
  // whether it is signed, how it relates to what you hold) and what you do
  // often (mode, Publish, Comment, vote, Share). These go behind "⋯".
  const moreItems: { btn: HTMLElement; hint: string }[] = []
  let commentEl: HTMLElement | null = null
  let groupChip: HTMLElement | null = null
  if (!h.draft) {
    const commentBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Comment')
    commentBtn.setAttribute('data-testid', 'header-comment')
    commentBtn.addEventListener('click', async () => {
      const r = await shell.newComment(h.envelopeHash)
      if (!r.id) {
        showText(`Could not start a comment: ${String(r.error ?? 'unknown')}`, 'danger')
        return
      }
      await openThing(r.id)
    })
    commentEl = commentBtn
    replyBits.push(commentBtn)

    const count = h.replyCount ?? 0
    repliesBadge = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', replyLabel(count))
    repliesBadge.setAttribute('data-testid', 'header-replies')
    repliesBadge.setAttribute('data-count', String(count))
    // "no comments" is ninety pixels of nothing in a row that has none to
    // spare: shown once there is one. Kept in the DOM so its count is readable.
    repliesBadge.hidden = count === 0
    // Which thing this count is about — the header is rebuilt per open, so
    // this is also how a test knows the rebuild has caught up.
    repliesBadge.setAttribute('data-envelope-hash', h.envelopeHash)
    repliesBadge.addEventListener('click', () => void openRepliesModal(h.envelopeHash))
    replyBits.push(repliesBadge)

    // Attest: put your signature behind a statement about this thing. Distinct
    // from Comment on purpose -- a comment says something, an attestation
    // stakes a signature on it.
    const attestBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Attest')
    attestBtn.setAttribute('data-testid', 'header-attest')
    attestBtn.addEventListener('click', async () => {
      const r = await shell.newAttestation(h.envelopeHash)
      if (!r.id) {
        showText(`Could not start an attestation: ${String(r.error ?? 'unknown')}`, 'danger')
        return
      }
      await openThing(r.id)
    })
    moreItems.push({ btn: attestBtn, hint: 'Put your signature behind a statement about this letter.' })

    const attests = h.attestCount ?? 0
    attestBadge = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', attestLabel(attests))
    attestBadge.setAttribute('data-testid', 'header-attestations')
    attestBadge.setAttribute('data-count', String(attests))
    attestBadge.hidden = attests === 0 // as with comments: said once it is true
    attestBadge.setAttribute('data-envelope-hash', h.envelopeHash)
    attestBadge.addEventListener('click', () => void openAttestationsModal(h.envelopeHash))
    replyBits.push(attestBadge)
  }
  if (h.replyTo) {
    const known = h.replyToKnown === true
    const rt = el('span', `sh-replyto${known ? ' sh-replyto--known' : ''}`, `in reply to ${short(h.replyTo, 6)}`)
    rt.setAttribute('data-testid', 'header-replyto')
    rt.setAttribute('data-known', known ? '1' : '0')
    rt.title = known
      ? `${h.replyTo} — click to open`
      : `${h.replyTo} — not in your library: you have the reply, not the letter it claims to answer`
    if (known) {
      rt.setAttribute('role', 'button')
      rt.addEventListener('click', () => void openThing(h.replyTo!))
    }
    replyBits.push(rt)
  }
  // Where this sits in its author's line, when it is in one at all. A version
  // number is only meaningful next to the count: "v2" alone does not tell you
  // whether you are looking at the current roster or a stale one.
  if (!h.draft && typeof h.version === 'number' && typeof h.versionCount === 'number' && h.versionCount > 0) {
    const label = h.version === 0 ? `original of ${h.versionCount + 1}` : `version ${h.version} of ${h.versionCount}`
    const vb = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', label)
    vb.setAttribute('data-testid', 'header-version')
    // Tagged with the hash it describes: the header is rebuilt asynchronously,
    // so a reader (or a test) polling for "the badge" can otherwise catch the
    // previous thing's badge mid-swap.
    vb.setAttribute('data-envelope-hash', h.envelopeHash)
    vb.setAttribute('data-seq', String(h.version))
    vb.setAttribute('data-superseded', h.supersededBy ? '1' : '0')
    vb.title = h.supersededBy
      ? 'A later version exists. What you are reading has been superseded.'
      : 'The current version of this line.'
    if (h.supersededBy) vb.classList.add('sh-superseded')
    const chainPath = h.chainPath ?? h.envelopeHash
    vb.addEventListener('click', () => void openHistoryModal(h.authorKey, chainPath, h.envelopeHash))
    replyBits.push(vb)

    if (h.supersededBy) {
      const go = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Latest')
      go.setAttribute('data-testid', 'header-latest')
      go.title = 'Open the current version'
      go.addEventListener('click', () => void openThing(h.supersededBy!))
      replyBits.push(go)
    }
    // A version pointing somewhere other than the version before it is worth
    // saying out loud: prev is an author claim, and this is the one place it
    // can be checked.
    if (h.prevMatches === false) {
      const bad = el('span', 'evm-badge evm-badge--danger', 'prev does not match')
      bad.setAttribute('data-testid', 'header-prev-mismatch')
      bad.title = 'This version says it follows something other than the version before it.'
      replyBits.push(bad)
    }
  }

  // A document several people sign. Only for declared documents: an ordinary
  // thing shares no manifest with anyone and is not awaiting signatures.
  if (h.cosignable && !h.draft) {
    const sigBadge = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', signedLabel(h))
    sigBadge.setAttribute('data-testid', 'header-signatures')
    sigBadge.setAttribute('data-signed', String(h.namedSignedCount ?? 0))
    sigBadge.setAttribute('data-named', String(h.namedCount ?? 0))
    sigBadge.setAttribute('data-unnamed', String(h.unnamedSignedCount ?? 0))
    sigBadge.title = 'Who has signed this document, and who it names. Not a measure of how valid it is.'
    sigBadge.addEventListener('click', () => void openSignaturesModal(h.manifestHash ?? ''))
    replyBits.push(sigBadge)

    if (!isMine(h) || h.signedByMe !== true) {
      const cosignBtn = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Co-sign…') as HTMLButtonElement
      cosignBtn.setAttribute('data-testid', 'header-cosign')
      cosignBtn.disabled = h.signedByMe === true
      cosignBtn.title = h.signedByMe
        ? 'You have already signed this document'
        : 'Sign these exact document bytes with your key'
      cosignBtn.addEventListener('click', () => {
        void shell.cosign(h.envelopeHash).then((r) => {
          // 'pending' is the confirm being raised — the outcome arrives there.
          if (r.status && r.status !== 'pending') {
            showText(`Could not co-sign: ${String(r.reason ?? r.status)}`, 'danger')
          }
        })
      })
      replyBits.push(cosignBtn)
    }
  }
  // Whose key this vouch speaks about, when it is a vouch. A vouch names a
  // KEY rather than a thing, so there is nothing to open -- what is useful is
  // whether you have ever seen that key, and what you call it.
  if (h.vouchAbout) {
    const known = h.vouchAboutKnown === true
    const label = h.vouchAboutName ?? short(h.vouchAbout, 6)
    const vb = el('span', `sh-replyto${known ? ' sh-replyto--known' : ''}`, `vouches for ${label}`)
    vb.setAttribute('data-testid', 'header-vouch-about')
    vb.setAttribute('data-known', known ? '1' : '0')
    vb.title = known
      ? `${h.vouchAboutScheme}:${h.vouchAbout} — you hold letters by this key`
      : `${h.vouchAboutScheme}:${h.vouchAbout} — you hold nothing by this key, so this vouch is about a stranger to you`
    replyBits.push(vb)
  }
  // What THIS thing attests to, when it is an attestation. Same honesty as
  // replyTo: it is a claim, the target's author never agreed, and we say when
  // the target is not held rather than hiding the mismatch.
  if (h.attests) {
    const known = h.attestsKnown === true
    const at = el('span', `sh-replyto${known ? ' sh-replyto--known' : ''}`, `about ${short(h.attests, 6)}`)
    at.setAttribute('data-testid', 'header-attests')
    at.setAttribute('data-known', known ? '1' : '0')
    at.title = known
      ? `${h.attests} — click to open`
      : `${h.attests} — not in your library: you have the attestation, not the letter it speaks about`
    if (known) {
      at.setAttribute('role', 'button')
      at.addEventListener('click', () => void openThing(h.attests!))
    }
    replyBits.push(at)
  }

  // Voting, and which forum this is in. Both belong beside the reply controls:
  // they are things you DO to a thing, not facts about its signature.
  if (!h.draft && h.votes) replyBits.push(voteControl(h.envelopeHash, h.votes))
  if (h.inGroup) {
    const known = h.inGroupKnown === true
    const chip = el('span', `sh-replyto${known ? ' sh-replyto--known' : ''}`, `in ${short(h.inGroup, 6)}`)
    chip.setAttribute('data-testid', 'header-ingroup')
    groupChip = chip
    chip.setAttribute('data-known', known ? '1' : '0')
    chip.title = known
      ? `${h.inGroup} — click to open the forum. Being tagged into a group is the author’s claim; the roster never agreed to it.`
      : `${h.inGroup} — you do not hold that group, so nobody moderates or ranks this for you`
    if (known) {
      chip.setAttribute('role', 'button')
      chip.addEventListener('click', () => void openForumModal(h.inGroup!))
    }
    replyBits.push(chip)
  }

  // How this thing REACHED you, when it came off a relay. Deliberately its own
  // chip, next to the author and never merged with them: whoever posted a
  // thing to a relay is a messenger, and anyone may relay anyone. The author
  // is, always, whoever signed it -- shown at the left of this row.
  //
  // Filled in asynchronously (the header is built from what main already
  // knows), and only when there IS something to say.
  if (!h.draft) {
    const askedFor = h.envelopeHash
    void shell
      .relayArrivals(askedFor)
      .then((arrivals) => {
        // The header is rebuilt per open; a slow answer must not decorate
        // whatever thing is on screen by the time it lands.
        if (arrivals.length === 0 || thingHeader.getAttribute('data-envelope-hash') !== askedFor) return
        const relayed = arrivals.filter((a) => !a.selfPosted)
        const chip = el(
          'span',
          'sh-replyto sh-replyto--known',
          relayed.length > 0 ? `relayed by ${short(relayed[0]!.poster, 6)}` : 'posted by its author'
        )
        chip.setAttribute('data-testid', 'header-relayed')
        chip.setAttribute('data-relayed', relayed.length > 0 ? '1' : '0')
        chip.title =
          relayed.length > 0
            ? `Handed to you on ${relayed[0]!.relayUrl} by ${relayed[0]!.poster}. That is who passed it along, NOT who wrote it — the author is the key this row names, because the author is whoever signed it.`
            : `Posted to ${arrivals[0]!.relayUrl} by its own author: the key that signed this letter is the key that posted it.`
        thingHeader.append(chip)
      })
      .catch(() => undefined)
  }

  // Where the author sits relative to you. Shown only when they are actually
  // reachable from your own vouches -- absence is the normal case and needs no
  // badge, and a "0" would read as a score, which this is not.
  const seatBits: HTMLElement[] = []
  let farSeat: HTMLElement | null = null // the two-hop badge: the longest label in the row
  if (typeof h.authorHops === 'number') {
    const seat = el('span', 'evm-badge evm-badge--neutral sh-tribe-badge', tribeSeat(h.authorHops))
    seat.setAttribute('data-testid', 'header-tribe')
    seat.setAttribute('data-hops', String(h.authorHops))
    seat.title =
      h.authorHops === 1
        ? 'You have vouched for this key. That records that you know them — nothing about this letter.'
        : 'Reached through someone you vouched for. It says how you know of them, not that they are honest.'
    if (h.authorHops === 2) farSeat = seat
    seatBits.push(seat)
  }

  thingHeader.append(
    statusSlot,
    el('span', 'sh-by', 'by'),
    authorEl,
    ...seatBits,
    typeBadge,
    renderModeToggle(),
    pub,
    el('span', 'sh-spacer'),
    ...replyBits,
    exportBtn
  )
  if (h.draft) {
    // A draft's row is short -- there is nothing signed to copy, amend, share
    // or name by hash -- so its one other action stays where it can be seen.
    thingHeader.append(delBtn)
  } else {
    moreItems.push(
      { btn: amendBtn, hint: amendBtn.title },
      { btn: copyBtn, hint: 'Start a new draft of your own from this letter’s content.' },
      { btn: delBtn, hint: 'Remove it from your library. Copies already shared are unaffected.' }
    )
    const more = moreControl(moreItems, h.envelopeHash, hashEl)
    thingHeader.append(more.el)

    // What is in "⋯" above is there ALWAYS. These go only when the row still
    // does not fit, in this order, and come back when it does -- so a wide
    // window loses nothing, and a narrow one loses the least useful thing
    // first. Past the last step the row scrolls sideways, as it always could.
    const steps: { apply(): void; undo(): void }[] = []
    if (farSeat) {
      const seat = farSeat
      const full = seat.textContent ?? ''
      // The sentence stays in the tooltip; only the label is shortened.
      steps.push({ apply: () => (seat.textContent = 'vouched second-hand'), undo: () => (seat.textContent = full) })
    }
    if (groupChip) {
      // Half a hash identifies a forum to a reader no better than a third of
      // one; the whole of it is in the tooltip either way.
      const chip = groupChip
      const full = chip.textContent ?? ''
      steps.push({ apply: () => (chip.textContent = `in ${h.inGroup!.slice(0, 6)}…`), undo: () => (chip.textContent = full) })
    }
    steps.push({
      apply: () => more.adopt(exportBtn, 'Every way this letter can leave this machine: a file, text, a magnet link, a relay.'),
      undo: () => {
        more.release(exportBtn)
        thingHeader.insertBefore(exportBtn, more.el)
      }
    })
    // The "3 yours" beside the score. It does not vanish -- the score's tooltip
    // spells out both counts -- but a row that scrolls hides things less
    // predictably than this does.
    steps.push({
      apply: () => thingHeader.classList.add('sh-thing-header--tight'),
      undo: () => thingHeader.classList.remove('sh-thing-header--tight')
    })
    if (commentEl) {
      // Last, and only for a letter carrying nearly everything a letter can:
      // a petname, a seat, comments, attestations, votes and a forum.
      const btn = commentEl
      const next = btn.nextSibling
      steps.push({
        apply: () => more.adopt(btn, 'Write a reply. It is a new letter of yours that points at this one.'),
        undo: () => {
          more.release(btn)
          thingHeader.insertBefore(btn, next && next.parentNode === thingHeader ? next : more.el)
        }
      })
    }
    refitHeader = () => {
      for (const st of steps) st.undo()
      for (const st of steps) {
        if (thingHeader.scrollWidth <= thingHeader.clientWidth) break
        st.apply()
      }
    }
  }
  if (h.isFork) thingHeader.append(el('span', 'evm-badge evm-badge--danger', 'FORK — author history diverged'))
  // Main pushes mode-changed BEFORE shell.open returns, i.e. before these
  // elements existed — apply the cached state to the freshly built controls.
  styleModeButtons()
  refitHeader?.()
}

/** Re-run the open header's overflow steps; null when nothing signed is open. */
let refitHeader: (() => void) | null = null
// The pane changes width with the window, and what fits changes with it.
new ResizeObserver(() => refitHeader?.()).observe(thingHeader)

/** "⋯": the rarer actions on the open letter, and its full hash.
 *
 *  A dialog rather than a dropdown, because the cage is a native view composited
 *  ABOVE the chrome: a menu drawn under the header would open behind the letter.
 *  Every other dialog here has the same constraint and the same answer.
 *
 *  The buttons are the REAL ones -- built by renderHeader with their handlers
 *  and test ids -- parked in a hidden holder in the header and MOVED into the
 *  dialog while it is open. One set of handlers, nothing proxied, and the ids
 *  stay addressable whether or not the dialog is up. */
function moreControl(
  items: { btn: HTMLElement; hint: string }[],
  envelopeHash: string,
  hashEl: HTMLElement
): { el: HTMLElement; adopt(btn: HTMLElement, hint: string): void; release(btn: HTMLElement): void } {
  const wrap = el('span', 'sh-more')
  const holder = el('span', 'sh-more-holder')
  holder.hidden = true
  // The short hash used to sit at the end of the row; it stays addressable
  // here, and the dialog shows the WHOLE hash with a Copy beside it, which the
  // row never had room for.
  holder.append(...items.map((i) => i.btn), hashEl)
  const open = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', '⋯') as HTMLButtonElement
  open.setAttribute('data-testid', 'header-more')
  open.setAttribute('aria-label', 'More actions')
  open.title = 'More: attest, new version, copy, delete, and the full hash'
  open.addEventListener('click', () => {
    const overlay = el('div', 'evm-modal-overlay')
    const modal = el('div', 'evm-modal sh-more-modal')
    modal.setAttribute('data-testid', 'more-menu')
    const header = el('div', 'evm-modal-header')
    header.append(el('span', 'evm-modal-title', 'More'))
    const body = el('div', 'evm-modal-body')
    for (const { btn, hint } of items) {
      if (btn.style.display === 'none') continue
      const row = el('div', 'sh-more-row')
      row.append(btn, el('span', 'sh-hint', hint))
      body.append(row)
    }
    body.append(copyField('Hash', envelopeHash, 'more-hash'))
    const footer = el('div', 'evm-modal-footer')
    const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
    const shut = (): void => {
      // Back to the holder, so the ids resolve again and a reopen finds them.
      // If the header was rebuilt meanwhile the holder is detached; harmless.
      holder.prepend(...items.map((i) => i.btn))
      overlay.remove()
    }
    close.addEventListener('click', shut)
    // Choosing something is also leaving: each action opens its own dialog or
    // another letter, and must not do so underneath this one.
    body.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.sh-more-row button')) shut()
    })
    footer.append(close)
    modal.append(header, body, footer)
    overlay.append(modal)
    document.body.append(trackOverlay(overlay, shut))
  })
  wrap.append(open, holder)
  return {
    el: wrap,
    /** Take a control out of the row and into the menu (the row was too tight). */
    adopt(btn, hint) {
      if (items.some((i) => i.btn === btn)) return
      items.unshift({ btn, hint }) // first: it was in plain sight a moment ago
      holder.prepend(btn)
    },
    /** Give it back; the caller puts it where it belongs in the row. */
    release(btn) {
      const at = items.findIndex((i) => i.btn === btn)
      if (at >= 0) items.splice(at, 1)
    }
  }
}

let openSeq = 0

async function openThing(envelopeHash: string): Promise<void> {
  const seq = ++openSeq
  selected = envelopeHash
  const header = await shell.open(envelopeHash)
  // Opens overlap: a feed click, a reply-list jump, and the auto-open after a
  // publish are all fire-and-forget, so replies can land out of order. Only
  // the newest request's answer may be painted.
  //
  // Counted, not compared by hash: two opens of the SAME thing still carry
  // different facts, because the header reports library state that moves
  // underneath it. Publish auto-opens the new comment; you then delete the
  // thing it replies to; the in-flight answer lands last and restores "in
  // reply to <target>" as HELD -- the header claiming you hold something you
  // just deleted. Comparing hashes cannot see that; a sequence number can.
  if (seq !== openSeq) return
  // An open can fail (e.g. a stale feed row, or a sealed thing after restart)
  // — surface it instead of rendering an error object as header facts.
  if ((header as unknown as { error?: string }).error) {
    selected = null
    renderHeader(null)
    showText(`Open failed: ${(header as unknown as { error: string }).error}`, 'danger')
    return
  }
  renderHeader(header)
  await refreshFeed()
}

// ── Confirm flow (a thing requests; the human decides, in chrome) ────────────
shell.onConfirmRequest((req) => {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  // 'publish' is user-initiated (the chrome Publish button signing the
  // previewed draft); anything else would be a thing's own request.
  const title =
    req.kind === 'publish'
      ? 'Publish a new instance?'
      : req.kind === 'cosign'
        ? 'Add your signature to this document?'
        : `A letter wants to ${req.kind}`
  header.append(el('span', 'evm-modal-title', title))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      req.kind === 'publish'
        ? 'This signs the previewed draft with your identity as a new letter in your feed. Nothing happens until you approve it here.'
        : req.kind === 'cosign'
          ? 'This signs the exact document below with your identity — the same bytes the earlier signers signed, unchanged. Your signature is public, permanent, and cannot be withdrawn.'
          : 'This request grants nothing until you approve it here.'
    )
  )
  // Co-signing is the one confirm where being NAMED matters, and where the
  // difference between the two must be spelled out rather than implied.
  if (req.kind === 'cosign') {
    const named = req.summary.iAmNamed === true
    const note = el('p', 'sh-hint sh-cosign-note')
    note.setAttribute('data-testid', 'cosign-named')
    note.setAttribute('data-named', named ? '1' : '0')
    note.textContent = named
      ? 'This document names you as a signatory. That is the drafter’s claim about who should sign — it has never bound you, and signing now is what makes it your commitment.'
      : 'This document does not name you as a signatory. You may still sign it, and your signature will be just as real; it will simply be recorded as one the document did not ask for.'
    body.append(note)
  }
  const pre = el('pre', 'sh-draft') as HTMLPreElement
  pre.textContent = JSON.stringify(req.summary, null, 2)
  body.append(pre)
  const footer = el('div', 'evm-modal-footer')
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Reject')
  cancel.setAttribute('data-testid', 'confirm-reject')
  const ok = el('button', 'evm-btn evm-btn--primary', `Approve ${req.kind}`)
  ok.setAttribute('data-testid', 'confirm-approve')
  const closeModal = (approved: boolean): void => {
    shell.respondConfirm(req.id, approved)
    overlay.remove()
  }
  cancel.addEventListener('click', () => closeModal(false))
  ok.addEventListener('click', () => closeModal(true))
  footer.append(cancel, ok)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay, () => closeModal(false)))
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// Test hook: let the N6 pixel test drive a real open (renders the trust header)
// without simulating a click. Harmless in the trusted chrome.
;(window as unknown as { __shellChrome: unknown }).__shellChrome = {
  openThing,
  openPeople: openPeopleModal,
  openTransfers: openTransfersModal,
  /** TEST: push a state into the open Transfers window. The states worth
   *  reading are the ones a hermetic test cannot produce -- a peer that is
   *  discovered but will not answer needs a real unreachable peer -- and the
   *  wording for exactly that case is the point of the window. */
  paintTransfers: (state: TransferState) => transfersPainter?.(state),
  openRelays: openRelaysModal,
  openForums: openForumsModal,
  openForum: openForumModal,
  openShare: openShareModal
}

// ── Boot ─────────────────────────────────────────────────────────────────────
shell.onFeedChanged(() => {
  void refreshFeed()
  // Keep the comment count fresh without rebuilding the header (a rebuild
  // would re-run renderModeToggle and move the pinned controls).
  if (selected && repliesBadge && !selected.startsWith('draft:')) {
    const asked = selected
    void shell
      .replies(asked)
      .then((r) => {
        // Open something else while this is in flight and the header is
        // rebuilt with a new badge — writing the old count into it would
        // label the new thing with the previous one's comments.
        if (!repliesBadge || repliesBadge.getAttribute('data-envelope-hash') !== asked) return
        repliesBadge.textContent = replyLabel(r.count)
        repliesBadge.setAttribute('data-count', String(r.count))
        repliesBadge.hidden = r.count === 0
      })
      .catch(() => {
        /* a stale count is not worth an unhandled rejection */
      })
    // Same for attestations, guarded the same way and for the same reason.
    void shell
      .attestations(asked)
      .then((r) => {
        if (!attestBadge || attestBadge.getAttribute('data-envelope-hash') !== asked) return
        attestBadge.textContent = attestLabel(r.count)
        attestBadge.setAttribute('data-count', String(r.count))
        attestBadge.hidden = r.count === 0
      })
      .catch(() => {
        /* a stale count is not worth an unhandled rejection */
      })
  }
})
shell.onModeChanged((p) => {
  currentMode = p.mode
  previewActive = p.preview
  publishable = p.publishable
  styleModeButtons()
})
shell.onPublishResult((o) => {
  if (o.status === 'valid') {
    showText('Published to your feed', 'success')
    // The draft was consumed — land on the signed instance, which really is
    // "✓ signed" (the draft's own header said DRAFT).
    //
    // ONLY if this window is still showing that draft. This result arrives
    // whenever the signing finishes, and an unconditional open here is a
    // fire-and-forget request that can land AFTER something else has been
    // opened -- main orders opens by arrival, so the stale one wins and yanks
    // the view off whatever you just chose. Rare by hand (the window is a few
    // milliseconds) and reliable under automation, where it was a recurring
    // test failure: the published thing superseded the next draft, and Publish
    // then truthfully reported nothing to publish for as long as anyone asked.
    const consumed = typeof o.consumedDraftId === 'string' ? o.consumedDraftId : null
    if (o.draftConsumed === true && typeof o.envelopeHash === 'string' && consumed !== null && selected === consumed) {
      void openThing(o.envelopeHash)
    }
  } else showText(`Publish failed: ${String(o.reason ?? o.status)}`, 'danger')
})
shell.onOpenSharing(() => openTransfersModal())
shell.onOpenRelays(() => openRelaysModal())
shell.onOpenForums(() => void openForumsModal())
// Pushed while anything is in flight; ignored when the window is closed.
shell.onTransfers((state) => transfersPainter?.(state))
shell.onOpenPeople(() => openPeopleModal())
shell.onOpenAccount(() => void openAccountModal()) // File → Account & Keys…
// A .thing double-clicked in the file manager: say what became of it, using
// the same wording as any other ingest (it went through the same gate).
shell.onOpenedThing(({ envelopeHash }) => {
  void shell.pendingOpen() // collected: the event got here first
  void openThing(envelopeHash)
})
shell.onFileOpened((r) => {
  const name = String(r.path ?? '').split(/[\\/]/).pop()
  if (r.status === 'valid') showText(`Opened ${name} — admitted as ${String(r.type)}`, 'success')
  else if (r.status === 'invalid') showText(`${name}: INVALID — ${String(r.reason)}`, 'danger')
  else if (r.status === 'unverifiable') showText(`${name}: unverifiable scheme ${String(r.scheme)}`, 'danger')
  else showText(`${name}: not for you`, 'neutral')
  void refreshFeed()
})
;(async () => {
  const id = await shell.identity()
  myAuthorKey = id.address // enables the "by you" marker + the Mine filter
  identityEl.textContent = shortAddress(id.address)
  identityEl.setAttribute('title', `${toChecksumAddress(id.address)} — click for Account & Keys`)
  identityEl.setAttribute('data-testid', 'account-open')
  identityEl.setAttribute('role', 'button')
  identityEl.style.cursor = 'pointer'
  identityEl.addEventListener('click', () => void openAccountModal())
  renderSafety(id.keyStorage)
  renderHeader(null)
  await refreshFeed()
  // Anything main opened before this listener existed.
  const pending = await shell.pendingOpen()
  if (pending) await openThing(pending)
})()
