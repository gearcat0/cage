import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell, hash, type ShellHandle } from './helpers.js'

// ── Draft attachments persist ────────────────────────────────────────────────
// A draft used to hold its images only in main-process memory: they vanished on
// restart AND on opening anything else, and {carry:true} always threw — so a
// program had to re-ship every image byte on every keystroke. These pin the
// fixed behaviour, including the garbage-collection rules, which are the sharp
// edge (a mistake there deletes a user's picked image with no recovery).

const PNG = readFileSync(join(__dirname, '..', 'fixtures', 'poster.png'))
const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const PNG_HASH = toHex(hash(new Uint8Array(PNG)))
const POSTER = readFileSync(join(__dirname, '..', '..', 'samples', 'poster.html'))

// Shared by the tests that do not need their own profile: fewer Electron
// launches, because a starved app is where this suite's flakes come from.
let shared: ShellHandle
test.beforeAll(async () => {
  shared = await launchShell()
})
test.afterAll(async () => {
  await shared?.close()
})

type ModeState = {
  activeMode: 'view' | 'edit'
  viewWcId: number | null
  editWcId: number | null
  previewWcId: number | null
} | null

const modeState = (shell: ShellHandle): Promise<ModeState> =>
  shell.app.evaluate(
    async (electron) =>
      (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState() as never
  )

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value: T | undefined
    try {
      value = await fn()
      if (pred(value)) return value
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`poll timed out; last value: ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

/** Hand image bytes to the shell exactly as the program's own file-pick would. */
async function streamImage(shell: ShellHandle, title = 'Held'): Promise<void> {
  await shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => { editWcId: number | null } | null } })
        .__shell.modeState()
      const wc = electron.webContents.fromId(s!.editWcId!)
      await wc!.executeJavaScript(`
        window.bridge.emit('draft', {
          type: 'poster',
          args: { title: ${JSON.stringify(a.title)}, caption: 'held across mounts' },
          blobs: { image: { bytes: Uint8Array.from(${JSON.stringify(a.png)}), mime: 'image/png' } }
        })
      `)
    },
    { png: Array.from(PNG), title }
  )
}

const imageRenders = (shell: ShellHandle, which: 'edit' | 'view'): Promise<boolean> =>
  shell.app.evaluate(
    async (electron, w) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const id = w === 'edit' ? s?.editWcId : s?.viewWcId
      if (id == null) throw new Error('no cage')
      const wc = electron.webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error('cage gone')
      // The picture, in whichever mode: view composes tiles (the first keeps
      // the id `poster-image`), edit shows a per-photo thumbnail. This test is
      // about the draft's BYTES surviving, not about the poster's markup.
      return (await wc.executeJavaScript(
        `(() => {
          const i = document.querySelector('#poster-image, #photo-thumb-0')
          return !!i && i.complete && i.naturalWidth > 0
        })()`
      )) as never
    },
    which
  )

/** New → Poster, in edit mode, with the image streamed and persisted. */
async function draftWithImage(shell: ShellHandle): Promise<string> {
  const types = await shell.knownTypes()
  const poster = types.find((t) => t.testKey === 'starter-poster')!
  const created = await shell.newDraft(poster.key)
  await shell.openThing(created.id!)
  await poll(() => modeState(shell), (s) => s?.activeMode === 'edit' && s.editWcId !== null)
  await streamImage(shell)
  await poll(() => shell.draftBlobs(created.id!), (b) => b.length === 1 && b[0]!.name === 'image')
  return created.id!
}

test('a draft keeps its image across opening something else', async () => {
  const shell = shared
  {
    const draftId = await draftWithImage(shell)
    const blobs = await shell.draftBlobs(draftId)
    expect(blobs[0]!.hash).toBe(PNG_HASH)
    expect(blobs[0]!.mime).toBe('image/png') // wrong mime = broken <img> under nosniff

    // Open something else (destroys the cages), then come back.
    const { outcome } = await shell.compose(POSTER.toString('base64'), 'poster')
    await shell.openThing(outcome.envelopeHash as string)
    await shell.openThing(draftId)
    await poll(() => modeState(shell), (s) => s?.activeMode === 'edit' && s.editWcId !== null)

    // The program sees the attachment and it actually renders.
    const atts = (await shell.app.evaluate(async (electron) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const wc = electron.webContents.fromId(s!.editWcId!)
      return (await wc!.executeJavaScript(
        `window.bridge.getArgs().attachments.map(function (a) { return a.name })`
      )) as never
    })) as string[]
    expect(atts).toEqual(['image'])
    expect(await poll(() => imageRenders(shell, 'edit'), (v) => v)).toBe(true)
  }
})

test('a draft image survives a restart, and {carry:true} then publishes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-draftblob-'))
  try {
    const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    const draftId = await draftWithImage(first)
    await first.app.close() // keep the dir

    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      expect((await shell.draftBlobs(draftId))[0]!.hash).toBe(PNG_HASH)
      await shell.openThing(draftId)
      await poll(() => modeState(shell), (s) => s?.activeMode === 'edit' && s.editWcId !== null)
      expect(await poll(() => imageRenders(shell, 'edit'), (v) => v)).toBe(true)

      // The poster program now emits {carry:true} (it sees the attachment and
      // has no fresh pick) — the case that used to throw on every draft.
      const pending = (await shell.app.evaluate(async (electron) => {
        const s = (electron.app as unknown as { __shell: { publishDraft: () => Record<string, unknown> } }).__shell
        return s.publishDraft() as never
      })) as Record<string, unknown>
      expect(pending.status, 'carry must resolve — this used to throw for drafts').toBe('pending')
      await shell.app.evaluate(async (electron) => {
        const wc = electron.webContents
          .getAllWebContents()
          .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
        await wc!.executeJavaScript(`document.querySelector('[data-testid=confirm-approve]').click()`)
      })
      const published = await poll(
        () =>
          shell.app.evaluate(async (electron) => {
            const s = (electron.app as unknown as { __shell: { lastPublish: Record<string, unknown> | null } }).__shell
            return s.lastPublish as never
          }) as Promise<Record<string, unknown> | null>,
        (p) => p?.status === 'valid'
      )
      expect(published!.attachments).toEqual(['image'])
      // Publishing consumed the draft but kept the bytes: the new thing owns them.
      expect(await shell.drafts()).toEqual([])
      expect(shell.casBlobs()).toContain(PNG_HASH)
    } finally {
      await shell.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discarding a draft releases its image — unless another draft holds it', async () => {
  const shell = shared
  {
    // This test is about global blob state, so start from a stated clean
    // slate rather than assuming what earlier tests left behind.
    for (const d of await shell.drafts()) await shell.deleteDraft(d.id)
    expect(shell.casBlobs(), 'no draft should be holding the image yet').not.toContain(PNG_HASH)

    const a = await draftWithImage(shell)
    expect(shell.casBlobs()).toContain(PNG_HASH)

    // A second draft holding the SAME bytes protects them.
    const types = await shell.knownTypes()
    const poster = types.find((t) => t.testKey === 'starter-poster')!
    const b = (await shell.newDraft(poster.key)).id!
    await shell.openThing(b)
    await poll(() => modeState(shell), (s) => s?.activeMode === 'edit' && s.editWcId !== null)
    await streamImage(shell, 'Second holder')
    await poll(() => shell.draftBlobs(b), (rows) => rows.length === 1)

    await shell.deleteDraft(a)
    expect(await shell.draftBlobs(a)).toEqual([])
    expect(shell.casBlobs(), 'draft B still holds the bytes').toContain(PNG_HASH)

    await shell.deleteDraft(b)
    expect(shell.casBlobs(), 'last holder gone: the bytes go too').not.toContain(PNG_HASH)
  }
})
