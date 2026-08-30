import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'
import { test, expect, launchShell, type ShellHandle } from './helpers.js'
import { ethAddressHex, mnemonicToAccounts } from '../../src/shell/keyring/hd.js'
import { toChecksumAddress } from '../../src/shell/address.js'

// ── Account & Keys ───────────────────────────────────────────────────────────
// Identity setup for real testers: view/copy, back up, and replace the
// identity from a BIP-39 phrase (MetaMask account picker) or a raw private
// key. Replacements are written atomically with a .bak of the old file and
// take effect on restart (specs relaunch explicitly — SHELL_NO_RELAUNCH=1).

const HARDHAT = 'test test test test test test test test test test test junk'
const HARDHAT_0 = 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const HARDHAT_1 = '70997970c51812dc3a010c7d01b50e0d17dc79c8'
const HARDHAT_0_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const SHELL_MAIN = join(__dirname, '..', '..', 'out', 'main', 'shell', 'main.js')

async function chromeEval<T>(shell: ShellHandle, js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
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

const openAccount = async (shell: ShellHandle): Promise<void> => {
  await chromeEval(shell, `document.querySelector('[data-testid=account-open]').click()`)
  await poll(
    () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-address]')`),
    (v) => v
  )
}

const click = (shell: ShellHandle, testid: string): Promise<void> =>
  chromeEval(shell, `document.querySelector('[data-testid=${testid}]').click()`)

const textOf = (shell: ShellHandle, testid: string): Promise<string | null> =>
  chromeEval<string | null>(shell, `document.querySelector('[data-testid=${testid}]')?.textContent ?? null`)

const setValue = (shell: ShellHandle, testid: string, value: string): Promise<void> =>
  chromeEval(
    shell,
    `(() => {
      const i = document.querySelector('[data-testid=${testid}]')
      i.value = ${JSON.stringify(value)}
      i.dispatchEvent(new Event('input'))
    })()`
  )

const bakFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith('identity.key.enc.bak-'))

/** Relaunch against the same userData dir and read the identity. */
async function identityAfterRestart(dir: string): Promise<string> {
  const next = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
  try {
    return (await next.identity()).address
  } finally {
    await next.close()
  }
}

test('shows the identity and reveals the secret behind a confirmation', async () => {
  const shell = await launchShell()
  try {
    const id = await shell.identity()
    await openAccount(shell)
    // Displayed EIP-55 (what wallets show); the stored value stays bare hex.
    expect(id.address).toMatch(/^[0-9a-f]{40}$/)
    expect(await textOf(shell, 'account-address')).toBe(toChecksumAddress(id.address))
    expect(await textOf(shell, 'account-address')).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(await textOf(shell, 'account-nostr')).toBe(id.nostrPubkey) // not an address — untouched
    expect(await textOf(shell, 'account-storage')).toContain('software') // helpers force software keys

    // Reveal is gated: nothing shown until the danger dialog is confirmed.
    await click(shell, 'account-export-reveal')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    expect(await textOf(shell, 'account-secret')).toBeNull()
    await click(shell, 'danger-confirm')

    const secret = await poll(() => textOf(shell, 'account-secret'), (t) => t !== null)
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    // The revealed key really is this identity's key.
    const bytes = Uint8Array.from((secret!.match(/../g) ?? []).map((h) => parseInt(h, 16)))
    expect(ethAddressHex(bytes)).toBe(id.address)
  } finally {
    await shell.close()
  }
})

test('imports a raw private key (0x accepted) and takes effect after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-pk-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    const before = (await shell.identity()).address
    expect(before).not.toBe(HARDHAT_0)
    await openAccount(shell)
    await setValue(shell, 'account-privkey-input', `0x${HARDHAT_0_KEY}`)
    await click(shell, 'account-import-privkey')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    await click(shell, 'danger-confirm')
    // The old encrypted key file is backed up before being replaced.
    await poll(async () => bakFiles(dir).length, (n) => n === 1)
    await shell.app.close() // keep the dir

    expect(await identityAfterRestart(dir)).toBe(HARDHAT_0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('derives accounts from a seed phrase and imports the picked one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-seed-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    await openAccount(shell)
    await setValue(shell, 'account-mnemonic-input', HARDHAT)
    await click(shell, 'account-derive')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-option-4]')`),
      (v) => v
    )
    // The picker shows the MetaMask-path addresses.
    const rows = await chromeEval<string[]>(
      shell,
      `Array.from(document.querySelectorAll('.sh-account-row')).map((r) => r.textContent)`
    )
    expect(rows[0]).toContain(toChecksumAddress(HARDHAT_0))
    expect(rows[1]).toContain(toChecksumAddress(HARDHAT_1))
    expect(rows.length).toBe(5)

    // Pick account 1 (not the default) — the index must be honored.
    await click(shell, 'account-option-1')
    await click(shell, 'account-use-seed')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    await click(shell, 'danger-confirm')
    await poll(async () => bakFiles(dir).length, (n) => n === 1)
    await shell.app.close()

    expect(await identityAfterRestart(dir)).toBe(HARDHAT_1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cancelling the danger dialog leaves the identity untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-cancel-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    const before = (await shell.identity()).address
    const fileBefore = readFileSync(join(dir, 'identity.key.enc'))
    await openAccount(shell)
    await setValue(shell, 'account-privkey-input', HARDHAT_0_KEY)
    await click(shell, 'account-import-privkey')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-cancel]')`),
      (v) => v
    )
    await click(shell, 'danger-cancel')
    await new Promise((r) => setTimeout(r, 500))

    expect((await shell.identity()).address).toBe(before)
    expect(readFileSync(join(dir, 'identity.key.enc')).equals(fileBefore)).toBe(true)
    expect(bakFiles(dir).length).toBe(0)
    await shell.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generates a new identity: phrase shown once, gated on writing it down', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-gen-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    await openAccount(shell)
    await click(shell, 'account-generate')
    const words = await poll(() => textOf(shell, 'account-new-mnemonic'), (t) => t !== null)
    expect(words!.split(' ').length).toBe(12)

    // The commit button is disabled until the "I wrote it down" box is ticked.
    expect(await chromeEval<boolean>(shell, `document.querySelector('[data-testid=account-use-generated]').disabled`)).toBe(
      true
    )
    await chromeEval(
      shell,
      `(() => {
        const c = document.querySelector('[data-testid=account-wrote-down]')
        c.checked = true
        c.dispatchEvent(new Event('change'))
      })()`
    )
    expect(await chromeEval<boolean>(shell, `document.querySelector('[data-testid=account-use-generated]').disabled`)).toBe(
      false
    )

    await click(shell, 'account-use-generated')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    await click(shell, 'danger-confirm')
    await poll(async () => bakFiles(dir).length, (n) => n === 1)
    await shell.app.close()

    // The stored identity is account 0 of exactly the phrase we were shown.
    expect(await identityAfterRestart(dir)).toBe(mnemonicToAccounts(words!, 1)[0]!.address)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable identity file reports the problem instead of bricking or regenerating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-corrupt-'))
  const marker = join(dir, 'boot-error.txt')
  try {
    // Seed a real identity, then corrupt it two ways: a valid scheme byte with
    // garbage payload, and an unknown scheme byte.
    const first = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    await first.close()
    rmSync(join(dir, 'boot-error.txt'), { force: true })

    for (const corrupt of [Buffer.from([0x02, 1, 2, 3, 4, 5]), Buffer.from([0xff, 9, 9, 9])]) {
      const keyPath = join(dir, 'identity.key.enc')
      writeFileSync(keyPath, corrupt)
      rmSync(marker, { force: true })

      // Raw launch: waitReady would spin forever — the app must exit instead.
      const app: ElectronApplication = await _electron.launch({
        args: [SHELL_MAIN],
        env: {
          ...process.env,
          SHELL_USER_DATA_DIR: dir,
          SHELL_FORCE_SOFTWARE_KEYS: '1',
          SHELL_BOOT_ERROR_FILE: marker
        } as Record<string, string>
      })
      await poll(
        async () => readdirSync(dir).includes('boot-error.txt'),
        (v) => v
      )
      const msg = readFileSync(marker, 'utf8')
      expect(msg).toContain('identity.key.enc')
      expect(msg).toContain('.bak-')
      // The unreadable file is left EXACTLY as it was — never regenerated.
      expect(readFileSync(keyPath).equals(corrupt)).toBe(true)
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ESC dismisses the account modal and cancels a danger dialog', async () => {
  const shell = await launchShell()
  try {
    const pressEsc = (): Promise<void> =>
      chromeEval(
        shell,
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
      )

    await openAccount(shell)
    await pressEsc()
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-address]')`),
      (present) => !present
    )

    // ESC on a danger dialog cancels it (and leaves the modal beneath open).
    await openAccount(shell)
    await click(shell, 'account-export-reveal')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    await pressEsc()
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (present) => !present
    )
    expect(await textOf(shell, 'account-secret')).toBeNull() // cancelled — nothing revealed
    expect(await chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-address]')`)).toBe(true)

    // Every overlay closed: the cage views are released again (overlay count
    // must not leak, or the shell would look frozen with nothing on screen).
    await pressEsc()
    await poll(
      () => chromeEval<number>(shell, `document.querySelectorAll('.evm-modal-overlay').length`),
      (n) => n === 0
    )
  } finally {
    await shell.close()
  }
})

// A second valid phrase (BIP-39's all-ones entropy vector), so "the phrase
// changed" is a real wallet change rather than a typo the validator rejects.
const ZOO = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

test('the derived account list never outlives the phrase it came from', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shell-acct-stale-'))
  try {
    const shell = await launchShell({ extraEnv: { SHELL_USER_DATA_DIR: dir } })
    await openAccount(shell)
    await setValue(shell, 'account-mnemonic-input', HARDHAT)
    await click(shell, 'account-derive')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-option-4]')`),
      (v) => v
    )

    // Editing the phrase makes those addresses a claim about a different
    // wallet. They must go, or you could pick an account from one wallet and
    // import that index from another — an identity you never saw.
    await setValue(shell, 'account-mnemonic-input', ZOO)
    expect(
      await chromeEval<number>(shell, `document.querySelectorAll('[name=hd-account]').length`),
      'the stale list must be dropped'
    ).toBe(0)
    expect(
      await chromeEval<boolean>(
        shell,
        `(() => { const b = document.querySelector('[data-testid=account-use-seed]'); return b.disabled || b.style.display === 'none' })()`
      ),
      'and nothing must be importable from it'
    ).toBe(true)

    // Belt and braces: even if the box changes WITHOUT the edit being noticed
    // (no input event), the import uses the phrase the shown addresses came
    // from — you get the address you approved, not the one now in the box.
    await setValue(shell, 'account-mnemonic-input', HARDHAT)
    await click(shell, 'account-derive')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=account-option-1]')`),
      (v) => v
    )
    await click(shell, 'account-option-1')
    await chromeEval(
      shell,
      `document.querySelector('[data-testid=account-mnemonic-input]').value = ${JSON.stringify(ZOO)}`
    )
    await click(shell, 'account-use-seed')
    await poll(
      () => chromeEval<boolean>(shell, `!!document.querySelector('[data-testid=danger-confirm]')`),
      (v) => v
    )
    await click(shell, 'danger-confirm')
    await poll(async () => bakFiles(dir).length, (n) => n === 1)
    await shell.app.close()

    // HARDHAT's account 1 — the row that was on screen and selected.
    expect(await identityAfterRestart(dir)).toBe(HARDHAT_1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
