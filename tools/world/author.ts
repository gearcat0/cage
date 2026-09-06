// Making things, and handing them to people.
//
// Authoring here is the shell's own authoring: format.buildBundle signed by the
// account's real Keyring signer. Delivery mirrors main.ts's ingestBytes —
// admit, store, seed — with one deliberate difference noted below.

import {
  admitBundle,
  buildBundle,
  cosignBundle,
  parseBundle,
  jsToCbor,
  type CborValue
} from '../../src/format/index.js'
import type { OpenAccount } from './account.js'
import { sampleProgram } from './account.js'

/** Args are written as ordinary JS and converted with the SAME jsToCbor the
 *  shell uses when it signs a draft, so anything expressible here is
 *  expressible in the app -- and anything it rejects (floats, -0) is rejected
 *  here too rather than producing a bundle the app could not have made. */
export function args(value: unknown): CborValue {
  return jsToCbor(value)
}

export interface AuthorOptions {
  type: string
  args?: unknown
  /** Defaults to samples/<type>.html. */
  program?: Uint8Array
  attachments?: Map<string, { bytes: Uint8Array; mime?: string }>
  /** Unix SECONDS. An author claim, and the field that makes two otherwise
   *  identical things distinct -- so scenario content should vary it. */
  created?: number
}

/** Build a signed bundle as `who`. Returns the tar bytes; delivery is separate
 *  because who receives a thing is a separate question from who made it. */
export async function author(who: OpenAccount, opts: AuthorOptions): Promise<Uint8Array> {
  const program = opts.program ?? sampleProgram(opts.type)
  return buildBundle(who.signer, {
    program,
    type: opts.type,
    args: opts.args === undefined ? null : args(opts.args),
    ...(opts.attachments ? { attachments: opts.attachments } : {}),
    ...(opts.created === undefined ? {} : { created: opts.created })
  })
}

/** Sign a document somebody else already signed: a second envelope over the
 *  SAME manifest bytes, taken verbatim from their bundle. */
export async function cosign(who: OpenAccount, originalTar: Uint8Array, created?: number): Promise<Uint8Array> {
  const parts = parseBundle(originalTar)
  if (!parts.manifest || !parts.program) throw new Error('cosign: that bundle has no manifest or program')
  return cosignBundle(who.signer, {
    manifestBytes: parts.manifest,
    program: parts.program,
    blobs: parts.blobs,
    ...(created === undefined ? {} : { created })
  })
}

export interface Delivered {
  envelopeHash: string
  manifestHash: string
}

/** Admit a bundle into each recipient's library, exactly as receiving it would.
 *
 *  This mirrors ingestBytes (main.ts): admit, store, seed. The one difference
 *  is that admission runs INLINE rather than in the isolated utilityProcess.
 *  That isolation exists to contain hostile parsing; these bundles were built
 *  two lines ago by us. Anything arriving from outside the harness still meets
 *  the real gate in the real app.
 *
 *  Everything downstream comes free from library.store(): refs (replyTo,
 *  attests), the vouches table, doc_signers, and fork detection. */
export function deliver(tar: Uint8Array, to: OpenAccount[], receivedAt = Date.now()): Delivered {
  const result = admitBundle(parseBundle(tar))
  if (result.status !== 'valid') {
    throw new Error(`the harness built a bundle its own gate rejected: ${JSON.stringify(result)}`)
  }
  let envelopeHash = ''
  let manifestHash = ''
  for (const account of to) {
    const stored = account.library.store(result, receivedAt)
    envelopeHash = stored.envelopeHash
    // Seed the raw bundle so Share/Export works on it in the GUI.
    account.seeds.put(tar)
    const row = account.library.get(stored.envelopeHash)
    if (row) manifestHash = row.manifestHash
  }
  return { envelopeHash, manifestHash }
}

/** Author and deliver in one step, to the author plus anyone else. */
export async function publish(
  who: OpenAccount,
  opts: AuthorOptions,
  to: OpenAccount[] = []
): Promise<Delivered & { tar: Uint8Array }> {
  const tar = await author(who, opts)
  const recipients = to.includes(who) ? to : [who, ...to]
  return { ...deliver(tar, recipients), tar }
}

/** What YOU call a key. Local to each library, never inside a thing. */
export function introduce(knower: OpenAccount, known: OpenAccount, note = ''): void {
  knower.library.setPetname('eth-eip191', known.who.address, known.who.name, note, Date.now())
}
