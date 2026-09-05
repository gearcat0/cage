import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, hash, type ShellHandle } from './helpers.js'

// ── New → type → draft → publish ─────────────────────────────────────────────
// "New" offers built-in starters plus programs already in the library; picking
// one starts a LOCAL UNSIGNED draft that autosaves, survives restart, shows in
// its own feed section, and is consumed when published.

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const sampleHash = (type: string): string =>
  toHex(hash(new Uint8Array(readFileSync(join(__dirname, '..', '..', 'samples', `${type}.html`)))))

type ModeState = {
  activeMode: 'view' | 'edit'
  viewWcId: number | null
  editWcId: number | null
  previewWcId: number | null
} | null

async function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

const modeState = (shell: ShellHandle): Promise<ModeState> =>
  shell.app.evaluate(
    async (electron) =>
      (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState() as never
  )

async function editEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
    if (s?.editWcId == null) throw new Error('no edit cage')
    const wc = electron.webContents.fromId(s.editWcId)
    if (!wc || wc.isDestroyed()) throw new Error('edit cage gone')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

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

const click = (shell: ShellHandle, testid: string): Promise<void> =>
  chromeEval(shell, `document.querySelector('[data-testid=${testid}]').click()`)

const exists = (shell: ShellHandle, testid: string): Promise<boolean> =>
  chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=${testid}]')`)

/** Open New and pick a starter; resolves when the draft is mounted in edit. */
async function newFromStarter(shell: ShellHandle, type: string): Promise<void> {
  await click(shell, 'new-thing')
  await poll(() => exists(shell, 'new-menu'), (v) => v)
  await click(shell, `new-type-starter-${type}`)
  await poll(() => modeState(shell), (s) => s?.activeMode === 'edit' && s.editWcId !== null)
}

test('the built app ships the starter programs', async () => {
  const shell = await launchShell()
  try {
    // Runs against the BUILT bundle (out/main/shell/main.js) — this is the
    // packaging proof that ?raw inlining really shipped the samples.
    const types = await shell.knownTypes()
    const starters = types.filter((t) => t.source === 'starter')
    expect(starters.map((s) => s.type)).toEqual([
      'nametag',
      'card',
      'memo',
      'invite',
      'todo',
      'article',
      'comment',
      'attestation',
      'contract',
      'vouch',
      'poster'
    ])
    for (const s of starters) expect(s.progHash).toBe(sampleHash(s.type))
  } finally {
    await shell.close()
  }
})

test('New lists the types and offers New from HTML', async () => {
  const shell = await launchShell()
  try {
    await click(shell, 'new-thing')
    await poll(() => exists(shell, 'new-menu'), (v) => v)
    expect(await chromeEval<number>(shell, `document.querySelectorAll('.sh-new-type').length`)).toBeGreaterThanOrEqual(6)
    expect(await exists(shell, 'new-type-starter-nametag')).toBe(true)
    // The escape hatch is still there, and it opens the compose modal.
    await click(shell, 'new-from-html')
    await poll(() => exists(shell, 'new-menu'), (present) => !present)
    expect(await chromeEval<boolean>(shell, `!!document.querySelector('.sh-compose-row')`)).toBe(true)
  } finally {
    await shell.close()
  }
})

test('picking a type creates an unsigned draft that opens in edit mode', async () => {
  const shell = await launchShell()
  try {
    expect((await shell.drafts()).length).toBe(0)
    await newFromStarter(shell, 'nametag')

    const drafts = await shell.drafts()
    expect(drafts.length).toBe(1)
    expect(drafts[0]!.type).toBe('nametag')
    expect(drafts[0]!.progHash).toBe(sampleHash('nametag'))
    // Nothing was signed: the feed itself is still empty.
    expect((await shell.feed()).length).toBe(0)

    // The header must NOT claim this is signed.
    expect(await exists(shell, 'header-draft-badge')).toBe(true)
    expect(await chromeEval<boolean>(shell, `!!document.querySelector('[data-trust=verified]')`)).toBe(false)
    expect(await chromeEval<string>(shell, `document.querySelector('[data-trust=draft]').textContent`)).toContain('DRAFT')
    // And it shows in its own feed section.
    expect(await exists(shell, 'feed-drafts-title')).toBe(true)
    expect(await chromeEval<number>(shell, `document.querySelectorAll('[data-testid=draft-item]').length`)).toBe(1)
  } finally {
    await shell.close()
  }
})

test('draft edits autosave and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-drafts-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    await newFromStarter(shell, 'nametag')
    await poll(() => editEval<boolean>(shell, `!!document.getElementById('name')`), (v) => v)
    await editEval(
      shell,
      `(() => {
        const i = document.getElementById('name')
        i.value = 'Autosaved'
        i.dispatchEvent(new Event('input'))
      })()`
    )
    // The draft row picks up the typed args (debounced).
    const saved = await poll(
      () => shell.drafts(),
      (d) => (d[0]?.args as { name?: string } | null)?.name === 'Autosaved'
    )
    expect(saved[0]!.updated).toBeGreaterThanOrEqual(saved[0]!.created)
    const draftId = saved[0]!.id
    await shell.app.close() // keep the dir

    // Restart: the draft is still there, with the work in it.
    const next = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    try {
      const after = await next.drafts()
      expect(after.length).toBe(1)
      expect(after[0]!.id).toBe(draftId)
      expect((after[0]!.args as { name: string }).name).toBe('Autosaved')
      // Reopening lands in edit mode with the text still in the field.
      await next.openThing(draftId)
      await poll(() => modeState(next), (s) => s?.activeMode === 'edit' && s.editWcId !== null)
      expect(await poll(() => editEval<string>(next, `document.getElementById('name').value`), (v) => v === 'Autosaved')).toBe(
        'Autosaved'
      )
    } finally {
      await next.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('publishing consumes the draft and lands on the signed instance', async () => {
  const shell = await launchShell()
  try {
    await newFromStarter(shell, 'nametag')
    await poll(() => editEval<boolean>(shell, `!!document.getElementById('name')`), (v) => v)
    await editEval(
      shell,
      `(() => {
        const i = document.getElementById('name')
        i.value = 'Published Once'
        i.dispatchEvent(new Event('input'))
      })()`
    )
    await poll(() => exists(shell, 'header-publish'), (v) => v)
    await poll(
      () => chromeEval<boolean>(shell, `!document.querySelector('[data-testid=header-publish]').disabled`),
      (v) => v
    )
    await click(shell, 'header-publish')
    await poll(() => exists(shell, 'confirm-approve'), (v) => v)
    await click(shell, 'confirm-approve')

    // The draft is gone; a signed nametag took its place.
    await poll(() => shell.drafts(), (d) => d.length === 0)
    const rows = await poll(
      async () => (await shell.feed()) as { type: string; progHash: string; envelopeHash: string }[],
      (f) => f.length === 1
    )
    expect(rows[0]!.type).toBe('nametag')
    expect(rows[0]!.progHash).toBe(sampleHash('nametag'))
    // The chrome followed the publish onto the real thing — genuinely signed.
    await poll(() => chromeEval<boolean>(shell, `!!document.querySelector('[data-trust=verified]')`), (v) => v)
    expect(await exists(shell, 'header-draft-badge')).toBe(false)
    expect(await chromeEval<number>(shell, `document.querySelectorAll('[data-testid=draft-item]').length`)).toBe(0)
  } finally {
    await shell.close()
  }
})

test('a draft keeps its program alive; discarding it releases the blob', async () => {
  const shell = await launchShell()
  try {
    // A thing from someone else, carrying a program the shell does NOT ship
    // (a starter-identical program would dedupe into the starter entry).
    const program = new TextEncoder().encode(
      `<!doctype html><title>ticket</title><body><div id="app"></div><script>
        var a = window.bridge.getArgs() || {}
        document.getElementById('app').textContent = String((a.args && a.args.seat) || '—')
        if (a.mode === 'edit') window.bridge.emit('draft', { type: 'ticket', args: { seat: '' } })
      <\/script></body>`
    )
    const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type: 'ticket', program })
    const r = await shell.ingest(bundle)
    expect(r.status).toBe('valid')
    const progHash = toHex(hash(program))
    expect(shell.casBlobs()).toContain(progHash)

    // That library type is offered by New, and a draft of it shares the blob.
    const libEntry = (await shell.knownTypes()).find((t) => t.source === 'library' && t.progHash === progHash)
    expect(libEntry, 'the ingested ticket type should be creatable').toBeTruthy()
    expect(libEntry!.type).toBe('ticket')
    const created = await shell.newDraft(libEntry!.key)
    expect(created.id).toBeTruthy()

    // Deleting the THING must not GC a blob the draft still needs.
    await shell.app.evaluate(async (electron, h) => {
      const s = (electron.app as unknown as { __shell: { deleteThing: (x: string) => unknown } }).__shell
      s.deleteThing(h)
    }, r.envelopeHash as string)
    expect((await shell.feed()).length).toBe(0)
    expect(shell.casBlobs(), 'the draft holds the last reference').toContain(progHash)
    // The draft still opens (its program is readable).
    const opened = (await shell.openThing(created.id!)) as Record<string, unknown>
    expect(opened.error).toBeUndefined()
    expect(opened.draft).toBe(true)

    // Discarding the draft releases it.
    await shell.deleteDraft(created.id!)
    expect((await shell.drafts()).length).toBe(0)
    expect(shell.casBlobs()).not.toContain(progHash)
  } finally {
    await shell.close()
  }
})

test('feed author addresses line up regardless of type length', async () => {
  const shell = await launchShell()
  try {
    // Types of very different lengths, plus a draft row.
    for (const type of ['a', 'nametag', 'a-very-long-type-name']) {
      const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
        type,
        program: new TextEncoder().encode('<!doctype html><p>x</p>')
      })
      expect((await shell.ingest(bundle)).status).toBe('valid')
    }
    await newFromStarter(shell, 'todo')
    await poll(
      () => chromeEval<number>(shell, `document.querySelectorAll('.sh-feed-author').length`),
      (n) => n === 4 // 3 things + 1 draft label
    )
    const xs = await chromeEval<number[]>(
      shell,
      `Array.from(document.querySelectorAll('.sh-feed-author')).map((n) => Math.round(n.getBoundingClientRect().x))`
    )
    expect(new Set(xs).size, `author column not aligned: ${JSON.stringify(xs)}`).toBe(1)
  } finally {
    await shell.close()
  }
})
