import {
  parseBundle,
  decodeEnvelope,
  decodeManifest,
  isSealed,
  DEFAULT_BUNDLE_LIMITS,
  type BundleLimits
} from '../../format/index.js'

// ── Admission worker — the isolated structural-decode process (brief §1.1) ───
//
// This runs in an Electron `utilityProcess`, NOT the keyring process. It does
// the parser-attack-surface work — raw-size caps, tar stream-extract with
// per-entry/total/count caps, CBOR decode under §2.3 limits, canonical
// validation — on hostile bytes. It holds NO keys and needs none. Output is a
// bounded, well-formed BundleSource or a typed rejection. If a decoder OOMs,
// loops, or panics, THIS process dies and the parent rejects the bundle; the
// keyring process is untouched.

interface Request {
  id: number
  raw: Uint8Array
  limits?: BundleLimits
}

type Response =
  | {
      id: number
      ok: true
      source: {
        envelope: Uint8Array
        manifest?: Uint8Array
        program?: Uint8Array
        manifestEnc?: Uint8Array
        programEnc?: Uint8Array
        blobs: [string, Uint8Array][]
      }
      sealed: boolean
    }
  | { id: number; ok: false; reason: string }

const parentPort = (process as unknown as { parentPort: import('electron').MessagePortMain }).parentPort

// TEST-ONLY (gated): recognize a sentinel-prefixed bundle and die mid-admission,
// to prove the parent's isolation machinery (worker death/hang → reject → the
// keyring process survives). The prefix is "THINGCRASH:<mode>\n". Never active
// unless SHELL_WORKER_ALLOW_TEST_CRASH=1, so production ignores it entirely.
function testCrashMode(raw: Uint8Array): string | null {
  if (process.env.SHELL_WORKER_ALLOW_TEST_CRASH !== '1') return null
  const head = new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, 24))
  const m = /^THINGCRASH:(\w+)\n/.exec(head)
  return m ? m[1]! : null
}

parentPort.on('message', (event: { data: Request }) => {
  const { id, raw, limits } = event.data
  const rawBytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const crash = testCrashMode(rawBytes)
  if (crash === 'exit') process.exit(1)
  if (crash === 'hang') for (;;) { /* wedge the decoder */ }
  try {
    const lim = limits ?? DEFAULT_BUNDLE_LIMITS
    // parseBundle enforces the raw-size cap and the tar caps (per-entry, total,
    // count) — a tar-bomb is refused here, in isolation.
    const source = parseBundle(rawBytes, lim)

    // Structurally decode + validate canonical form on hostile input, in this
    // process. Sealed envelopes can't be decoded without the key, so only the
    // Sealed structure is validated (parseBundle + isSealed peek); public
    // envelopes and manifests are fully canonical-validated here.
    const sealed = isSealed(source.envelope, lim)
    if (!sealed) {
      decodeEnvelope(source.envelope, lim) // throws on malformed / non-canonical
      if (source.manifest) decodeManifest(source.manifest, lim)
    }

    const response: Response = {
      id,
      ok: true,
      source: {
        envelope: source.envelope,
        blobs: [...source.blobs.entries()]
      },
      sealed
    }
    if (source.manifest) response.source.manifest = source.manifest
    if (source.program) response.source.program = source.program
    if (source.manifestEnc) response.source.manifestEnc = source.manifestEnc
    if (source.programEnc) response.source.programEnc = source.programEnc
    parentPort.postMessage(response)
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    const response: Response = { id, ok: false, reason }
    parentPort.postMessage(response)
  }
})
