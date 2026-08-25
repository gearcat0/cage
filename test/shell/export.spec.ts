import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Export: a thing leaves this machine ──────────────────────────────────────
// The flyer property, end to end and across accounts: something authored under
// identity A is written out as a .thing file, carried to a DIFFERENT machine
// with a DIFFERENT identity, and admitted there — still signed by A, still the
// same envelope hash.
//
// Export copies the ORIGINAL admitted tar out of the seed store. It must never
// rebuild the bundle: buildBundle signs with the local keyring, so a rebuild
// would re-author the thing — B would receive it over B's own signature (or,
// for the author's own thing, under a brand-new hash). The author + hash
// assertions below are what fail if anyone ever "simplifies" it that way.

const NAMETAG = readFileSync(join(__dirname, '..', '..', 'samples', 'nametag.html'))

async function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

/** Is the header's Export button there, and is it shown? */
const exportButton = (shell: ShellHandle): Promise<string | null> =>
  chromeEval<string | null>(
    shell,
    `(() => {
      const b = document.querySelector('[data-testid=header-export]')
      return b ? (b.style.display === 'none' ? 'hidden' : 'shown') : null
    })()`
  )

test('a thing exported by one account is admitted, intact, by another', async () => {
  const dirA = mkdtempSync(join(tmpdir(), 'shell-export-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'shell-export-b-'))
  try {
    // ── Account A authors something and exports it ──────────────────────────
    let exported: { tarBase64?: string; filename?: string; error?: string }
    let authorA: string
    let envelopeHash: string
    {
      const a = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dirA } })
      try {
        const composed = await a.compose(NAMETAG.toString('base64'), 'nametag')
        const outcome = composed.outcome
        expect(outcome.status).toBe('valid')
        envelopeHash = outcome.envelopeHash as string
        authorA = (outcome.author as { k: string }).k

        exported = await a.exportThing(envelopeHash)
        expect(exported.error ?? null).toBeNull()
        expect(exported.filename).toBe(`nametag-${envelopeHash.slice(0, 8)}.thing`)
        // The sharpest statement of the rule: the exported file is the bundle
        // that was admitted, byte for byte. A rebuild would differ here first.
        expect(exported.tarBase64, 'export must copy the original bytes, not rebuild').toBe(composed.tarBase64)

        // The header offers it on a signed thing...
        await chromeEval(a, `window.__shellChrome.openThing(${JSON.stringify(envelopeHash)})`)
        await expect.poll(() => exportButton(a)).toBe('shown')

        // ...and a draft has no signature to hand anyone, so the button is
        // hidden and the operation refuses with a reason that says why.
        const types = await a.knownTypes()
        const nametag = types.find((t) => t.testKey === 'starter-nametag')!
        const draftId = (await a.newDraft(nametag.key)).id!
        expect((await a.exportThing(draftId)).error).toContain('publish it first')
        await chromeEval(a, `window.__shellChrome.openThing(${JSON.stringify(draftId)})`)
        await expect.poll(() => exportButton(a)).toBe('hidden')
      } finally {
        await a.close() // sequentially: two live Electron apps is pressure this does not need
      }
    }

    // ── Account B, a different machine, admits the file ─────────────────────
    const b = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dirB } })
    try {
      // Genuinely a different account, or the test proves nothing.
      expect((await b.identity()).address).not.toBe(authorA)
      expect(await b.feed()).toEqual([])

      const outcome = await b.ingest(Buffer.from(exported.tarBase64!, 'base64'))
      expect(outcome.status).toBe('valid')
      // Identical bytes in, identical thing out: same hash, still authored by A.
      expect(outcome.envelopeHash).toBe(envelopeHash)
      expect((outcome.author as { k: string }).k).toBe(authorA)

      const feed = await b.feed()
      expect(feed.length).toBe(1)
      expect(feed[0]!.envelopeHash).toBe(envelopeHash)
      expect(feed[0]!.authorKey).toBe(authorA)
    } finally {
      await b.close()
    }
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})
