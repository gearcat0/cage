import { NamingError, type EnsClient } from './index.js'

// A viem-backed EnsClient for LIVE ENS resolution against an RPC. Loaded lazily
// (like webtorrent): viem is an optional dep, so this degrades with a clear
// "install viem" error rather than crashing if absent. Exercised MANUALLY, not
// in CI — every test uses the in-memory mock client instead.
//
// LATER: caching / TTL for resolutions; a light-client path that verifies ENS
// on-chain rather than trusting the RPC.

export async function createViemEnsClient(rpcUrl?: string): Promise<EnsClient> {
  // Non-literal specifiers keep these opaque runtime dynamic imports, so tsc/
  // vite need not resolve `viem` at build (it is optional/uninstalled here).
  let viem: Record<string, unknown>
  let chains: Record<string, unknown>
  let ens: Record<string, unknown>
  try {
    const vmod = 'viem'
    const cmod = 'viem/chains'
    const emod = 'viem/ens'
    viem = (await import(vmod)) as Record<string, unknown>
    chains = (await import(cmod)) as Record<string, unknown>
    ens = (await import(emod)) as Record<string, unknown>
  } catch {
    throw new NamingError('viem is not installed — run `pnpm add viem` to enable live ENS resolution')
  }
  const createPublicClient = viem.createPublicClient as (opts: unknown) => EnsViemClient
  const http = viem.http as (url?: string) => unknown
  const normalize = ens.normalize as (name: string) => string
  const client = createPublicClient({ chain: chains.mainnet, transport: http(rpcUrl) })

  return {
    async getAddress(name: string): Promise<string | null> {
      return (await client.getEnsAddress({ name: normalize(name) })) ?? null
    },
    async getName(address: string): Promise<string | null> {
      return (await client.getEnsName({ address: address as `0x${string}` })) ?? null
    },
    async getText(name: string, key: string): Promise<string | null> {
      return (await client.getEnsText({ name: normalize(name), key })) ?? null
    }
  }
}

interface EnsViemClient {
  getEnsAddress(args: { name: string }): Promise<string | null | undefined>
  getEnsName(args: { address: `0x${string}` }): Promise<string | null | undefined>
  getEnsText(args: { name: string; key: string }): Promise<string | null | undefined>
}
