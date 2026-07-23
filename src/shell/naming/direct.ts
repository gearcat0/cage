import { NamingError, type Resolver } from './index.js'

// Direct locators are already locators — pass them through unchanged. They carry
// no human name, so they have no identity (a raw-hash author has no primaryName).
// This keeps direct-hash ingestion working with NO resolver in the room.

const DIRECT_SCHEMES = ['thing:', 'bundle:', 'magnet:', 'file:']

export class DirectResolver implements Resolver {
  handlesName(name: string): boolean {
    return DIRECT_SCHEMES.some((s) => name.startsWith(s))
  }

  async resolve(name: string): Promise<string> {
    if (!this.handlesName(name)) throw new NamingError(`not a direct locator: ${name.slice(0, 32)}`)
    return name
  }
  // No addressOf / reverseName: a raw locator has no name.
}
