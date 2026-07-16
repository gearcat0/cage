import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Fail fast with a clear message if the app hasn't been built. `pnpm test:cage`
// builds first; running `playwright test` directly might not.
export default function globalSetup(): void {
  const main = join(__dirname, '..', 'out', 'main', 'index.js')
  if (!existsSync(main)) {
    throw new Error(
      `Build missing: ${main}\nRun "pnpm build" first (or use "pnpm test:cage", which builds).`
    )
  }
}
