import { createServer, type Server } from 'node:http'
import { createSocket, type Socket } from 'node:dgram'
import type { AddressInfo } from 'node:net'

// ── The canary ───────────────────────────────────────────────────────────────
// A local listener that must NEVER receive a connection. It is the out-of-sandbox
// witness: the escape suite hands each malicious thing these URLs (via the
// bridge's getArgs) and then asserts, from OUTSIDE the renderer, that not a
// single TCP socket, HTTP request, WebSocket upgrade, or UDP datagram ever
// arrived. If the cage leaks, the canary sees it — no matter what the page's own
// error callbacks claim.
//
// One TCP listener catches fetch / XHR / <img> / <script src> / sendBeacon /
// EventSource / WebSocket (they all open a socket first). One UDP listener
// catches WebRTC STUN binding requests.

export interface CanaryHit {
  transport: 'tcp' | 'http' | 'ws' | 'udp'
  detail: string
  at: number
}

export interface Canary {
  /** http://127.0.0.1:<port> — for fetch/XHR/img/script/beacon/EventSource. */
  http: string
  /** ws://127.0.0.1:<port> — same port, for WebSocket. */
  ws: string
  /** stun:127.0.0.1:<udpPort> — for WebRTC. */
  stun: string
  udpPort: number
  /** Everything the canary saw. Should stay empty. */
  hits: CanaryHit[]
  /** True iff nothing ever connected. */
  silent(): boolean
  reset(): void
  close(): Promise<void>
}

export async function startCanary(): Promise<Canary> {
  const hits: CanaryHit[] = []
  // We deliberately do NOT stamp with Date.now() at module scope; hits are rare
  // and only their existence matters, but a timestamp helps debugging a breach.
  const stamp = (): number => performance.now()

  const server: Server = createServer((req, res) => {
    hits.push({ transport: 'http', detail: `${req.method} ${req.url}`, at: stamp() })
    res.writeHead(204)
    res.end()
  })
  // Any raw TCP connection (including a WebSocket handshake) is a breach.
  server.on('connection', (sock) => {
    hits.push({ transport: 'tcp', detail: `${sock.remoteAddress}:${sock.remotePort}`, at: stamp() })
  })
  server.on('upgrade', (req, sock) => {
    hits.push({ transport: 'ws', detail: `${req.method} ${req.url}`, at: stamp() })
    sock.destroy()
  })

  const udp: Socket = createSocket('udp4')
  udp.on('message', (msg, rinfo) => {
    hits.push({ transport: 'udp', detail: `${rinfo.address}:${rinfo.port} (${msg.length}b)`, at: stamp() })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))

  const port = (server.address() as AddressInfo).port
  const udpPort = udp.address().port

  return {
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    stun: `stun:127.0.0.1:${udpPort}`,
    udpPort,
    hits,
    silent() {
      return hits.length === 0
    },
    reset() {
      hits.length = 0
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await new Promise<void>((resolve) => udp.close(() => resolve()))
    }
  }
}
