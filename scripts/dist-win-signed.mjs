// Build and sign the Windows installer on the maintainer's machine.
//
//   1. Log in to SimplySign Desktop (the code comes from the SimplySign phone
//      app). The certificate then appears in the Windows certificate store for
//      about two hours.
//   2. $env:SOUSPLI_WIN_CERT_SHA1 = '<the certificate thumbprint>'
//   3. pnpm dist:win:signed
//
// Signing happens INSIDE electron-builder, so latest.yml's sha512 describes the
// signed installer. Signing a finished build afterwards would change its hash
// and every installed copy would reject the update.
//
// This refuses to run unless the build can be verified the way the updater
// verifies it, and checks the result before you upload anything.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'

const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

if (process.platform !== 'win32') fail('Run this on Windows, logged in to SimplySign Desktop.')

// Quotes and spaces are dropped: cmd.exe keeps `set X='…'`'s quotes in the value.
const thumb = (process.env.SOUSPLI_WIN_CERT_SHA1 ?? '').replace(/[\s'"]/g, '').toUpperCase()
if (!/^[0-9A-F]{40}$/.test(thumb)) {
  fail(
    'Set SOUSPLI_WIN_CERT_SHA1 to the certificate thumbprint (40 hex characters).\n' +
      "  PowerShell: Get-ChildItem Cert:\\CurrentUser\\My | Format-List Subject, Thumbprint"
  )
}

// Without a real publisherName, electron-updater 6.x silently skips checking
// who signed an update. Never ship that.
const yml = readFileSync('electron-builder.yml', 'utf8')
const publisher = /^\s*publisherName:\s*(.+?)\s*$/m.exec(yml)?.[1]?.replace(/^['"]|['"]$/g, '')
if (!publisher || publisher.startsWith('REPLACE_WITH')) {
  fail('Set win.signtoolOptions.publisherName in electron-builder.yml to the certificate subject CN.')
}

// One command string through the shell (pnpm is pnpm.cmd on Windows, which
// Node only runs via a shell). Everything in it is fixed or validated above.
const run = (command) => {
  const r = spawnSync(command, { stdio: 'inherit', shell: true })
  if (r.status !== 0) fail(`${command} failed`)
}

// electron-builder never clears release/, so an older version's installer would
// sit beside the new one and could be uploaded by mistake (v0.1.1 once shipped
// with 0.1.0's .exe next to 0.1.1's latest.yml, and updates 404ed). Clear the
// previous build's upload candidates first.
if (existsSync('release')) {
  for (const f of readdirSync('release')) {
    if (/\.(exe|blockmap)$/.test(f) || f === 'latest.yml') rmSync(`release/${f}`)
  }
}

run('pnpm build')
run(`pnpm exec electron-builder --win --publish never -c.win.signtoolOptions.certificateSha1=${thumb}`)

// Check the installer the way NsisUpdater will: a valid, timestamped signature
// from the configured publisher.
const exe = readdirSync('release').find((f) => /^Souspli-.*-win-x64\.exe$/.test(f))
if (!exe) fail('No installer found in release/.')
const ps = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-Command',
    `$s = Get-AuthenticodeSignature 'release\\${exe}'; ` +
      `"$($s.Status)|$($s.SignerCertificate.Subject)|$([bool]$s.TimeStamperCertificate)"`
  ],
  { encoding: 'utf8' }
)
const [status, subject, stamped] = ps.stdout.trim().split('|')
if (status !== 'Valid') fail(`Signature status is ${status || 'unknown'}, not Valid.`)
if (!subject.includes(`CN=${publisher}`)) fail(`Signed by "${subject}", but publisherName is "${publisher}".`)
if (stamped !== 'True') fail('The signature has no timestamp; it would stop verifying when the cert expires.')

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
console.log(`\n✓ ${exe} is signed by ${subject}, timestamped.\n`)
console.log('Attach it to the draft release:')
console.log(`  gh release upload v${version} "release/${exe}" "release/${exe}.blockmap" release/latest.yml\n`)
