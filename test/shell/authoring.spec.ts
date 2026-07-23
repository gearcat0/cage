import { test, expect, launchShell, type ShellHandle } from './helpers.js'

// ── Authoring (brief phase 7) ────────────────────────────────────────────────
// The shell can now MAKE a thing: pick HTML → sign with the identity → a
// shareable .thing. The load-bearing property is the flyer round-trip — a thing
// I author admits as `valid` in a stranger's shell, by SIGNATURE, with no shared
// state. That is what makes file handoff a real sharing channel.

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const bytesFromB64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'base64'))

const HTML = '<!doctype html><meta charset="utf-8"><h1>my first thing</h1>'

let shell: ShellHandle

test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

test('compose signs a thing with the running identity, admits it, and it lands in the feed', async () => {
  const { outcome } = await shell.compose(b64(HTML), 'page')
  expect(outcome.status).toBe('valid')
  expect(outcome.type).toBe('page')
  const id = await shell.identity()
  expect((outcome.author as { k: string }).k).toBe(id.address) // signed by us
  const feed = await shell.feed()
  expect(feed.some((r) => r.envelopeHash === outcome.envelopeHash)).toBe(true)
})

test('the .thing round-trips: a stranger\'s fresh shell admits it as valid, by signature', async () => {
  const mine = await shell.identity()
  const { outcome, tarBase64 } = await shell.compose(b64('<!doctype html><h1>flyer</h1>'), 'note')
  expect(outcome.status).toBe('valid')

  // A brand-new shell with a DIFFERENT identity and no shared state.
  const other = await launchShell()
  try {
    const theirs = await other.identity()
    expect(theirs.address).not.toBe(mine.address)
    const r = await other.ingest(bytesFromB64(tarBase64))
    expect(r.status).toBe('valid')
    expect((r.author as { k: string }).k).toBe(mine.address) // still MY thing, verified by its signature
  } finally {
    await other.close()
  }
})

test('compose carries attachments; they verify on a fresh admit', async () => {
  const { tarBase64 } = await shell.compose(b64('<!doctype html><h1>gallery</h1>'), 'gallery', [
    { name: 'a.txt', base64: b64('hello attachment'), mime: 'text/plain' }
  ])
  const other = await launchShell()
  try {
    const r = await other.ingest(bytesFromB64(tarBase64))
    expect(r.status).toBe('valid')
    expect(r.attachments).toEqual(['a.txt'])
  } finally {
    await other.close()
  }
})

test('a composed thing is seeded — re-fetchable by bundle:<hash> (feeds the live-transport fast-follow)', async () => {
  const { tarBase64 } = await shell.compose(b64(HTML), 'page')
  // The seed store is keyed by tar-hash; recompute it the same way the shell does.
  const { hash } = await import('../../src/format/index.js')
  const tarHash = [...hash(bytesFromB64(tarBase64))].map((x) => x.toString(16).padStart(2, '0')).join('')
  expect(await shell.seedHas(tarHash)).toBe(true)
})

test('the shell reports its key-storage mode for the safety warning', async () => {
  const id = await shell.identity()
  expect(id.keyStorage).toBe('software') // SHELL_FORCE_SOFTWARE_KEYS=1 in tests
})
