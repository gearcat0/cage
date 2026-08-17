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
  close(): Promise<void>
  setMode(mode: 'view' | 'edit'): Promise<'view' | 'edit'>
  onModeChanged(cb: (p: { mode: 'view' | 'edit'; preview: boolean; publishable: boolean }) => void): void
  publishDraft(): Promise<Record<string, unknown>>
  copyThing(envelopeHash: string): Promise<Record<string, unknown>>
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
  onFileOpened(cb: (r: Record<string, unknown>) => void): void
  knownTypes(): Promise<KnownTypeEntry[]>
  drafts(): Promise<DraftRow[]>
  newDraft(key: string, args?: unknown): Promise<{ id?: string; type?: string; error?: string }>
  newComment(targetHash: string): Promise<{ id?: string; error?: string }>
  replies(targetHash: string): Promise<{ count: number; rows: ThingRow[] }>
  deleteDraft(id: string): Promise<{ deleted: boolean }>
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
  /** True when this is a local, unsigned draft — the header must NOT claim it
   *  is signed. The renderer never parses ids; this is the discriminant. */
  draft?: boolean
  /** What this thing CLAIMS to reply to (unauthenticated), whether that target
   *  is in this library, and how many things claim to reply to THIS one. */
  replyTo?: string | null
  replyToKnown?: boolean
  replyCount?: number
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
const newBtn = el('button', 'evm-btn evm-btn--primary evm-btn--sm', 'New') as HTMLButtonElement
newBtn.setAttribute('data-testid', 'new-thing')
const fileInput = el('input') as HTMLInputElement
fileInput.type = 'file'
fileInput.style.display = 'none'
const toast = el('span', 'sh-toast')
const keyWarn = el('button', 'evm-badge evm-badge--warning sh-keywarn') as HTMLButtonElement
keyWarn.style.display = 'none'
topbar.append(
  newBtn,
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
        'Delete thing',
        `Delete this ${type} from your library? Its bundle stops being seeded from this machine. Copies already shared are unaffected — a signed thing is public and permanent once shared.`,
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
      `This permanently replaces the identity on this machine. Anything sealed to your current nostr key (${short(id.nostrPubkey)}) becomes PERMANENTLY UNOPENABLE — the new key cannot decrypt it. Things you already authored stay signed by your old address (${shortAddress(id.address)}) and will no longer read as "you". A timestamped backup of the current encrypted key file is kept beside it (identity.key.enc.bak-<time>); restoring that file is the only way back.`,
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
        showText('New identity written — restart the shell to use it', 'success')
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

  async function derive(): Promise<void> {
    seedError.textContent = ''
    const r = await shell.accountAccounts(mnemonicInput.value, shown)
    if (!r.ok) {
      accountList.replaceChildren()
      moreBtn.style.display = 'none'
      useSeedBtn.style.display = 'none'
      seedError.textContent = r.error
      return
    }
    accountList.replaceChildren()
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
    void commit({ mnemonic: mnemonicInput.value, index: Number(picked.value) })
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
  const modal = el('div', 'evm-modal')
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
newBtn.addEventListener('click', () => void openNewMenu())

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

/** This shell's own author key (bare lowercase hex), once identity resolves.
 *  Used ONLY to label rows as yours — the comparison is on the admitted
 *  envelope's author key, so it says what the signature says. */
let myAuthorKey: string | null = null
let feedScope: 'all' | 'mine' = 'all'

/** Is this row signed by the identity currently loaded in this shell? */
function isMine(row: { authorScheme: string; authorKey: string }): boolean {
  return myAuthorKey !== null && row.authorScheme === 'eth-eip191' && row.authorKey === myAuthorKey
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
  const author = mine
    ? el('span', 'sh-feed-author sh-feed-you', 'by you')
    : el(
        'span',
        'sh-feed-author evm-address evm-address--muted',
        row.authorScheme === 'eth-eip191' ? shortAddress(row.authorKey) : short(row.authorKey)
      )
  if (mine) author.setAttribute('data-testid', 'feed-you')
  author.setAttribute('title', `${row.authorScheme}:${row.authorKey}`)
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
  item.append(line1, el('div', 'sh-feed-meta', fmtTime(row.receivedAt)))
  item.addEventListener('click', () => void openThing(row.envelopeHash))
  return item
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
  const query = feedScope === 'mine' && myAuthorKey ? { author: myAuthorKey } : {}
  const [drafts, rows] = await Promise.all([shell.drafts(), shell.feed(query)])
  feedPane.replaceChildren()
  // Drafts are yours by definition and are never published, so the Mine/All
  // scope does not apply to them — they always show.
  if (drafts.length > 0) {
    const title = el('div', 'sh-feed-title', `Drafts · ${drafts.length}`)
    title.setAttribute('data-testid', 'feed-drafts-title')
    feedPane.append(title)
    for (const d of drafts) feedPane.append(draftItem(d))
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

let repliesBadge: HTMLElement | null = null

const replyLabel = (n: number): string => (n === 0 ? 'no comments' : n === 1 ? '1 comment' : `${n} comments`)

/** Things in THIS library that claim to reply to `target`. */
async function openRepliesModal(target: string): Promise<void> {
  const { rows } = await shell.replies(target)
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
      'Things in your library that claim to reply to this. A reply is the commenter’s claim — like a timestamp, nothing binds it to this thing or its author.'
    )
  )
  if (rows.length === 0) body.append(el('div', 'evm-empty', 'Nothing in your library replies to this.'))
  for (const row of rows) {
    const item = el('button', 'sh-feed-item')
    item.setAttribute('data-testid', 'reply-item')
    item.setAttribute('data-envelope-hash', row.envelopeHash)
    const line = el('div', 'sh-feed-line')
    line.append(
      el('span', 'evm-badge evm-badge--neutral', row.type),
      el(
        'span',
        'sh-feed-author evm-address evm-address--muted',
        row.authorScheme === 'eth-eip191' ? shortAddress(row.authorKey) : short(row.authorKey)
      ),
      el('span', 'sh-feed-flags')
    )
    item.append(line, el('div', 'sh-feed-meta', fmtTime(row.receivedAt)))
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

// ── Per-thing trust header ───────────────────────────────────────────────────
function renderHeader(h: HeaderFacts | null): void {
  thingHeader.replaceChildren()
  if (!h) {
    modeButtons = null
    trustBadge = null
    previewBadge = null
    publishBtn = null
    repliesBadge = null
    thingHeader.append(el('span', 'sh-hint', 'Select a thing from the feed.'))
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
    const mine = isMine(h)
    authorEl = mine
      ? el('span', 'sh-feed-you', 'you')
      : el(
          'span',
          'evm-address evm-address--muted',
          h.authorScheme === 'eth-eip191' ? shortAddress(h.authorKey) : `${h.authorScheme}:${short(h.authorKey)}`
        )
    authorEl.setAttribute('data-name', mine ? 'self' : 'unverified')
    if (mine) authorEl.setAttribute('data-testid', 'header-you')
    authorEl.setAttribute('title', `${h.authorScheme}:${h.authorKey}`)
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
    if (outcome.status === 'valid') showText('Copied — your new instance is in the feed', 'success')
    else showText(`Copy failed: ${String(outcome.reason ?? outcome.status)}`, 'danger')
    await refreshFeed()
  })
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
    replyBits.push(commentBtn)

    const count = h.replyCount ?? 0
    repliesBadge = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', replyLabel(count))
    repliesBadge.setAttribute('data-testid', 'header-replies')
    repliesBadge.setAttribute('data-count', String(count))
    repliesBadge.addEventListener('click', () => void openRepliesModal(h.envelopeHash))
    replyBits.push(repliesBadge)
  }
  if (h.replyTo) {
    const known = h.replyToKnown === true
    const rt = el('span', `sh-replyto${known ? ' sh-replyto--known' : ''}`, `in reply to ${short(h.replyTo, 6)}`)
    rt.setAttribute('data-testid', 'header-replyto')
    rt.setAttribute('data-known', known ? '1' : '0')
    rt.title = known
      ? `${h.replyTo} — click to open`
      : `${h.replyTo} — not in your library: you have the reply, not the thing it claims to answer`
    if (known) {
      rt.setAttribute('role', 'button')
      rt.addEventListener('click', () => void openThing(h.replyTo!))
    }
    replyBits.push(rt)
  }

  thingHeader.append(
    statusSlot,
    el('span', 'sh-by', 'by'),
    authorEl,
    typeBadge,
    renderModeToggle(),
    pub,
    el('span', 'sh-spacer'),
    ...replyBits,
    copyBtn,
    delBtn
  )
  // A draft has no envelope, so there is no hash to show.
  if (!h.draft) thingHeader.append(el('span', 'sh-hint', 'hash'), hashEl)
  if (h.isFork) thingHeader.append(el('span', 'evm-badge evm-badge--danger', 'FORK — author history diverged'))
  // Main pushes mode-changed BEFORE shell.open returns, i.e. before these
  // elements existed — apply the cached state to the freshly built controls.
  styleModeButtons()
}

async function openThing(envelopeHash: string): Promise<void> {
  selected = envelopeHash
  const header = await shell.open(envelopeHash)
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
;(window as unknown as { __shellChrome: unknown }).__shellChrome = { openThing }

// ── Boot ─────────────────────────────────────────────────────────────────────
shell.onFeedChanged(() => {
  void refreshFeed()
  // Keep the comment count fresh without rebuilding the header (a rebuild
  // would re-run renderModeToggle and move the pinned controls).
  if (selected && repliesBadge && !selected.startsWith('draft:')) {
    void shell.replies(selected).then((r) => {
      if (!repliesBadge) return
      repliesBadge.textContent = replyLabel(r.count)
      repliesBadge.setAttribute('data-count', String(r.count))
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
    if (o.draftConsumed === true && typeof o.envelopeHash === 'string') void openThing(o.envelopeHash)
  } else showText(`Publish failed: ${String(o.reason ?? o.status)}`, 'danger')
})
shell.onOpenAccount(() => void openAccountModal()) // File → Account & Keys…
// A .thing double-clicked in the file manager: say what became of it, using
// the same wording as any other ingest (it went through the same gate).
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
})()
