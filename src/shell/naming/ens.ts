import { NamingError, normalizeKey, type EnsClient, type Resolver } from './index.js'

// ENS resolver. Matches `eth-eip191`: an ENS name resolves to a 20-byte address,
// which is exactly `author.k` for an eth-signed thing.
//   - addressOf(name)    → getAddress → { scheme: 'eth-eip191', keyHex }
//   - reverseName(key)   → getName, then FORWARD-CONFIRM getAddress(name)==key
//   - resolve(name)      → the `thing` text record (a locator to fetch)
// The reads go through an injected EnsClient (viem in production, a mock in
// tests), so the whole trust property is deterministic without a network.

const ENS_SCHEME = 'eth-eip191'
const THING_TEXT_KEY = 'thing'

export class EnsResolver implements Resolver {
  constructor(private readonly client: EnsClient) {}

  handlesName(name: string): boolean {
    // A bare ENS name: labels separated by dots, ending in a TLD like `.eth`.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name) && name.endsWith('.eth')
  }

  async resolve(name: string): Promise<string> {
    const locator = await this.client.getText(name, THING_TEXT_KEY)
    if (!locator) throw new NamingError(`ENS name has no \`${THING_TEXT_KEY}\` locator: ${name}`)
    return locator
  }

  async addressOf(name: string): Promise<{ scheme: string; keyHex: string } | null> {
    const addr = await this.client.getAddress(name)
    if (!addr) return null
    return { scheme: ENS_SCHEME, keyHex: normalizeKey(addr) }
  }

  async reverseName(scheme: string, keyHex: string): Promise<string | null> {
    if (scheme !== ENS_SCHEME) return null
    const address = `0x${normalizeKey(keyHex)}`
    const name = await this.client.getName(address)
    if (!name) return null
    // FORWARD-CONFIRM: a reverse record alone is spoofable. The name must
    // forward-resolve back to this exact address, or we do not return it.
    const forward = await this.client.getAddress(name)
    if (!forward || normalizeKey(forward) !== normalizeKey(keyHex)) return null
    return name
  }
}
