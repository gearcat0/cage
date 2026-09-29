// ── Updates: asked for, never assumed ────────────────────────────────────────
// privacy.md's rule applies to the app's own updates too: nothing touches the
// network unless you asked, and you are told the cost first. So:
//
//   - The background check runs only after the human said yes to it (pref
//     `on`). Until they answer, the pref is `ask` and nothing is checked.
//   - Help → Check for updates… is an explicit ask and always works.
//   - Finding an update downloads nothing. The human sees the version and the
//     notes and decides; only then is the installer fetched.
//   - Installing restarts the app, so that is a separate yes too.
//
// The updater itself (electron-updater) is injected. This file holds only the
// consent and scheduling logic, so it is testable without Electron.

export type UpdatePref = 'ask' | 'on' | 'off'

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** This build cannot update itself (a dev run, or an unsupported package). */
  | { phase: 'inactive' }
  | { phase: 'current'; checkedAt: number }
  | {
      phase: 'available'
      version: string
      notes: string
      /** false: a .deb, which electron-updater could only install unauthenticated
       *  through pkexec/sudo. Those users are sent to the release page instead. */
      canInstall: boolean
    }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

/** The slice of electron-updater's AppUpdater this service uses. */
export interface Updater {
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string; releaseNotes?: unknown } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
}

export interface UpdateServiceOptions {
  /** Built on first use, so the updater module is not even loaded before
   *  someone asks for a check. */
  createUpdater: () => Promise<Updater>
  getPref: () => UpdatePref
  setPref: (p: UpdatePref) => void
  /** Whether a found update can be installed in place (see UpdateState). */
  canInstall: boolean
  onState: (s: UpdateState) => void
  /** Delay before the first background check after start, and between them. */
  firstCheckMs?: number
  intervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_NOTES = 4000

/** Release notes arrive as HTML from the GitHub feed. The chrome is the trusted
 *  surface and never renders remote markup, so they are reduced to text here. */
export function notesText(raw: unknown): string {
  const parts = Array.isArray(raw)
    ? raw.map((n) => (typeof n === 'object' && n !== null ? String((n as { note?: unknown }).note ?? '') : String(n)))
    : [typeof raw === 'string' ? raw : '']
  const text = parts
    .join('\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|div)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES)}…` : text
}

export class UpdateService {
  private state: UpdateState = { phase: 'idle' }
  private updater: Updater | null = null
  private timer: unknown = null
  private readonly o: Required<Omit<UpdateServiceOptions, 'createUpdater' | 'getPref' | 'setPref' | 'onState'>> &
    UpdateServiceOptions

  constructor(opts: UpdateServiceOptions) {
    this.o = {
      firstCheckMs: 30_000,
      intervalMs: DAY_MS,
      now: Date.now,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...opts
    }
  }

  status(): { pref: UpdatePref; state: UpdateState } {
    return { pref: this.o.getPref(), state: this.state }
  }

  /** Begin background checks, if and only if the human turned them on. */
  start(): void {
    this.schedule(this.o.firstCheckMs)
  }

  stop(): void {
    if (this.timer !== null) this.o.clearTimer(this.timer)
    this.timer = null
  }

  setPref(p: UpdatePref): void {
    this.o.setPref(p)
    this.stop()
    // Turning checks on is itself the ask: check now rather than in a day.
    if (p === 'on') void this.check({ manual: false }).finally(() => this.schedule(this.o.intervalMs))
  }

  /** A background check does nothing unless checks are on. A manual one (Help →
   *  Check for updates…) is an explicit ask and always runs. */
  async check({ manual }: { manual: boolean }): Promise<UpdateState> {
    if (!manual && this.o.getPref() !== 'on') return this.state
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') return this.state
    // Already downloaded: nothing new to learn until it is installed.
    if (this.state.phase === 'ready') return this.state
    this.set({ phase: 'checking' })
    try {
      const u = await this.getUpdater()
      const r = await u.checkForUpdates()
      // null: electron-updater declined to run (an unpackaged build with no
      // feed configured). isUpdateAvailable already accounts for staged
      // rollouts and refuses downgrades.
      if (r === null) return this.set({ phase: 'inactive' })
      if (!r.isUpdateAvailable) return this.set({ phase: 'current', checkedAt: this.o.now() })
      return this.set({
        phase: 'available',
        version: r.updateInfo.version,
        notes: notesText(r.updateInfo.releaseNotes),
        canInstall: this.o.canInstall
      })
    } catch (e) {
      return this.set({ phase: 'error', message: (e as Error).message ?? String(e) })
    }
  }

  /** Fetch the installer for the update the human was shown. */
  async download(): Promise<UpdateState> {
    const s = this.state
    if (s.phase !== 'available' || !s.canInstall) return this.state
    const u = await this.getUpdater()
    this.set({ phase: 'downloading', version: s.version, percent: 0 })
    try {
      await u.downloadUpdate()
      return this.set({ phase: 'ready', version: s.version })
    } catch (e) {
      return this.set({ phase: 'error', message: (e as Error).message ?? String(e) })
    }
  }

  /** Restart into the downloaded version. */
  install(): boolean {
    if (this.state.phase !== 'ready' || !this.updater) return false
    this.updater.quitAndInstall(false, true)
    return true
  }

  private async getUpdater(): Promise<Updater> {
    if (this.updater) return this.updater
    const u = await this.o.createUpdater()
    u.on('download-progress', (p) => {
      if (this.state.phase === 'downloading') this.set({ ...this.state, percent: Math.round(p.percent) })
    })
    u.on('error', (e) => {
      // Errors during a check or download are returned by those calls; this
      // catches the rest (e.g. a failed install hand-off) so they are not lost.
      if (this.state.phase !== 'checking' && this.state.phase !== 'downloading') {
        this.set({ phase: 'error', message: e.message })
      }
    })
    this.updater = u
    return u
  }

  private schedule(ms: number): void {
    this.stop()
    if (this.o.getPref() !== 'on') return
    this.timer = this.o.setTimer(() => {
      this.timer = null
      void this.check({ manual: false }).finally(() => this.schedule(this.o.intervalMs))
    }, ms)
  }

  private set(s: UpdateState): UpdateState {
    this.state = s
    this.o.onState(s)
    return s
  }
}
