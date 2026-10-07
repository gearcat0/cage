import { deflateSync, crc32 } from 'node:zlib'

// ── Pictures for the world ───────────────────────────────────────────────────
// The scenario needs real image bytes: an article that wraps text around a
// photograph exercises a different path from one that is all prose, and a
// poster with no picture is not a poster.
//
// Generated rather than committed. A binary blob in the repo is a thing nobody
// can review and everybody has to carry, and the samples only need something
// that decodes and has recognisable shapes in it. The encoder below is a minimal
// one, written for exactly that.

type RGB = [number, number, number]

/** A minimal PNG writer: 8-bit RGBA, one IDAT, no interlacing. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // Each scanline is prefixed with its filter byte; 0 is "none", which costs a
  // little size and saves implementing the filters.
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t)
]

/** A dusk skyline: graded sky, water, and a few silhouettes. Deterministic, so
 *  a rebuilt world produces byte-identical attachments and therefore the same
 *  hashes. */
export function skyline(width = 720, height = 460): Buffer {
  const buf = Buffer.alloc(width * height * 4)
  const top: RGB = [24, 32, 54]
  const horizon: RGB = [198, 118, 72]
  const water: RGB = [16, 22, 34]
  const ink: RGB = [9, 12, 18]
  const skyline = Math.round(height * 0.62)

  const put = (x: number, y: number, c: RGB): void => {
    const i = (y * width + x) * 4
    buf[i] = c[0]
    buf[i + 1] = c[1]
    buf[i + 2] = c[2]
    buf[i + 3] = 255
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < skyline) {
        put(x, y, mix(top, horizon, (y / skyline) ** 1.6))
      } else {
        // Water, with the sunset smeared into horizontal bands.
        const d = (y - skyline) / (height - skyline)
        const band = Math.sin(y * 0.9) * 0.06
        put(x, y, mix(mix(horizon, water, Math.min(1, d * 1.8 + band)), water, d * 0.5))
      }
    }
  }

  // Buildings, then a crane over on the right — the Harbour Yard motif.
  const blocks: [number, number, number][] = [
    [40, 150, 120],
    [130, 90, 180],
    [190, 200, 90],
    [300, 120, 140],
    [400, 170, 110],
    [470, 80, 200],
    [530, 140, 130]
  ]
  for (const [x0, w, h] of blocks) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      for (let y = skyline - h; y < skyline; y++) if (y >= 0) put(x, y, ink)
    }
    // A few lit windows.
    for (let wy = skyline - h + 12; wy < skyline - 8; wy += 22) {
      for (let wx = x0 + 8; wx < Math.min(width, x0 + w) - 8; wx += 26) {
        if ((wx * 7 + wy * 13) % 5 === 0) continue
        for (let y = wy; y < wy + 7; y++) for (let x = wx; x < wx + 9; x++) put(x, y, [226, 178, 96])
      }
    }
  }
  const craneX = 620
  for (let y = skyline - 250; y < skyline; y++) for (let x = craneX; x < craneX + 8; x++) put(x, y, ink)
  for (let x = craneX - 90; x < craneX + 60; x++) {
    for (let y = skyline - 250; y < skyline - 238; y++) put(x, y, ink)
  }
  for (let y = skyline - 238; y < skyline - 190; y++) put(craneX - 70, y, ink)

  return encodePng(width, height, buf)
}

/** A plain field with a bold diagonal — enough to look like a printed poster
 *  without pretending to be a photograph. */
export function posterArt(width = 600, height = 800): Buffer {
  const buf = Buffer.alloc(width * height * 4)
  const a: RGB = [28, 35, 32]
  const b: RGB = [122, 159, 111]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2
      const stripe = ((x + y) % 160 < 18 ? 0.55 : 0) as number
      const c = mix(mix(a, b, t * 0.7), [230, 226, 214], stripe)
      const i = (y * width + x) * 4
      buf[i] = c[0]
      buf[i + 1] = c[1]
      buf[i + 2] = c[2]
      buf[i + 3] = 255
    }
  }
  return encodePng(width, height, buf)
}

/** Bytes that compress badly, for making a bundle big on purpose. Used to push
 *  a thing over the relay's inline cap so it has to travel as a pointer. */
export function ballast(bytes: number): Buffer {
  const out = Buffer.alloc(bytes)
  // A cheap deterministic PRNG: incompressible enough, and identical on every
  // rebuild so the world's hashes do not move.
  let x = 0x2545f491
  for (let i = 0; i < bytes; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}
