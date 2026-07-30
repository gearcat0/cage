import './evm-ui.css'
import './shell.css'

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
  close(): Promise<void>
  setMode(mode: 'view' | 'edit'): Promise<'view' | 'edit'>
  onModeChanged(cb: (p: { mode: 'view' | 'edit'; preview: boolean; publishable: boolean }) => void): void
  publishDraft(): Promise<Record<string, unknown>>
  copyThing(envelopeHash: string): Promise<Record<string, unknown>>
  deleteThing(envelopeHash: string): Promise<{ deleted: boolean }>
  overlay(delta: 1 | -1): void
  onFeedChanged(cb: () => void): void
  onConfirmRequest(cb: (req: { id: number; kind: string; summary: Record<string, unknown> }) => void): void
  respondConfirm(id: number, approved: boolean): void
  onPublishResult(cb: (outcome: Record<string, unknown>) => void): void
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
  /** Verified primary name for the author, or null if none confirmed. */
  name?: string | null
  nameStatus?: 'verified' | 'mismatch' | 'unresolvable'
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
ingestInput.placeholder = 'paste a base64 bundle, or a locator (magnet:/bundle:/file:)…'
ingestInput.setAttribute('aria-label', 'paste bundle or locator')
const ingestBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Ingest') as HTMLButtonElement
const fileBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Open file…') as HTMLButtonElement
const createBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Create…') as HTMLButtonElement
const fileInput = el('input') as HTMLInputElement
fileInput.type = 'file'
fileInput.style.display = 'none'
const toast = el('span', 'sh-toast')
const keyWarn = el('button', 'evm-badge evm-badge--warning sh-keywarn') as HTMLButtonElement
keyWarn.style.display = 'none'
topbar.append(
  el('strong', 'sh-brand', 'the shell'),
  el('span', 'sh-spacer'),
  createBtn,
  ingestInput,
  ingestBtn,
  fileBtn,
  fileInput,
  toast,
  el('span', 'sh-spacer'),
  keyWarn,
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

// A locator (magnet:/bundle:/file:/thing:) or a name (alice.eth, user@host) is
// fetched (naming/transport → admission); anything else is a pasted base64
// bundle ingested directly.
const FETCHABLE_RE = /^(magnet|bundle|file|thing):|^[a-z0-9-]+(\.[a-z0-9-]+)+$|^[^@\s]+@[^@\s]+$/i

async function doIngest(input: string): Promise<void> {
  const text = input.trim()
  if (!text) return
  const outcome = FETCHABLE_RE.test(text) ? await shell.fetch(text) : await shell.ingest(text)
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
function trackOverlay(overlay: HTMLElement): HTMLElement {
  shell.overlay(1)
  const origRemove = overlay.remove.bind(overlay)
  let closed = false
  overlay.remove = () => {
    if (!closed) {
      closed = true
      shell.overlay(-1)
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
    document.body.append(trackOverlay(overlay))
  })
}

/** Delete via either the header button or a feed row: confirm, delete, and
 *  clear the header if the deleted thing was the open one. */
async function deleteWithConfirm(envelopeHash: string, type: string): Promise<void> {
  const ok = await confirmDanger(
    'Delete thing',
    `Delete this ${type} from your library? Its bundle stops being seeded from this machine. Copies already shared are unaffected — a signed thing is public and permanent once shared.`,
    'Delete'
  )
  if (!ok) return
  await shell.deleteThing(envelopeHash)
  if (selected === envelopeHash) {
    selected = null
    renderHeader(null)
  }
  showText('Deleted from your library', 'neutral')
  await refreshFeed()
}

function openComposeModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Create a thing'))
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
createBtn.addEventListener('click', openComposeModal)

// ── Safety notice (experimental alpha + real key custody) ────────────────────
function safetyModal(keyStorage: 'os' | 'software'): void {
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
      'Do not use this identity for anything valuable, and do not put anything in a thing that you could not bear to leak — a signed thing is public and permanent once shared.'
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
  })
  footer.append(ok)
  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

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
  if (!acked) safetyModal(keyStorage)
}

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
    // Per-row delete — usable WITHOUT opening the thing (you may not want to
    // mount something before removing it). A span, not a button: the row
    // itself is a button and buttons must not nest.
    const del = el('span', 'sh-feed-del', '×')
    del.title = 'Delete from library'
    del.setAttribute('role', 'button')
    del.setAttribute('data-testid', 'feed-delete')
    del.addEventListener('click', (e) => {
      e.stopPropagation()
      void deleteWithConfirm(row.envelopeHash, row.type)
    })
    line1.append(el('span', 'sh-feed-flex'), del)
    const line2 = el('div', 'sh-feed-meta', fmtTime(row.receivedAt))
    item.append(line1, line2)
    item.addEventListener('click', () => void openThing(row.envelopeHash))
    feedPane.append(item)
  }
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
      : 'Nothing to publish yet — edit the thing first (the program streams its state as you edit)'
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

// ── Per-thing trust header ───────────────────────────────────────────────────
function renderHeader(h: HeaderFacts | null): void {
  thingHeader.replaceChildren()
  if (!h) {
    modeButtons = null
    trustBadge = null
    previewBadge = null
    publishBtn = null
    thingHeader.append(el('span', 'sh-hint', 'Select a thing from the feed.'))
    return
  }
  // Signature status: everything in the library is admission-`valid`, so a
  // mounted thing is signed-and-verified. The badge uses the DS success token —
  // this is the trust signal the thing must never be able to forge.
  const badge = el('span', 'evm-badge evm-badge--success sh-verified', '✓ signed')
  badge.setAttribute('data-trust', 'verified')
  trustBadge = badge
  // Hidden until view mode shows an unpublished-draft preview (see
  // styleModeButtons) — then it REPLACES the trust badge.
  previewBadge = el('span', 'evm-badge evm-badge--warning', 'PREVIEW — unpublished draft')
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
    authorEl = el('span', 'evm-address evm-address--muted', `${h.authorScheme}:${short(h.authorKey)}`)
    authorEl.setAttribute('data-name', 'unverified')
  }
  const typeBadge = el('span', 'evm-badge evm-badge--neutral', h.type)
  const hashEl = el('span', 'sh-hash evm-address evm-address--muted', short(h.envelopeHash, 8))
  // Copy: the shell-level "edit this object" primitive — things are immutable,
  // so editing starts by making your own instance with the same program+args.
  const copyBtn = el('button', 'evm-btn evm-btn--secondary evm-btn--sm', 'Copy')
  copyBtn.setAttribute('data-testid', 'header-copy')
  copyBtn.addEventListener('click', async () => {
    const outcome = await shell.copyThing(h.envelopeHash)
    if (outcome.status === 'valid') showText('Copied — your new instance is in the feed', 'success')
    else showText(`Copy failed: ${String(outcome.reason ?? outcome.status)}`, 'danger')
    await refreshFeed()
  })
  const delBtn = el('button', 'evm-btn evm-btn--danger evm-btn--sm', 'Delete')
  delBtn.setAttribute('data-testid', 'header-delete')
  delBtn.addEventListener('click', () => void deleteWithConfirm(h.envelopeHash, h.type))
  // Publish: signs the LATEST streamed draft — exactly what the preview shows.
  // Disabled until the program streams one (see styleModeButtons).
  const pub = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'Publish') as HTMLButtonElement
  pub.setAttribute('data-testid', 'header-publish')
  pub.addEventListener('click', async () => {
    const r = await shell.publishDraft()
    if (r.status === 'invalid') showText(String(r.reason), 'danger')
  })
  publishBtn = pub
  thingHeader.append(
    statusSlot,
    el('span', 'sh-by', 'by'),
    authorEl,
    typeBadge,
    renderModeToggle(),
    pub,
    el('span', 'sh-spacer'),
    copyBtn,
    delBtn,
    el('span', 'sh-hint', 'hash'),
    hashEl
  )
  if (h.isFork) thingHeader.append(el('span', 'evm-badge evm-badge--danger', 'FORK — author history diverged'))
  // Main pushes mode-changed BEFORE shell.open returns, i.e. before these
  // elements existed — apply the cached state to the freshly built controls.
  styleModeButtons()
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
  // 'publish' is user-initiated (the chrome Publish button signing the
  // previewed draft); anything else would be a thing's own request.
  const title = req.kind === 'publish' ? 'Publish a new instance?' : `A thing wants to ${req.kind}`
  header.append(el('span', 'evm-modal-title', title))
  const body = el('div', 'evm-modal-body')
  body.append(
    el(
      'p',
      'sh-hint',
      req.kind === 'publish'
        ? 'This signs the previewed draft with your identity as a new thing in your feed. Nothing happens until you approve it here.'
        : 'This request grants nothing until you approve it here.'
    )
  )
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
  document.body.append(trackOverlay(overlay))
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
shell.onModeChanged((p) => {
  currentMode = p.mode
  previewActive = p.preview
  publishable = p.publishable
  styleModeButtons()
})
shell.onPublishResult((o) => {
  if (o.status === 'valid') showText('Published to your feed', 'success')
  else showText(`Publish failed: ${String(o.reason ?? o.status)}`, 'danger')
})
;(async () => {
  const id = await shell.identity()
  identityEl.textContent = `${short(id.address)}`
  identityEl.setAttribute('title', id.address)
  renderSafety(id.keyStorage)
  renderHeader(null)
  await refreshFeed()
})()
