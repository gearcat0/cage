import { readFileSync, statSync } from 'node:fs'
import { TransportError, type FetchLimits, type Transport } from './index.js'

// `file:<absolute-path>` — read a bundle from local disk. Same bytes drag-drop
// and "open file" already ingest, reachable via a locator. Content-untrusted
// like every transport; admission is the gate. Size-bounded before reading.

export class FileTransport implements Transport {
  supports(locator: string): boolean {
    return locator.startsWith('file:')
  }

  async fetch(locator: string, limits: FetchLimits): Promise<Uint8Array> {
    const path = locator.slice('file:'.length)
    let size: number
    try {
      size = statSync(path).size
    } catch {
      throw new TransportError(`file not found: ${path}`)
    }
    if (size > limits.maxBytes) {
      throw new TransportError(`file exceeds maxBytes (${size} > ${limits.maxBytes})`)
    }
    return new Uint8Array(readFileSync(path))
  }
}
