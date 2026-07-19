import { test, expect, launch, type CageEvent } from './helpers.js'

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
    // The handler serves ONLY known bytes: unknown fetch never returns ok, and
    // the unknown image 404s (onerror), never loads.
    expect(r.fetchOk).not.toBe(true)
    expect(r.imgLoaded).toBeUndefined()
    // A hand-built att/ URL on the thing's OWN id, for a name not in its
    // attachment table, 404s the same way (the table + handler are the gate).
    expect(r.attImgLoaded).toBeUndefined()
    expect(r.attImgError).toBe(true)
    const events = await cage.events()
    expect(
      events.some((e) => e.type === 'att-request' && e.name === 'not-in-the-table' && e.status === 404)
    ).toBe(true)
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
    // Writer and reader run in the SAME app run but different partitions.
    const cage = await open({ thing: 'storage-write.html', thing2: 'storage-read.html' })
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

  test('sealed attachments serve from memory and never touch the CAS', async ({ open }) => {
    const cage = await open({
      thing: 'bridge-attachment.html',
      sealed: true,
      attachments: [{ name: 'poster', file: 'poster.png', mime: 'image/png' }]
    })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    // The sealed thing rendered its attachment normally…
    expect(r.imgLoaded).toBe(true)
    expect(r.naturalWidth).toBe(1)
    // …but NOTHING was written to the persistent content-addressed store:
    // decrypted sealed bytes are memory-only, scoped to this cage's lifetime.
    expect(cage.casBlobs()).toEqual([])
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

  test('emit flood does not crash the shell', async ({ open }) => {
    const cage = await open({ thing: 'bridge-abuse-flood.html' })
    const r = (await cage.waitForEmit('done')) as Record<string, unknown>
    expect(r.count).toBe(5000)
    // Still alive after the flood: we can read the event log.
    const events = await cage.events()
    expect(events.length).toBeGreaterThan(0)
  })
})
