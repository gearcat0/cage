import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ── Architecture boundary (brief §Architecture) ─────────────────────────────
// The cage imports NOTHING from the shell and NOTHING from format. The cage is
// format-agnostic and independently auditable; the shell is the only place that
// knows about both. This project's whole pitch is architecture enforcing
// guarantees rather than trusting people to remember — so enforce it on our own
// module graph, in CI.

const ROOT = join(__dirname, '..', '..')

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    const s = statSync(join(ROOT, rel))
    if (s.isDirectory()) tsFiles(rel, out)
    else if (name.endsWith('.ts')) out.push(rel)
  }
  return out
}

function importsOf(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const specs: string[] = []
  const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) specs.push(m[1] ?? m[2] ?? '')
  return specs.filter(Boolean)
}

/** The CAGE — the parts that must stay format- and shell-agnostic. */
const CAGE_DIRS = ['src/main', 'src/preload']

describe('module boundary: the cage imports neither shell nor format', () => {
  const cageFiles = CAGE_DIRS.flatMap((d) => tsFiles(d))

  it('has cage files to check', () => {
    expect(cageFiles.length).toBeGreaterThan(0)
  })

  for (const file of CAGE_DIRS.flatMap((d) => tsFiles(d))) {
    it(`${file} imports no shell/format code`, () => {
      const bad = importsOf(file).filter(
        (spec) =>
          spec.includes('/shell/') ||
          spec.includes('/format/') ||
          spec.endsWith('/shell') ||
          spec.endsWith('/format') ||
          spec.includes('@yourproject/format')
      )
      expect(bad, `forbidden imports in ${file}: ${bad.join(', ')}`).toEqual([])
    })
  }
})
