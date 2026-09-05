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
  exportThing(envelopeHash: string): Promise<{ path: string | null; error?: string }>
  exportBase64(envelopeHash: string): Promise<{ base64?: string; bytes?: number; error?: string }>
  seedStart(envelopeHash: string): Promise<{ magnet?: string; error?: string }>
  seedStop(envelopeHash: string): Promise<{ stopped: boolean }>
  seedStatus(): Promise<{ envelopeHash: string; magnet: string; peers: number; bytes: number; type: string }[]>
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
  /** How far the author sits from you through your own vouches, or null for
   *  outside your tribe (and for a draft, which nobody has signed). */
  authorHops?: number | null
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
  copyNote.textContent = 'As text, for pasting into another shell’s Ingest box.'
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
    'Seeding announces this to the BitTorrent DHT: anyone with the link learns the address of whoever is serving it. A sealed thing stays encrypted, but that you hold it does not.'

  const paintSeed = (magnet: string | null): void => {
    magnetSlot.replaceChildren()
    if (magnet) {
      seedBtn.textContent = 'Stop seeding'
      seedNote.textContent = 'Being served to peers. The link works while this shell is running.'
      magnetSlot.append(copyField('magnet link', magnet, 'share-magnet'))
    } else {
      seedBtn.textContent = 'Seed over BitTorrent'
      seedNote.textContent = 'Off. Nothing about this thing is announced.'
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
  body.append(copyRow, saveRow, warn, seedRow, magnetSlot)

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'share-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
}

/** Everything this shell is currently announcing to the network, in one place.
 *
 *  The convenience — stop one, copy its link — matters less than the question
 *  it answers: what am I exposing right now? That should be answerable without
 *  opening each thing in turn. */
function openSharingModal(): void {
  const overlay = el('div', 'evm-modal-overlay')
  const modal = el('div', 'evm-modal sh-sharing')
  modal.setAttribute('data-testid', 'sharing-modal')
  const header = el('div', 'evm-modal-header')
  header.append(el('span', 'evm-modal-title', 'Sharing'))
  const body = el('div', 'evm-modal-body')
  const list = el('div', 'sh-sharing-list')
  list.setAttribute('data-testid', 'sharing-list')
  body.append(
    el('p', 'sh-hint', 'Things this shell is serving to peers. Each one announces to the BitTorrent DHT while it runs — anyone with the link learns the address serving it.'),
    list
  )

  const paint = async (): Promise<void> => {
    const rows = await shell.seedStatus().catch(() => [])
    list.replaceChildren()
    list.setAttribute('data-count', String(rows.length))
    if (rows.length === 0) {
      const none = el('p', 'sh-hint', 'Nothing is being shared.')
      none.setAttribute('data-testid', 'sharing-empty')
      list.append(none)
      return
    }
    for (const r of rows) {
      const row = el('div', 'sh-sharing-row')
      row.setAttribute('data-envelope-hash', r.envelopeHash)
      const head = el('div', 'sh-sharing-head')
      head.append(el('span', 'evm-badge evm-badge--neutral', r.type))
      head.append(el('span', 'sh-hash evm-address evm-address--muted', short(r.envelopeHash, 8)))
      // Peers is the honest measure of whether sharing is doing anything.
      head.append(el('span', 'sh-hint', r.peers === 1 ? '1 peer' : `${r.peers} peers`))
      const stop = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', 'Stop')
      stop.setAttribute('data-testid', 'sharing-stop')
      stop.addEventListener('click', async () => {
        await shell.seedStop(r.envelopeHash)
        await paint()
      })
      head.append(stop)
      row.append(head, copyField('magnet link', r.magnet, `sharing-magnet-${r.envelopeHash.slice(0, 8)}`))
      list.append(row)
    }
  }

  const footer = el('div', 'evm-modal-footer')
  const close = el('button', 'evm-btn evm-btn--ghost', 'Close')
  close.setAttribute('data-testid', 'sharing-close')
  close.addEventListener('click', () => overlay.remove())
  footer.append(close)

  modal.append(header, body, footer)
  overlay.append(modal)
  document.body.append(trackOverlay(overlay))
  void paint()
}

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
    el('p', 'sh-hint', 'Your name for this key, kept on this machine. It never enters a thing and nobody else sees it — which is exactly why it is worth something: they cannot choose it.')
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
    el('p', 'sh-hint', 'Every key whose things you hold. A name here is yours alone — it stays on this machine, and says you recognise the key, not that you trust it.'),
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
      const count = el('span', 'sh-hint', r.things === 1 ? '1 thing' : `${r.things} things`)
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
      'Things in your library that put a signature behind a statement about this. Each signature proves who said it — not that it is true, and not that this thing’s author agreed.'
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
        authorLabel(row).text
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
    if (outcome.status === 'valid') showText('Copied — your new instance is in the feed', 'success')
    else showText(`Copy failed: ${String(outcome.reason ?? outcome.status)}`, 'danger')
    await refreshFeed()
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
    replyBits.push(attestBtn)

    const attests = h.attestCount ?? 0
    attestBadge = el('button', 'evm-btn evm-btn--ghost evm-btn--sm', attestLabel(attests))
    attestBadge.setAttribute('data-testid', 'header-attestations')
    attestBadge.setAttribute('data-count', String(attests))
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
      : `${h.replyTo} — not in your library: you have the reply, not the thing it claims to answer`
    if (known) {
      rt.setAttribute('role', 'button')
      rt.addEventListener('click', () => void openThing(h.replyTo!))
    }
    replyBits.push(rt)
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
      ? `${h.vouchAboutScheme}:${h.vouchAbout} — you hold things by this key`
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
      : `${h.attests} — not in your library: you have the attestation, not the thing it speaks about`
    if (known) {
      at.setAttribute('role', 'button')
      at.addEventListener('click', () => void openThing(h.attests!))
    }
    replyBits.push(at)
  }

  // Where the author sits relative to you. Shown only when they are actually
  // reachable from your own vouches -- absence is the normal case and needs no
  // badge, and a "0" would read as a score, which this is not.
  const seatBits: HTMLElement[] = []
  if (typeof h.authorHops === 'number') {
    const seat = el('span', 'evm-badge evm-badge--neutral sh-tribe-badge', tribeSeat(h.authorHops))
    seat.setAttribute('data-testid', 'header-tribe')
    seat.setAttribute('data-hops', String(h.authorHops))
    seat.title =
      h.authorHops === 1
        ? 'You have vouched for this key. That records that you know them — nothing about this thing.'
        : 'Reached through someone you vouched for. It says how you know of them, not that they are honest.'
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
    copyBtn,
    exportBtn,
    delBtn
  )
  // A draft has no envelope, so there is no hash to show.
  if (!h.draft) thingHeader.append(el('span', 'sh-hint', 'hash'), hashEl)
  if (h.isFork) thingHeader.append(el('span', 'evm-badge evm-badge--danger', 'FORK — author history diverged'))
  // Main pushes mode-changed BEFORE shell.open returns, i.e. before these
  // elements existed — apply the cached state to the freshly built controls.
  styleModeButtons()
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
;(window as unknown as { __shellChrome: unknown }).__shellChrome = { openThing, openPeople: openPeopleModal }

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
    if (o.draftConsumed === true && typeof o.envelopeHash === 'string') void openThing(o.envelopeHash)
  } else showText(`Publish failed: ${String(o.reason ?? o.status)}`, 'danger')
})
shell.onOpenSharing(() => openSharingModal())
shell.onOpenPeople(() => openPeopleModal())
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
