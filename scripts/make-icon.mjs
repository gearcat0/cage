// Generate a placeholder app icon (build/icon.png, 1024×1024 RGBA) with no
// external image tooling — a tiny hand-rolled PNG encoder over zlib. The motif:
// a dark field with a teal rounded-square "cage" frame (evm-ui accent). Replace
// with real artwork before a public release; this just gives the installers a
// non-default icon.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { crc32 } from 'node:zlib'

const S = 1024
const buf = Buffer.alloc(S * S * 4)

// evm-ui-ish palette.
const BG = [8, 8, 10] // near-black field
const TEAL = [45, 212, 191] // accent frame
const TEAL_DIM = [17, 94, 89] // inner glow

const px = (x, y, [r, g, b], a = 255) => {
  const i = (y * S + x) * 4
  buf[i] = r
  buf[i + 1] = g
  buf[i + 2] = b
  buf[i + 3] = a
}

// Rounded-square frame: draw the field, then a ring between outer and inner
// rounded rects.
const margin = 150
const thick = 90
const radius = 170
const inOuter = (x, y, m, rad) => {
  const lo = m
  const hi = S - 1 - m
  if (x < lo || x > hi || y < lo || y > hi) return false
  // rounded corners
  const cx = x < lo + rad ? lo + rad : x > hi - rad ? hi - rad : x
  const cy = y < lo + rad ? lo + rad : y > hi - rad ? hi - rad : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= rad * rad
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const outer = inOuter(x, y, margin, radius)
    const inner = inOuter(x, y, margin + thick, radius - thick / 2)
    if (outer && !inner) {
      // frame ring — brighten toward the outer edge for a subtle bevel
      px(x, y, TEAL)
    } else if (inner) {
      // interior: dim teal wash
      px(x, y, TEAL_DIM, 40)
      // re-lay the field under the wash so it isn't transparent
      const i = (y * S + x) * 4
      buf[i] = Math.round(BG[0] * 0.8 + TEAL_DIM[0] * 0.2)
      buf[i + 1] = Math.round(BG[1] * 0.8 + TEAL_DIM[1] * 0.2)
      buf[i + 2] = Math.round(BG[2] * 0.8 + TEAL_DIM[2] * 0.2)
      buf[i + 3] = 255
    } else {
      px(x, y, BG)
    }
  }
}

// Two horizontal "bars" across the interior — the cage.
const barColor = TEAL
for (const fy of [0.42, 0.58]) {
  const y0 = Math.round(S * fy) - 14
  for (let y = y0; y < y0 + 28; y++) {
    for (let x = margin + thick + 10; x < S - margin - thick - 10; x++) {
      if (inOuter(x, y, margin + thick, radius - thick / 2)) px(x, y, barColor)
    }
  }
}

// ── minimal PNG writer ───────────────────────────────────────────────────────
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
// filter type 0 per scanline
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log(`wrote build/icon.png (${S}×${S}, ${png.length} bytes)`)
