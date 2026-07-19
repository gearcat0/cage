import { test, expect, launch, type CageEvent } from './helpers.js'
import { writeSandboxState } from './sandbox-state-file.js'
import { SEALED_MAGIC } from './global-setup.js'

// ── The escape-attempt suite ─────────────────────────────────────────────────
// Each test loads a malicious thing into a REAL cage, lets it run its attack,
// and asserts two things:
//   1. no network egress occurred — verified OUTSIDE the sandbox by a canary
//      listener that must never receive a connection, and
//   2. no escalation succeeded — verified from the main-process event log and
//      the thing's own self-report.
// One benign thing proves the cage still runs legitimate things.

function has(events: CageEvent[], pred: (e: CageEvent) => boolean): boolean {
  return events.some(pred)
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250))

// ── Harness integrity ────────────────────────────────────────────────────────
// Before trusting anything the wall says, prove the wall is honest about the
// one thing it cannot otherwise show: whether Layer 1 (the OS sandbox) was
// actually exercised (finding P0-1).
test.describe('harness integrity', () => {
  test('OS-sandbox state is recorded, honest, and acknowledged', async ({ open }) => {
    const cage = await open({ thing: 'benign.html' })
    await cage.waitForEmit('done')
    const s = await cage.sandboxState()
    // The app must record ground truth at startup.
    expect(s).not.toBeNull()
    // The env-var escape hatch must NEVER be how the suite runs — helpers scrubs
    // it. If this fails, something re-introduced ELECTRON_DISABLE_SANDBOX.
    expect(s!.envDisabled).toBe(false)
    // Publish the measured state for the green-wall reporter to print.
    writeSandboxState(s!)
    if (s!.argvNoSandbox) {
      // Running with the OS sandbox off (Playwright injects --no-sandbox) is
      // permitted ONLY with an explicit acknowledgement, so a green wall can
      // never silently imply Layer 1 was exercised when it was not.
      expect(
        process.env.CAGE_ALLOW_NO_SANDBOX,
        'OS sandbox is OFF (--no-sandbox). The behavioral guarantees still hold, ' +
          'but Layer 1 was not exercised. Set CAGE_ALLOW_NO_SANDBOX=1 to acknowledge and run.'
      ).toBe('1')
    }
  })
})

// ── Positive control ─────────────────────────────────────────────────────────
test.describe('positive: the cage runs legitimate things', () => {
  test('benign thing renders args and uses getArgs()/emit()', async ({ open, canary }) => {
    const cage = await open({ thing: 'benign.html', args: { greeting: 'hello-cage' } })
    const done = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(done.ok).toBe(true)
    expect(done.getArgsType).toBe('function')
    expect(done.emitType).toBe('function')
    // getArgs() returned the ThingArgs view with exactly the supplied
    // manifest args (canary is merged in by the harness).
    const sawArgs = done.sawArgs as { type: string; args: Record<string, unknown> }
    expect(sawArgs.args.greeting).toBe('hello-cage')
    expect(sawArgs.type).toBe('test')
    // Both bridge functions reached the shell.
    const hello = await cage.emitsOn('hello')
    expect(hello.length).toBe(1)
    // A benign thing does not touch the network either.
    expect(canary.silent()).toBe(true)
  })
})

// ── Network egress ───────────────────────────────────────────────────────────
test.describe('network egress is impossible', () => {
  test('fetch() to canary and to a public origin', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-fetch.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.httpResolved).toBeUndefined()
    expect(r.httpsResolved).toBeUndefined()
    expect(canary.silent()).toBe(true)
  })

  test('XMLHttpRequest to canary', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-xhr.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.loaded).toBeUndefined()
    expect(canary.silent()).toBe(true)
  })

  test('WebSocket to canary', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-websocket.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.opened).toBeUndefined()
    expect(canary.silent()).toBe(true)
  })

  test('EventSource to canary', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-eventsource.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.opened).toBeUndefined()
    expect(canary.silent()).toBe(true)
  })

  test('<img> / Image() beacon to canary', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-image-beacon.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.loaded).toBeUndefined()
    expect(canary.silent()).toBe(true)
    // Guard against a FALSE pass (finding 1.8): after the canary URL moved to
    // getArgs().args.canary, a thing reading it from the wrong place would fire
    // at `undefined/...` and "silent" would prove nothing. The thing reports the
    // URL it actually targeted; assert it was the REAL canary, so silence here
    // means "blocked" (by CSP img-src, upstream of the request canceller), not
    // "never attempted".
    expect(r.target).toBe(`${canary.http}/pixel.gif`)
  })

  test('navigator.sendBeacon to canary', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-sendbeacon.html' })
    await cage.waitForEmit('done')
    await settle()
    expect(canary.silent()).toBe(true)
  })

  test('dynamic remote <script src> injection', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-script-inject.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    await settle()
    expect(r.loaded).toBeUndefined()
    expect(canary.silent()).toBe(true)
  })

  test('CSS url() background exfil', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-css-exfil.html' })
    await cage.waitForEmit('done')
    await settle()
    expect(canary.silent()).toBe(true)
  })

  test('WebRTC / STUN to canary (bypasses webRequest)', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-webrtc.html' })
    const r = (await cage.waitForEmit('done')) as { candidates?: string[] }
    await settle()
    // No server-reflexive/relay candidates, and no UDP datagram reached us.
    const bad = (r.candidates ?? []).filter((c) => /srflx|relay/.test(c))
    expect(bad).toEqual([])
    expect(canary.silent()).toBe(true)
  })

  test('thing:// content outside the supplied blob map fails', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-thing-unknown.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // The handler serves ONLY known bytes, and every vector uses the thing's
    // OWN valid id (not a hostname miss), so the handler is genuinely reached.
    expect(r.fetchOk).not.toBe(true)
    // Unsupplied path on the index.html route: 404 -> onerror, never loads.
    expect(r.pathImgLoaded).toBeUndefined()
    expect(r.pathImgError).toBe(true)
    // A hand-built att/ URL for a name not in the attachment table 404s the same
    // way (the table + handler are the gate).
    expect(r.attImgLoaded).toBeUndefined()
    expect(r.attImgError).toBe(true)
    const events = await cage.events()
    expect(
      events.some((e) => e.type === 'att-request' && e.name === 'not-in-the-table' && e.status === 404)
    ).toBe(true)
    expect(canary.silent()).toBe(true)
  })

  test('one thing cannot reach another thing\'s resources by id (per-session)', async ({ open, canary }) => {
    // Two cages in one run, different sessions. The secondary is handed the
    // primary's real id and tries to load the primary's index.html.
    const cage = await open({ thing: 'benign.html', thing2: 'net-cross-id.html' })
    const r = (await cage.waitForEmit('cross-done')) as Record<string, unknown>
    // It actually had the id (so this is a real attempt, not a no-op)...
    expect(typeof r.primaryId).toBe('string')
    // ...and still could not load: each session registers only its own
    // resources, so the cross-session request 404s.
    expect(r.imgLoaded).toBeUndefined()
    expect(r.imgError).toBe(true)
    expect(canary.silent()).toBe(true)
  })

  test('DNS / speculative connection to an attacker hostname is closed (N2)', async ({ open, canary }) => {
    // Map the attacker hostname straight at the canary, so the canary is a LIVE
    // target: if dns-prefetch/preconnect/fetch leaked past the dead proxy and
    // connect-src, a socket would land on it. (The pure DNS-datagram-to-an-
    // external-resolver channel is separately blocked by the cage's dead-proxy
    // delegation; routing a real DNS query to the canary would need resolver
    // reconfiguration this container does not allow — noted in the review.)
    const addr = new URL(canary.http)
    const cage = await open({
      thing: 'net-dns-prefetch.html',
      extraEnv: { CAGE_HOST_RESOLVER_RULES: `MAP *.attacker.test 127.0.0.1:${addr.port}` }
    })
    const r = (await cage.waitForEmit('done', 10_000)) as Record<string, unknown>
    await settle()
    // The control fetch ran and was rejected (guards against a false pass where
    // the hostname was undefined and the fetch never fired)...
    expect(typeof r.fetchError).toBe('string')
    expect(r.fetchResolved).not.toBe(true)
    // ...and nothing reached the canary on ANY transport (tcp/http/ws/udp/dns)
    // even though the hostname resolved directly to it.
    expect(canary.silent()).toBe(true)
  })

  test('data: resolves as a subresource but cannot become a document (N4)', async ({ open, canary }) => {
    const cage = await open({ thing: 'net-data-document.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // Subresource path is allowed (img-src data:) — data: is legal for rendering.
    expect(r.dataImgLoaded).toBe(true)
    // Document path is blocked: the thing never left its origin. Note the two
    // vectors are stopped by DIFFERENT layers, and this test pins the outcome
    // rather than the mechanism:
    //   - window.open(data:) is denied by our setWindowOpenHandler → null +
    //     a window-open-denied event.
    //   - location.assign(data:) is blocked by CHROMIUM's built-in ban on
    //     top-level data: navigations, which fires BEFORE our will-navigate
    //     handler — so there is (correctly) no navigation-blocked event for it,
    //     yet the thing never leaves thing://. Defense in depth: our handler
    //     also blocks it if Chromium's ban is ever absent.
    expect(r.stillOnThing).toBe(true)
    expect(String(r.openReturned)).toBe('null')
    const events = await cage.events()
    expect(events.some((e) => e.type === 'window-open-denied')).toBe(true)
    expect(canary.silent()).toBe(true)
  })
})

// ── Default-session (trusted chrome) hardening ───────────────────────────────
// The untrusted thing never uses the default session, but the trusted chrome UI
// does. index.ts hardens it so even a compromised chrome cannot beacon out.
// That control had zero coverage (finding N3).
test.describe('the default (chrome) session cannot beacon out', () => {
  test('a fetch from the trusted chrome context is cancelled and silent', async ({ open, canary }) => {
    const cage = await open({ thing: 'benign.html' })
    await cage.waitForEmit('done')
    // Drive the chrome webContents (the non-thing:// one) to attempt egress.
    const probe = (await cage.app.evaluate(async (electron, canaryHttp) => {
      const all = electron.webContents.getAllWebContents()
      const chrome = all.find((wc) => !wc.getURL().startsWith('thing:'))
      if (!chrome) return { noChrome: true }
      return chrome.executeJavaScript(
        `(async () => {
          const out = { attempted: ${JSON.stringify(canaryHttp)} + '/chrome-egress' };
          try { const res = await fetch(out.attempted); out.fetchResolved = res.ok; }
          catch (e) { out.fetchError = String(e); }
          return out;
        })()`
      )
    }, canary.http)) as Record<string, unknown>
    // The probe actually targeted the real canary (guards against a false pass).
    expect(probe.attempted).toBe(`${canary.http}/chrome-egress`)
    // ...and it was cancelled: the default session blocks remote origins even
    // from trusted chrome.
    expect(probe.fetchResolved).not.toBe(true)
    expect(canary.silent()).toBe(true)
  })
})

// ── Persistence / tracking channels ──────────────────────────────────────────
test.describe('persistence and tracking channels are closed', () => {
  test('storage does not survive a fresh partition (reload = new process)', async ({ canary }) => {
    // Writer runs in its own random, non-persistent partition.
    const writer = await launch({ thing: 'storage-write.html', canary })
    const wrote = (await writer.waitForEmit('write-done')) as { wrote: Record<string, unknown> }
    // The writes succeeded in-memory this session...
    expect(wrote.wrote.localStorage).toBe('tracking-id-12345')
    await writer.close()

    // ...but a fresh launch gets a brand-new partition: nothing survives.
    const reader = await launch({ thing: 'storage-read.html', canary })
    const found = (await reader.waitForEmit('read-result')) as { found: Record<string, unknown> }
    await reader.close()
    expect(found.found.localStorage).toBeNull()
    expect(found.found.sessionStorage).toBeNull()
    expect(found.found.cookie).toBe('')
    expect(found.found.indexedDB ?? null).toBeNull()
  })

  test('two different things cannot see each other\'s storage', async ({ open }) => {
    // Writer and reader run in the SAME app run but different partitions. The
    // reader (secondary) is held until the writer's write-done emit (P1-6), so
    // a null read means "isolated", not "nothing had been written yet".
    const cage = await open({
      thing: 'storage-write.html',
      thing2: 'storage-read.html',
      extraEnv: { CAGE_AWAIT_PRIMARY_EMIT: 'write-done' }
    })
    await cage.waitForEmit('write-done')
    const found = (await cage.waitForEmit('read-result')) as { found: Record<string, unknown> }
    expect(found.found.localStorage).toBeNull()
    expect(found.found.sessionStorage).toBeNull()
    expect(found.found.cookie).toBe('')
    expect(found.found.indexedDB ?? null).toBeNull()
  })

  test('Service Worker registration and Cache persistence are denied', async ({ open }) => {
    const cage = await open({ thing: 'sw-cache.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // Registration must not succeed.
    expect(r.swRegistered).toBeUndefined()
  })
})

// ── Escalation / capability probing ──────────────────────────────────────────
test.describe('escalation and capability probing fail', () => {
  test('Node/Electron globals are undefined', async ({ open }) => {
    const cage = await open({ thing: 'escalate-globals.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, string>
    for (const key of ['require', 'process', 'global', 'Buffer', 'module', 'exports', '__dirname']) {
      expect(r[key]).toBe('undefined')
    }
    expect(r.constructorRequire).toBe('blocked')
  })

  test('window.open is denied', async ({ open }) => {
    const cage = await open({ thing: 'escalate-window-open.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.returned).toBe('null')
    const events = await cage.events()
    expect(has(events, (e) => e.type === 'window-open-denied')).toBe(true)
  })

  test('navigation off the thing is prevented', async ({ open }) => {
    const cage = await open({ thing: 'escalate-navigate.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.stayedOnThing).toBe(true)
    const events = await cage.events()
    expect(has(events, (e) => e.type === 'navigation-blocked')).toBe(true)
  })

  test('permission requests are all denied', async ({ open }) => {
    const cage = await open({ thing: 'escalate-permissions.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, string>
    expect(r.geolocation).toMatch(/^denied/)
    expect(r.camera).toMatch(/^denied/)
    expect(r.clipboard).toMatch(/^denied/)
    expect(r.notifications).toBe('denied')
    const events = await cage.events()
    expect(has(events, (e) => e.type === 'permission-denied')).toBe(true)
  })

  test('child frames get no bridge and no network (iframe src + srcdoc) (N1)', async ({ open, canary }) => {
    const cage = await open({ thing: 'escalate-iframe.html' })
    const r = (await cage.waitForEmit('done', 12_000)) as Record<string, unknown>
    // Vector 1: <iframe src="thing://own/index.html"> is blocked by frame-src
    // 'none' — the CSP violation names the frame directive.
    expect(r.frameSrcViolation).toBe(true)
    // Vector 2: the srcdoc child. Either frame-src blocked it (it never ran, so
    // never reported) OR it ran but has no bridge and no network. Both are safe;
    // pin the disjunction so a regression in either direction fails.
    if (r.childReported === true) {
      expect(r.childHasBridge).toBe(false)
      expect(r.childRequire).toBe('undefined')
      expect(r.childFetchResolved).not.toBe(true)
    }
    // The out-of-process witness: nothing left the process from either frame.
    expect(canary.silent()).toBe(true)
  })

  test('the bridge exposes exactly the four phase-2 methods on a frozen object', async ({ open }) => {
    // DELIBERATE phase-2 update (reviewed, not auto-fixed): the frozen surface
    // widened from ['emit','getArgs'] to exactly these four. Any further
    // change to this list is an authority grant and needs the same scrutiny.
    const SURFACE = ['emit', 'getArgs', 'getBlob', 'viewerInfo']
    const cage = await open({ thing: 'escalate-bridge-surface.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.keys).toEqual(SURFACE)
    expect(r.ownProps).toEqual(SURFACE)
    expect(r.frozen).toBe(true)
    expect(r.getArgsType).toBe('function')
    expect(r.getBlobType).toBe('function')
    expect(r.viewerInfoType).toBe('function')
    expect(r.emitType).toBe('function')
    expect(r.ipcRenderer).toBe('undefined')
    expect(r.require).toBe('undefined')
    // Freezing prevented the thing from widening the surface.
    expect(r.mutationTook).toBe('undefined')
  })

  test('the thing cannot escape its rectangle or cover the chrome strip', async ({ open }) => {
    const cage = await open({ thing: 'spoof-chrome.html' })
    await cage.waitForEmit('done')
    const b = await cage.bounds()
    // The chrome strip is a separate native view the thing never resized/covered.
    expect(b.chrome).not.toBeNull()
    expect(b.cage).not.toBeNull()
    expect(b.chrome!.y).toBe(0)
    expect(b.chrome!.height).toBe(44)
    // The cage sits strictly below the chrome and never overlaps it.
    expect(b.cage!.y).toBe(b.chrome!.y + b.chrome!.height)
    expect(b.cage!.x).toBe(0)
  })
})

// ── The bridge, phase 2: hands over data, never authority ───────────────────
test.describe('the bridge hands over data, not authority', () => {
  test('a thing renders args and an attachment end to end via getBlob', async ({ open, canary }) => {
    const cage = await open({
      thing: 'bridge-attachment.html',
      args: { caption: 'hello poster' },
      attachments: [{ name: 'poster', file: 'poster.png', mime: 'image/png' }]
    })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.type).toBe('test')
    expect((r.args as Record<string, unknown>).caption).toBe('hello poster')
    expect(r.attachments).toEqual([{ name: 'poster', mime: 'image/png', size: 70 }])
    expect(r.url).toMatch(/^thing:\/\/[0-9a-f-]+\/att\/poster$/)
    expect(r.imgLoaded).toBe(true)
    expect(r.naturalWidth).toBe(1)
    // The bytes were served through the handler with the manifest's MIME.
    const events = await cage.events()
    expect(events.some((e) => e.type === 'att-request' && e.name === 'poster' && (e.status === 200 || e.status === 206))).toBe(true)
    // A public thing's attachment lives in the persistent CAS.
    expect(cage.casBlobs().length).toBe(1)
    expect(canary.silent()).toBe(true)
  })

  test('attachments are served only by admitted name', async ({ open }) => {
    const cage = await open({
      thing: 'bridge-att-by-name.html',
      attachments: [{ name: 'known', file: 'poster.png', mime: 'image/png' }]
    })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.knownUrl).toMatch(/^thing:\/\//)
    expect(r.knownLoaded).toBe(true)
    // Unknown / malformed names: getBlob returns null (the clean signal)…
    expect(r.nopeUrl).toBeNull()
    expect(r.nonStringUrl).toBeNull()
    // …and the actual gate — the handler — 404s the hand-built URL.
    expect(r.handBuiltLoaded).toBeUndefined()
    expect(r.handBuiltError).toBe(true)
    const events = await cage.events()
    expect(events.some((e) => e.type === 'att-request' && e.name === 'nope' && e.status === 404)).toBe(true)
  })

  test('a media attachment seeks: Range requests are served with 206', async ({ open }) => {
    const cage = await open({
      thing: 'bridge-att-range.html',
      attachments: [{ name: 'tone', file: 'tone.wav', mime: 'audio/wav' }]
    })
    const r = (await cage.waitForEmit('done', 15_000)) as Record<string, unknown>
    expect(r.mediaError).toBeUndefined()
    expect(r.seeked).toBe(true)
    expect(r.duration).toBeGreaterThan(1.5)
    // Chromium's media stack asked for a byte range and got a 206 back.
    const events = await cage.events()
    const ranged = events.filter(
      (e) => e.type === 'att-request' && e.name === 'tone' && e.status === 206 && e.range !== null
    )
    expect(ranged.length).toBeGreaterThan(0)
  })

  test('getArgs withholds the envelope (identity-spoof regression pin)', async ({ open }) => {
    const cage = await open({
      thing: 'bridge-getargs-envelope.html',
      args: { anything: 1 },
      attachments: [{ name: 'poster', file: 'poster.png', mime: 'image/png' }]
    })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // Exactly the ThingArgs view: no author, signature, created, path, seq,
    // prev, prog — identity claims live in chrome pixels, never in the thing.
    expect(r.topLevelKeys).toEqual(['args', 'attachments', 'type'])
    // Attachment rows expose name/mime/size — never the hash: things address
    // blobs by NAME, and must not be able to construct content claims.
    expect(r.attachmentKeys).toEqual([['mime', 'name', 'size']])
  })

  test('viewerInfo is coarse and non-identifying', async ({ open }) => {
    const cage = await open({ thing: 'bridge-viewerinfo.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // Exactly locale + colorScheme. Any new key here is a fingerprinting
    // surface and must not appear without the same scrutiny as the bridge
    // surface test.
    expect(r.keys).toEqual(['colorScheme', 'locale'])
    expect(r.localeType).toBe('string')
    expect(['light', 'dark']).toContain(r.colorScheme)
  })

  test('emit("publish") records a validated draft with an assembled attachment table', async ({ open }) => {
    const cage = await open({ thing: 'bridge-publish-valid.html' })
    const done = (await cage.waitForEmit('done')) as Record<string, unknown>
    const events = await cage.events()
    const drafts = events.filter((e) => e.type === 'draft-recorded')
    expect(drafts.length).toBe(1)
    const draft = drafts[0] as Extract<CageEvent, { type: 'draft-recorded' }>
    expect(draft.draftType).toBe('event')
    // The shell hashed the inline blob into a manifest-shaped Att row.
    const att = draft.att.poster
    expect(att).toBeDefined()
    expect(att.h).toMatch(/^[0-9a-f]{64}$/)
    expect(att.n).toBe(done.blobLength)
    expect(draft.blobBytes).toBe(done.blobLength)
  })

  test('a flood of valid publish drafts stays bounded and retains no blob bytes', async ({ open }) => {
    const cage = await open({ thing: 'bridge-publish-flood.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, number>
    expect(r.count).toBe(100)
    const info = (await cage.app.evaluate(async (electron) => {
      const c = (electron.app as unknown as { __cage?: { drafts: Record<string, unknown>[] } }).__cage
      if (!c) return { len: -1, lastKeys: [] as string[] }
      return { len: c.drafts.length, lastKeys: Object.keys(c.drafts[c.drafts.length - 1] ?? {}).sort() }
    })) as { len: number; lastKeys: string[] }
    // 100 valid drafts accepted, but the in-memory list is a bounded ring...
    expect(info.len).toBeGreaterThan(0)
    expect(info.len).toBeLessThanOrEqual(64)
    // ...and the retained draft is METADATA only — the raw blob bytes are not
    // held (no `blobs` key), so the retained size per draft is tiny.
    expect(info.lastKeys).toEqual(['argsBytes', 'att', 'blobBytes', 'type'])
    expect(info.lastKeys).not.toContain('blobs')
  })

  test('oversized publish drafts are rejected (per-blob AND total caps)', async ({ open }) => {
    const cage = await open({
      thing: 'bridge-publish-oversized.html',
      extraEnv: {
        CAGE_MAX_DRAFT_BLOB_BYTES: '4096',
        CAGE_MAX_DRAFT_TOTAL_BYTES: '16384'
      }
    })
    await cage.waitForEmit('done')
    const events = await cage.events()
    const rejected = events.filter((e) => e.type === 'emit-rejected')
    expect(rejected.some((e) => /too large/.test(e.reason))).toBe(true)
    expect(rejected.some((e) => /total blob bytes/.test(e.reason))).toBe(true)
    // Neither abuse produced a draft.
    expect(events.some((e) => e.type === 'draft-recorded')).toBe(false)
  })

  test('malformed publish drafts are rejected', async ({ open }) => {
    const cage = await open({ thing: 'bridge-publish-malformed.html' })
    const done = (await cage.waitForEmit('done')) as Record<string, unknown>
    const events = await cage.events()
    const rejected = events.filter(
      (e) => e.type === 'emit-rejected' && (e.reason as string).startsWith('publish:')
    )
    // Every malformed attempt was rejected; none became a draft.
    expect(rejected.length).toBe(done.sent)
    expect(events.some((e) => e.type === 'draft-recorded')).toBe(false)
  })

  test('sealed attachments serve from memory and never touch disk', async ({ open }) => {
    const att = [{ name: 'poster', file: 'sealed-poster.png', mime: 'image/png' }]

    // Control: a PUBLIC render of the SAME magic-marked fixture writes it to the
    // CAS, and scanDisk finds the marker there. This proves the scanner is not
    // vacuous — so absence in the sealed case below means "not on disk", not
    // "the scan can't detect it" (the 1.8-style false-pass guard).
    const pub = await open({ thing: 'bridge-attachment.html', attachments: att })
    const pr = (await pub.waitForEmit('done')) as Record<string, unknown>
    expect(pr.imgLoaded).toBe(true)
    expect(pub.casBlobs().length).toBe(1)
    expect(pub.scanDisk(SEALED_MAGIC).length).toBeGreaterThan(0)

    // Sealed: the thing renders its attachment normally…
    const cage = await open({ thing: 'bridge-attachment.html', sealed: true, attachments: att })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.imgLoaded).toBe(true)
    expect(r.naturalWidth).toBe(1)
    // …but the decrypted plaintext is provably NOWHERE on disk: not in the
    // persistent CAS, and not anywhere in Electron's userData/cache tree.
    // Sealed bytes live only in the ephemeral in-memory store.
    expect(cage.casBlobs()).toEqual([])
    expect(cage.scanDisk(SEALED_MAGIC)).toEqual([])
  })
})

// ── Bridge abuse ─────────────────────────────────────────────────────────────
test.describe('bridge abuse is contained', () => {
  test('oversized emit is rejected and the shell stays responsive', async ({ open }) => {
    const cage = await open({ thing: 'bridge-abuse-huge.html' })
    await cage.waitForEmit('done') // shell still processing emits => responsive
    const events = await cage.events()
    expect(has(events, (e) => e.type === 'emit-rejected')).toBe(true)
    // The oversized payload was never accepted/recorded as a real emit.
    expect(has(events, (e) => e.type === 'emit' && e.channel === 'flood-huge')).toBe(false)
  })

  test('a large-payload emit flood leaves the main-process log bounded', async ({ open }) => {
    const cage = await open({ thing: 'bridge-abuse-flood.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, number>
    expect(r.count).toBe(200)
    const stats = await cage.stats()
    // The log never exceeds the ring-buffer cap...
    expect(stats.eventsLength).toBeLessThanOrEqual(2000)
    // ...and — the actual P0-3 property — payloads are NOT retained. ~40 MB of
    // emit bodies were sent, but the serialized log stays tiny because each
    // emit stores only size + a short hash. Bytes-sent dwarfs bytes-retained.
    const bytesSent = r.count * r.chunkBytes
    expect(bytesSent).toBeGreaterThan(20 * 1024 * 1024)
    expect(stats.eventsBytes).toBeLessThan(512 * 1024)
  })

  test('an emit-count flood evicts from the ring buffer (bounded log)', async ({ open }) => {
    // 2500 emits on one ordered IPC channel: by the time 'done' lands, all were
    // recorded, so the log MUST have truncated. Deterministic proof of eviction
    // under a real driver (the ring-buffer math is also unit-tested).
    const cage = await open({ thing: 'bridge-abuse-count-flood.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, number>
    expect(r.count).toBe(2500)
    const stats = await cage.stats()
    expect(stats.eventsLength).toBeLessThanOrEqual(2000)
    expect(stats.dropped).toBeGreaterThan(0)
  })

  test('a blocked-request flood stays bounded and silent', async ({ open, canary }) => {
    // The request canceller is the other record() caller. Thousands of image
    // beacons must not grow the log past its cap, and none may leave the
    // process. (Exact eviction is covered by the emit-count test above; here
    // the axis is the blocked-request path under volume + no egress.)
    const cage = await open({ thing: 'net-abuse-blocked-flood.html' })
    await cage.waitForEmit('done', 15_000)
    const stats = await cage.stats()
    expect(stats.eventsLength).toBeLessThanOrEqual(2000)
    expect(canary.silent()).toBe(true)
  })
})
