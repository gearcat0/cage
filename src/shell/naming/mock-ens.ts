import { normalizeKey, type EnsClient } from './index.js'

// An in-memory EnsClient for deterministic tests — no network. Given fixed
// forward (name→address), reverse (address→name), and text (name→{key:value})
// maps, it lets the trust property be tested exhaustively: a resolver that
// returns a wrong/mismatched address, a spoofed reverse record, an unknown name.

export interface MockEnsData {
  /** name -> 0x-address (or bare hex). */
  forward?: Record<string, string>
  /** address -> primary name (reverse record; may be a spoof if forward disagrees). */
  reverse?: Record<string, string>
  /** name -> { textKey: value }. */
  text?: Record<string, Record<string, string>>
}

export function createMockEnsClient(data: MockEnsData): EnsClient {
  const forward = data.forward ?? {}
  const reverse = data.reverse ?? {}
  const text = data.text ?? {}
  const rev: Record<string, string> = {}
  for (const [addr, name] of Object.entries(reverse)) rev[normalizeKey(addr)] = name

  return {
    async getAddress(name: string): Promise<string | null> {
      return forward[name] ?? null
    },
    async getName(address: string): Promise<string | null> {
      return rev[normalizeKey(address)] ?? null
    },
    async getText(name: string, key: string): Promise<string | null> {
      return text[name]?.[key] ?? null
    }
  }
}
