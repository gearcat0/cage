import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Fail fast with a clear message if the app hasn't been built, and generate the
// binary attachment fixtures the phase-2 tests feed through admission-lite.
// Fixtures are generated (not checked in) so the repo carries no binaries.

export const FIXTURES_DIR = join(__dirname, 'fixtures')

/** A valid 1x1 red PNG. Chromium decodes it; naturalWidth === 1. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** A valid PCM WAV: mono, 8 kHz, 16-bit, ~2 s of a 440 Hz tone. Chromium's
 *  media stack plays WAV natively and requests it with `Range: bytes=0-`,
 *  which is exactly what the range-support test needs to observe. */
function makeWav(): Buffer {
  const sampleRate = 8000
  const seconds = 2
  const numSamples = sampleRate * seconds
  const dataSize = numSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // PCM format
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < numSamples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.25 * 32767)
    buf.writeInt16LE(v, 44 + i * 2)
  }
  return buf
}

export default function globalSetup(): void {
  const main = join(__dirname, '..', 'out', 'main', 'index.js')
  if (!existsSync(main)) {
    throw new Error(
      `Build missing: ${main}\nRun "pnpm build" first (or use "pnpm test:cage", which builds).`
    )
  }

  mkdirSync(FIXTURES_DIR, { recursive: true })
  const png = join(FIXTURES_DIR, 'poster.png')
  if (!existsSync(png)) writeFileSync(png, PNG_1X1)
  const wav = join(FIXTURES_DIR, 'tone.wav')
  if (!existsSync(wav)) writeFileSync(wav, makeWav())
}
