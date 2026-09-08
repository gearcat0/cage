import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── HTTP(S) ingest ───────────────────────────────────────────────────────────
// A `.thing` at a URL is the most ordinary way to hand one to somebody, and it
// was the last gap in the transport set.
//
// Hermetic on purpose: every test here serves from a throwaway localhost server
// in this process. Nothing reaches the internet, so nothing here can fail
// because of the weather.
//
// The properties worth pinning are the ones a hostile server controls: how many
// bytes it can make the shell hold, how long it can hold it, where it can bounce
// it, and — the one that matters most — that none of it lets a server decide
// what gets admitted. Admission re-verifies every signature and hash over the
// bytes that actually arrived.

let shell: ShellHandle
let server: Server
let base = ''

interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: Buffer
  /** Write the body in chunks instead, with no Content-Length — the shape a
   *  server takes when it streams, and the only way to test a cap that has to
   *  bite mid-transfer. */
  stream?: (write: (chunk: Buffer) => Promise<void>) => Promise<void>
}

/** Routes are registered per test; the server is shared. */
let routes = new Map<string, (url: URL) => Reply>()

test.beforeEach(async () => {
  routes = new Map()
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base || 'http://localhost')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404).end('no route')
      return
    }
    const r = handler(url)
    res.writeHead(r.status ?? 200, r.headers ?? {})
    if (r.stream) {
      const write = (chunk: Buffer): Promise<void> =>
        new Promise((resolve) => {
          if (!res.write(chunk)) res.once('drain', () => resolve())
          else resolve()
        })
      void r
        .stream(write)
        .catch(() => undefined)
        .then(() => res.end())
      return
    }
    res.end(r.body ?? Buffer.alloc(0))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  shell = await launchShell()
})

test.afterEach(async () => {
  await shell?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const aBundle = async (type = 'from-the-web'): Promise<Buffer> =>
  Buffer.from(await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), { type }))

test('a bundle served over http is fetched and admitted', async () => {
  const bundle = await aBundle()
  routes.set('/thing.thing', () => ({ body: bundle, headers: { 'content-type': 'application/octet-stream' } }))

  const r = await shell.fetchLocator(`${base}/thing.thing`)
  expect(r.status, JSON.stringify(r)).toBe('valid')
  expect(r.type).toBe('from-the-web')

  // It really landed: the library holds it, like anything else admitted.
  const rows = (await shell.feed()) as { envelopeHash: string }[]
  expect(rows.some((row) => row.envelopeHash === r.envelopeHash)).toBe(true)
})

test('the content-type is ignored — the bytes are what is judged', async () => {
  // Servers label .thing files every way imaginable. Refusing on a label would
  // reject good bundles and admit nothing extra, because admission validates
  // the bytes regardless.
  const bundle = await aBundle('mislabelled')
  routes.set('/x', () => ({ body: bundle, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const r = await shell.fetchLocator(`${base}/x`)
  expect(r.status).toBe('valid')
  expect(r.type).toBe('mislabelled')
})

test('a server cannot make the shell admit rubbish', async () => {
  // The governing principle, stated as a test: a transport delivers bytes, it
  // does not decide what is admitted.
  routes.set('/junk', () => ({ body: Buffer.from('this is not a bundle') }))
  const r = await shell.fetchLocator(`${base}/junk`)
  expect(r.status).toBe('invalid')
})

test('tampered bytes are refused, even though they arrived over a fine connection', async () => {
  // A transport-level success and an admission-level success are different
  // things. Flip a byte in the middle of a real bundle: the fetch is perfectly
  // healthy, and the thing still does not get in.
  const bundle = await aBundle()
  const tampered = Buffer.from(bundle)
  tampered[Math.floor(tampered.length / 2)] ^= 0xff
  routes.set('/tampered', () => ({ body: tampered }))
  const r = await shell.fetchLocator(`${base}/tampered`)
  expect(r.status).not.toBe('valid')
})

test('a non-2xx is reported as itself, not as a mystery', async () => {
  routes.set('/gone', () => ({ status: 410, body: Buffer.from('gone') }))
  const r = await shell.fetchLocator(`${base}/gone`)
  expect(r.status).toBe('invalid')
  expect(String(r.reason)).toMatch(/410/)
})

test('redirects are followed, and a redirect out of http(s) is refused', async () => {
  const bundle = await aBundle('after-redirect')
  routes.set('/final', () => ({ body: bundle }))
  routes.set('/hop2', () => ({ status: 302, headers: { location: '/final' } }))
  routes.set('/hop1', () => ({ status: 302, headers: { location: '/hop2' } }))
  const ok = await shell.fetchLocator(`${base}/hop1`)
  expect(ok.status, JSON.stringify(ok)).toBe('valid')
  expect(ok.type).toBe('after-redirect')

  // A server must not be able to bounce a fetch out of http(s) entirely —
  // reading a local file, say, because it named one in a Location header.
  routes.set('/escape', () => ({ status: 302, headers: { location: 'file:///etc/passwd' } }))
  const escaped = await shell.fetchLocator(`${base}/escape`)
  expect(escaped.status).toBe('invalid')
  expect(String(escaped.reason)).toMatch(/non-http/i)
})

test('a redirect loop ends, rather than spinning', async () => {
  routes.set('/loop', () => ({ status: 302, headers: { location: '/loop' } }))
  const r = await shell.fetchLocator(`${base}/loop`)
  expect(r.status).toBe('invalid')
  expect(String(r.reason)).toMatch(/too many redirects/i)
})

test('an oversized body is refused MID-STREAM, without a declared length', async () => {
  // A server that declares nothing and simply keeps sending must still be cut
  // off. Buffering first and measuring afterwards would let it spend the
  // shell's memory before being refused, which is the whole point of the cap.
  //
  // It also has to STOP: this route would send 8 MB against a 64 KB cap, so if
  // the read ran to completion the test would notice.
  const capped = await launchShell({ extraEnv: { SHELL_MAX_FETCH_BYTES: '65536' } })
  try {
    let sent = 0
    routes.set('/endless', () => ({
      stream: async (write) => {
        const chunk = Buffer.alloc(64 * 1024, 7)
        for (let i = 0; i < 128; i++) {
          await write(chunk)
          sent += chunk.length
        }
      }
    }))
    const r = await capped.fetchLocator(`${base}/endless`)
    expect(r.status).toBe('invalid')
    expect(String(r.reason)).toMatch(/maxBytes/i)
    // Cut off rather than drained: nothing like the full 8 MB was accepted.
    expect(sent).toBeLessThan(4 * 1024 * 1024)
  } finally {
    await capped.close()
  }
})

test('an honestly-declared oversized body is refused before it is read', async () => {
  const capped = await launchShell({ extraEnv: { SHELL_MAX_FETCH_BYTES: '4096' } })
  try {
    routes.set('/big', () => ({ body: Buffer.alloc(64 * 1024, 3) }))
    const r = await capped.fetchLocator(`${base}/big`)
    expect(r.status).toBe('invalid')
    expect(String(r.reason)).toMatch(/maxBytes/i)
  } finally {
    await capped.close()
  }
})

test('a server that never answers is abandoned, not waited on forever', async () => {
  const impatient = await launchShell({ extraEnv: { SHELL_FETCH_TIMEOUT_MS: '2000' } })
  try {
    // Registered as a route that simply never responds.
    const hang = createServer(() => {
      /* deliberately no response, ever */
    })
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve))
    const hangBase = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`
    try {
      const started = Date.now()
      const r = await impatient.fetchLocator(`${hangBase}/nothing`)
      expect(r.status).toBe('invalid')
      expect(String(r.reason)).toMatch(/timed out/i)
      // Bounded by the cap, not by the test's patience.
      expect(Date.now() - started).toBeLessThan(30_000)
    } finally {
      await new Promise<void>((resolve) => hang.close(() => resolve()))
    }
  } finally {
    await impatient.close()
  }
})

// ── Reaching it from the UI, and saying what it costs ────────────────────────

async function chromeEval<T>(js: string): Promise<T> {
  return shell.app.evaluate(async (electron, code) => {
    const wc = electron.webContents
      .getAllWebContents()
      .find((w) => !w.isDestroyed() && w.getURL().includes('shell/chrome'))
    if (!wc) throw new Error('no chrome webContents')
    return (await wc.executeJavaScript(code)) as never
  }, js)
}

/** Type into the Ingest box the way a human would, so the input listener runs. */
async function typeIntoIngest(text: string): Promise<void> {
  await chromeEval(`(() => {
    const i = document.querySelector('.sh-topbar input.evm-input')
    i.value = ${JSON.stringify(text)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
}

const disclosure = (): Promise<{ shown: boolean; text: string; title: string }> =>
  chromeEval(`(() => {
    const b = document.querySelector('[data-testid=ingest-disclosure]')
    return { shown: !!b && b.style.display !== 'none', text: b ? b.textContent : '', title: b ? (b.title || '') : '' }
  })()`)

test('a URL pasted into the Ingest box is FETCHED, not treated as base64', async () => {
  // The regression this file could not see: every other test here calls
  // fetchLocator, which bypasses the chrome's fetch-vs-ingest routing. That
  // routing did not match http(s), so the transport shipped unreachable from
  // the UI while its own tests passed.
  const bundle = await aBundle('via-the-box')
  routes.set('/ui.thing', () => ({ body: bundle }))

  await typeIntoIngest(`${base}/ui.thing`)
  await chromeEval(`document.querySelectorAll('.sh-topbar button').forEach(b => { if (b.textContent === 'Ingest') b.click() })`)

  const rows = await expect
    .poll(async () => ((await shell.feed()) as { type: string }[]).filter((r) => r.type === 'via-the-box').length, {
      timeout: 20_000
    })
    .toBe(1)
  void rows
})

test('the disclosure names the host, and says a URL is not content-addressed', async () => {
  await typeIntoIngest('https://files.example.com/lease.thing')
  const d = await disclosure()
  expect(d.shown).toBe(true)
  expect(d.text).toContain('files.example.com')
  expect(d.text).toMatch(/your IP/i)
  // The rest is on hover, because the topbar is one 48px row and the cage is
  // composited above anything drawn below it.
  expect(d.title).toMatch(/not content-addressed/i)
  expect(d.title).toMatch(/not that it is the thing you asked for/i)
})

test('a magnet discloses the swarm; local locators disclose nothing', async () => {
  await typeIntoIngest('magnet:?xt=urn:btih:0000000000000000000000000000000000000000')
  const m = await disclosure()
  expect(m.shown).toBe(true)
  expect(m.text).toMatch(/BitTorrent/i)
  expect(m.title).toMatch(/learn your IP/i)

  // A file: read and a bundle: hash never leave the machine, so there is
  // nothing to disclose and claiming otherwise would be noise.
  for (const quiet of ['file:/tmp/x.thing', 'bundle:' + 'a'.repeat(64), 'alice.eth', 'bm90IGEgYnVuZGxl']) {
    await typeIntoIngest(quiet)
    expect((await disclosure()).shown, `${quiet} should disclose nothing`).toBe(false)
  }
})

test('the disclosure goes away once the box is empty', async () => {
  await typeIntoIngest('https://files.example.com/x.thing')
  expect((await disclosure()).shown).toBe(true)
  await typeIntoIngest('')
  expect((await disclosure()).shown).toBe(false)
})
