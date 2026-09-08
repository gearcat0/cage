import { TransportError, type FetchLimits, type Transport } from './index.js'

// `https://…` / `http://…` — fetch a bundle from a web server. A `.thing` sitting
// at a URL is the most ordinary way to hand one to somebody, and it was the last
// gap in the transport set.
//
// Content-untrusted like every transport: admission re-verifies the signature and
// every hash over the received bytes, so a server cannot make the shell admit
// anything. What it CAN do is spend the shell's resources, so this is bounded on
// every axis it controls -- size (while streaming, not on its word), time, and
// the number of times it may bounce us somewhere else.
//
// The honest limit, which the chrome says out loud: a URL is not
// content-addressed. `bundle:<sha256>` names the bytes it wants and the service
// checks them; a URL names a PLACE, and you get whatever is there. Admission
// proves that what arrived is a validly signed thing -- not that it is the thing
// you meant to fetch. The author shown in the header is the answer to that, and
// it is why the shell shows it.

/** Enough for the http→https and bare→www hops real servers use, and few
 *  enough that a redirect loop ends quickly. */
const MAX_REDIRECTS = 5

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export class HttpTransport implements Transport {
  supports(locator: string): boolean {
    return isHttpUrl(locator)
  }

  async fetch(locator: string, limits: FetchLimits): Promise<Uint8Array> {
    // The service applies its own timeout as a backstop, but a fetch that is
    // merely abandoned leaves the socket open. Aborting is what actually stops
    // the transfer.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs)
    timer.unref?.()
    try {
      return await this.follow(locator, limits, controller.signal)
    } catch (e) {
      if (controller.signal.aborted) throw new TransportError(`http: timed out after ${limits.timeoutMs}ms`)
      if (e instanceof TransportError) throw e
      throw new TransportError(`http: ${(e as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Follow redirects OURSELVES rather than letting fetch do it, so each hop is
   *  counted and its scheme re-checked. A server must not be able to bounce a
   *  fetch out of http(s) entirely. */
  private async follow(start: string, limits: FetchLimits, signal: AbortSignal): Promise<Uint8Array> {
    let url = start
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url, {
        redirect: 'manual',
        signal,
        // Nothing ambient travels with this: no cookies, no credentials. A
        // bundle is public bytes, and a fetch the human asked for should not
        // carry anything they did not.
        credentials: 'omit',
        headers: { accept: '*/*' }
      })

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new TransportError(`http: ${res.status} with no location`)
        const next = new URL(location, url).toString()
        if (!isHttpUrl(next)) {
          throw new TransportError(`http: refused a redirect to a non-http(s) location`)
        }
        // Drain, so the connection is not left half-read.
        await res.arrayBuffer().catch(() => undefined)
        url = next
        continue
      }

      if (!res.ok) throw new TransportError(`http: ${res.status} ${res.statusText}`.trim())

      // Content-Length is a claim. It is worth an EARLY refusal when it is
      // honest and too large, but the real enforcement is below, on the bytes
      // that actually arrive.
      const declared = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        throw new TransportError(`http: response declares ${declared} bytes, over maxBytes (${limits.maxBytes})`)
      }
      // Deliberately no content-type check. Servers label `.thing` files every
      // way imaginable, and the bytes are validated by admission regardless --
      // refusing on a label would reject good bundles and admit nothing extra.
      return await readCapped(res, limits.maxBytes)
    }
    throw new TransportError(`http: too many redirects (over ${MAX_REDIRECTS})`)
  }
}

/** Read the body, giving up the moment it exceeds the cap.
 *
 *  Buffering first and measuring afterwards would let a server spend the
 *  shell's memory before being refused, which is the whole point of having a
 *  cap. This stops mid-stream. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const body = res.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        throw new TransportError(`http: response exceeds maxBytes (${maxBytes})`)
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}
