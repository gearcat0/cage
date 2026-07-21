import './evm-ui.css'
import './shell.css'

// ── The shell chrome (trusted renderer) ──────────────────────────────────────
// Draws the omnibar, feed, per-thing trust header, and confirm dialogs. Every
// trust signal lives here, in chrome pixels the thing cannot reach (the thing
// renders into a separate native view composited into the main area only).
// Styled with the evm-ui design language (dark, teal accent) via CSS classes.

interface ShellApi {
  identity(): Promise<{ address: string; nostrPubkey: string }>
  feed(query?: unknown): Promise<ThingRow[]>
  ingest(base64: string): Promise<Outcome>
  open(envelopeHash: string): Promise<HeaderFacts>
  close(): Promise<void>
  onFeedChanged(cb: () => void): void
  onConfirmRequest(cb: (req: { id: number; kind: string; summary: Record<string, unknown> }) => void): void
  respondConfirm(id: number, approved: boolean): void
}
interface ThingRow {
  envelopeHash: string
  authorScheme: string
  authorKey: string
  type: string
  receivedAt: number
  created: number
  sealed: boolean
  read: boolean
  isFork: boolean
}
interface HeaderFacts {
  type: string
  authorScheme: string
  authorKey: string
  envelopeHash: string
  sealed: boolean
  isFork: boolean
}
type Outcome =
  | { status: 'valid'; type: string; author?: { k: string } }
  | { status: 'invalid'; reason: string }
  | { status: 'unverifiable'; scheme: string }
  | { status: 'not-for-me' }

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
ingestInput.placeholder = 'paste a base64 bundle…'
ingestInput.setAttribute('aria-label', 'paste bundle')
const ingestBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Ingest') as HTMLButtonElement
const fileBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Open file…') as HTMLButtonElement
const fileInput = el('input') as HTMLInputElement
fileInput.type = 'file'
fileInput.style.display = 'none'
const toast = el('span', 'sh-toast')
topbar.append(
  el('strong', 'sh-brand', 'the shell'),
  el('span', 'sh-spacer'),
  ingestInput,
  ingestBtn,
  fileBtn,
  fileInput,
  toast,
  el('span', 'sh-spacer'),
  el('span', 'sh-id-label', 'you:'),
  identityEl
)

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

async function doIngest(base64: string): Promise<void> {
  if (!base64.trim()) return
  const outcome = await shell.ingest(base64.trim())
  showToast(outcome)
  ingestInput.value = ''
  await refreshFeed()
}
ingestBtn.addEventListener('click', () => void doIngest(ingestInput.value))
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

// ── Feed ─────────────────────────────────────────────────────────────────────
let selected: string | null = null

async function refreshFeed(): Promise<void> {
  const rows = await shell.feed({})
  feedPane.replaceChildren()
  feedPane.append(el('div', 'sh-feed-title', `Feed · ${rows.length}`))
  if (rows.length === 0) {
    feedPane.append(el('div', 'evm-empty', 'No things yet. Ingest a bundle to begin.'))
    return
  }
  for (const row of rows) {
    const item = el('button', 'sh-feed-item')
    if (row.envelopeHash === selected) item.classList.add('sh-feed-item--active')
    const line1 = el('div', 'sh-feed-line')
    line1.append(
      el('span', 'evm-badge evm-badge--neutral', row.type),
      el('span', 'sh-feed-author evm-address evm-address--muted', short(row.authorKey))
    )
    if (row.isFork) line1.append(el('span', 'evm-badge evm-badge--danger', 'FORK'))
    if (row.sealed) line1.append(el('span', 'evm-badge evm-badge--purple', 'sealed'))
    if (!row.read) line1.append(el('span', 'sh-unread', '●'))
    const line2 = el('div', 'sh-feed-meta', fmtTime(row.receivedAt))
    item.append(line1, line2)
    item.addEventListener('click', () => void openThing(row.envelopeHash))
    feedPane.append(item)
  }
}

// ── Per-thing trust header ───────────────────────────────────────────────────
function renderHeader(h: HeaderFacts | null): void {
  thingHeader.replaceChildren()
  if (!h) {
    thingHeader.append(el('span', 'sh-hint', 'Select a thing from the feed.'))
    return
  }
  // Signature status: everything in the library is admission-`valid`, so a
  // mounted thing is signed-and-verified. The badge uses the DS success token —
  // this is the trust signal the thing must never be able to forge.
  const badge = el('span', 'evm-badge evm-badge--success sh-verified', '✓ signed')
  badge.setAttribute('data-trust', 'verified')
  const author = el('span', 'evm-address', `${h.authorScheme}:${short(h.authorKey)}`)
  const typeBadge = el('span', 'evm-badge evm-badge--neutral', h.type)
  const hashEl = el('span', 'sh-hash evm-address evm-address--muted', short(h.envelopeHash, 8))
  thingHeader.append(badge, el('span', 'sh-by', 'by'), author, typeBadge, el('span', 'sh-spacer'), el('span', 'sh-hint', 'hash'), hashEl)
  if (h.isFork) thingHeader.append(el('span', 'evm-badge evm-badge--danger', 'FORK — author history diverged'))
}

async function openThing(envelopeHash: string): Promise<void> {
  selected = envelopeHash
  const header = await shell.open(envelopeHash)
  renderHeader(header)
  await refreshFeed()
}

// ── Confirm flow (a thing requests; the human decides, in chrome) ────────────
shell.onConfirmRequest((req) => {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', `A thing wants to ${req.kind}`))
  const body = el('div', 'evm-modal-body')
  body.append(el('p', 'sh-hint', 'This request grants nothing until you approve it here.'))
  const pre = el('pre', 'sh-draft') as HTMLPreElement
  pre.textContent = JSON.stringify(req.summary, null, 2)
  body.append(pre)
  const footer = el('div', 'evm-modal-footer')
  const cancel = el('button', 'evm-btn evm-btn--ghost', 'Reject')
  const ok = el('button', 'evm-btn evm-btn--primary', `Approve ${req.kind}`)
  const closeModal = (approved: boolean): void => {
    shell.respondConfirm(req.id, approved)
    overlay.remove()
  }
  cancel.addEventListener('click', () => closeModal(false))
  ok.addEventListener('click', () => closeModal(true))
  footer.append(cancel, ok)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(overlay)
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// Test hook: let the N6 pixel test drive a real open (renders the trust header)
// without simulating a click. Harmless in the trusted chrome.
;(window as unknown as { __shellChrome: unknown }).__shellChrome = { openThing }

// ── Boot ─────────────────────────────────────────────────────────────────────
shell.onFeedChanged(() => void refreshFeed())
;(async () => {
  const id = await shell.identity()
  identityEl.textContent = `${short(id.address)}`
  identityEl.setAttribute('title', id.address)
  renderHeader(null)
  await refreshFeed()
})()
