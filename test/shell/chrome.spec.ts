import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, type ShellHandle } from './helpers.js'

// ── Chrome integrity (brief §3, round-two N6) ────────────────────────────────
// The trust signals live in chrome pixels the thing cannot reach. This is the
// N6 pixel test made load-bearing: a thing paints a convincing fake "✓ signed"
// badge AND floods its viewport with a unique colour; the chrome's own layer
// (captured separately) must contain the REAL badge and NONE of the thing's
// colour — proving the thing is spatially confined to its own view and cannot
// forge or overpaint the trust chrome.

const SPOOF_PROGRAM = `<!doctype html><html><body style="margin:0;background:#ff00ff">
  <div style="position:fixed;top:6px;left:6px;background:#4ade80;color:#000;padding:6px 10px;font:14px sans-serif">
    ✓ signed by alice.eth
  </div>
  <h1 style="color:#fff">totally legit</h1>
</body></html>`

interface PixelCounts {
  url: string
  width: number
  height: number
  magenta: number
  green: number
}

/** Capture each webContents' OWN layer and count the thing colour (magenta) and
 *  the verified-badge colour (green). capturePage returns only that contents'
 *  render, not sibling views composited over it. */
async function capture(shell: ShellHandle): Promise<{ chrome?: PixelCounts; thing?: PixelCounts }> {
  return shell.app.evaluate(async (electron) => {
    const count = async (wc: Electron.WebContents): Promise<PixelCounts> => {
      const img = await wc.capturePage()
      const { width, height } = img.getSize()
      const bmp = img.toBitmap() // BGRA
      let magenta = 0
      let green = 0
      for (let i = 0; i + 3 < bmp.length; i += 4) {
        const b = bmp[i]!
        const g = bmp[i + 1]!
        const r = bmp[i + 2]!
        if (r > 200 && g < 70 && b > 200) magenta++
        else if (g > 170 && r < 130 && b < 180) green++
      }
      return { url: wc.getURL(), width, height, magenta, green }
    }
    const all = electron.webContents.getAllWebContents()
    const chromeWc = all.find((w) => w.getURL().includes('shell/chrome'))
    const thingWc = all.find((w) => w.getURL().startsWith('thing:'))
    const out: { chrome?: PixelCounts; thing?: PixelCounts } = {}
    if (chromeWc) out.chrome = await count(chromeWc)
    if (thingWc) out.thing = await count(thingWc)
    return out as never
  })
}

let shell: ShellHandle
test.beforeAll(async () => {
  shell = await launchShell()
})
test.afterAll(async () => {
  await shell?.close()
})

test('a thing cannot forge or overpaint the chrome trust badge (N6)', async () => {
  const signer = ethSigner(secp256k1.utils.randomSecretKey())
  const bundle = await buildBundle(signer, {
    type: 'spoof',
    program: new TextEncoder().encode(SPOOF_PROGRAM)
  })
  const r = await shell.ingest(bundle)
  expect(r.status).toBe('valid')

  // Drive the chrome to open it: renders the REAL trust header AND mounts the
  // spoof thing into the cage view.
  await shell.app.evaluate(async (electron, hash) => {
    const all = electron.webContents.getAllWebContents()
    const chromeWc = all.find((w) => w.getURL().includes('shell/chrome'))
    await chromeWc?.executeJavaScript(
      `window.__shellChrome && window.__shellChrome.openThing(${JSON.stringify(hash)})`
    )
  }, r.envelopeHash as string)

  // Let both layers paint.
  await new Promise((res) => setTimeout(res, 1500))

  const caps = await capture(shell)
  // The thing DID render its spoof — magenta fill present in the cage layer.
  // (Guards against a false pass where the thing painted nothing.)
  expect(caps.thing, 'thing view should exist').toBeTruthy()
  expect(caps.thing!.magenta).toBeGreaterThan(1000)

  // The chrome layer carries the REAL verified badge (green)...
  expect(caps.chrome, 'chrome view should exist').toBeTruthy()
  expect(caps.chrome!.green).toBeGreaterThan(100)
  // ...and NONE of the thing's colour. The thing is confined to its own view;
  // its pixels never reach the chrome layer where the trust signal lives.
  expect(caps.chrome!.magenta).toBe(0)
})

test('a thing cannot initiate a publish — emit("publish") is retired', async () => {
  // Publish is SHELL-owned: the chrome button signs the latest streamed draft
  // after a human confirms. A thing emitting the retired publish channel must
  // raise NO confirm dialog and be rejected at the bridge.
  const program = `<!doctype html><html><body><script>
    window.bridge.emit('publish', { type: 'event', args: { title: 'bbq' } });
  <\/script></body></html>`
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'publisher',
    program: new TextEncoder().encode(program)
  })
  const r = await shell.ingest(bundle)
  await shell.openThing(r.envelopeHash as string) // mounts + the thing emits publish
  await new Promise((res) => setTimeout(res, 800))

  const state = (await shell.app.evaluate(async (electron) => {
    const a = electron.app as unknown as {
      __shell: { lastConfirm: unknown }
      __cage?: { events: { type: string; reason?: string }[] }
    }
    return {
      lastConfirm: a.__shell.lastConfirm,
      rejected: a.__cage?.events.some((e) => e.type === 'emit-rejected' && /retired/.test(e.reason ?? '')) ?? false
    } as never
  })) as { lastConfirm: unknown; rejected: boolean }
  expect(state.lastConfirm).toBeNull()
  expect(state.rejected).toBe(true)
})
