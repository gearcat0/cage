# Security: threat model and evidence

This page says what Souspli claims, how each claim is tested, and what is *not*
covered. It is written to be argued with. To report a vulnerability, see
[SECURITY.md](../../../SECURITY.md).

## Status

The format and the container have been reviewed and adversarially tested **by their
authors**. There has been **no independent review** yet. Until there has, treat
every guarantee below as well-tested rather than proven, and do not rely on it for
anything that matters.

## Who is the adversary?

| Adversary | Can | Must not be able to |
|---|---|---|
| **A letter's author** — arbitrary hostile HTML/JS | run any code inside the container; draw anything in its rectangle | reach the network, persist anything, read files, learn who you are, see the envelope, forge or cover the header, sign anything as you |
| **Whoever delivers bytes** — a peer, a relay, a web server, a USB stick | send anything, at any rate, forever | get anything admitted that is not validly signed and hash-complete; crash or wedge the client; reach your key |
| **A relay** | see what you subscribe to and post; withhold or delay | make a letter appear to be by someone who did not sign it; make your machine fetch anything without a press |
| **A name resolver** | fail, or lie | attach a verified name to a key it does not provably map to |
| **Other readers** | hold and forward any letter they received, sealed or not | alter it, or read a sealed letter they were never sent |

**Out of scope:** malware already running as you on your machine (it can read your
files, including an identity stored in software mode); a compromised OS or Electron
build; traffic analysis of the transports you choose to use; and the *content* of a
letter being false. A signature proves who said something, never that it is so.

## The claims, and what tests them

### A letter cannot reach the network

Four independent layers ([container](container.md)). Tested by the **escape
battery**: `test/cage.spec.ts` drives one hostile page per attack from `test/things/`.
Each is handed — through the legitimate bridge — the address of a local **canary**
listening on TCP, HTTP, WebSocket and UDP, and tries to reach it: `fetch`, XHR,
WebSocket, EventSource, `sendBeacon`, image beacons, CSS exfiltration, injected
scripts, DNS prefetch, `data:` documents, WebRTC, iframes, navigation,
`window.open`, permission prompts, service workers and caches, another letter's
`thing://` id, and probing for Node or Electron globals. Further pages abuse the
bridge itself — floods, oversized and malformed drafts, the retired `publish`
channel, attempts to read the envelope.

The proof is taken **from outside the page**: the main-process event log and the
canary's own silence. A page's own error callbacks are secondary evidence only. The
run ends with one line per attack and `CAGE HOLDS n/n attempts blocked`.

### A letter cannot forge or cover the trusted header

The header is a separate native view. A geometry assertion in the escape battery,
plus a pixel-level test (`test/shell/chrome.spec.ts`): a letter that floods its
viewport and paints a fake "✓ signed" badge leaves the real badge intact and its own
colour absent from a capture of the header.

### A letter cannot persist or correlate

Each mount gets a fresh in-memory session partition. Tested by storage-bleed attacks
across mounts.

### Hostile bundles cannot compromise or wedge the client

Structural decoding happens in a disposable process with no keys, under hard limits
([admission](admission.md)). Tested: tar bombs, oversize input, non-canonical CBOR,
worker death and worker hang — the bundle is refused and the client carries on, key
intact. 41 [conformance vectors](../protocol/conformance.md) pin the accept/reject
boundary.

### Transports, relays and resolvers add reach, never authority

Verify-at-the-gate batteries: a transport returning garbage, tampered, oversize or
never-ending bytes; a relay event whose poster is not the author; an offer whose
fetched letter is validly signed but is not the one advertised; a resolver that
points a name at the wrong key. Plus the negative properties: nothing is *posted*
unasked, and nothing is *fetched* unasked.

### Private material stays off disk

The private key never appears on disk in plaintext; a sealed letter's decrypted
content is never written to disk. Both are tested by searching the profile directory
after the fact.

## The part we are careful not to overstate: the OS sandbox

Layer 1 includes Chromium's OS-level process sandbox — the backstop against a
renderer *memory-corruption* exploit. None of the behavioural guarantees above depend
on it, and the escape battery does not attempt memory corruption.

Playwright launches Electron with `--no-sandbox` by default, so the battery runs with
that layer **off**. Rather than let a green wall imply otherwise:

- the app records the *measured* sandbox state at startup;
- a `harness integrity` test reads it back and **fails** a no-sandbox run unless
  that is explicitly acknowledged;
- the banner prints it: `OS SANDBOX: OFF — Layer 1 not exercised; --no-sandbox`;
- a static test (`test/unit/hardening.test.ts`) guards every Layer 1 flag, because no
  behavioural test can catch a refactor that drops `sandbox: true` — they all pass
  with it off.

In a normal install on a normal desktop the OS sandbox is on. Details:
[design note](../../design-notes/sandbox.md).

## Principle for the test suite

> A green suite does not distinguish "the guarantee holds" from "the test passes for
> the wrong reason."

Several rounds of internal review were spent on exactly that: making assertions
observe something real, and checking each new test for the way it could pass
falsely. The record is in the [design notes](../../design-notes/security-review-round2.md).

## Known weaknesses

Stated in the [specification §10](../protocol/spec.md) and on the
[status page](../../use/status.md). The ones with security weight:

- **No key rotation or revocation.** A stolen key signs as you indefinitely.
- **Software key storage** where no OS keychain exists is obfuscation, not protection.
- **A seal is not access control.** Any recipient can forward a sealed letter.
- **Sealed attachments are linkable.** Two sealed copies of the same attachment share
  ciphertext.
- **`type` is untrusted** and exists anyway; any field that must not be trusted will
  eventually be trusted by someone.
- **Feed titles are author-supplied text in trusted territory.** Sanitised, plain
  text, visibly secondary and never able to carry a ✓ — but still a sentence a
  stranger chose, sitting next to a verified author. Treat it like a subject line.
- **Votes are signed without a confirmation dialog**, on the grounds that the control
  is in the trusted header. If a program could ever cause a vote to be cast, that is
  where it would break.
- **Ranking can fall back to forgeable raw counts** when you have vouched for nobody.
  The interface says so; any path where it does not is a bug.
- **Updates trust the release, not a second signature.** An update installs only if
  its hash matches the release's feed file and, on macOS and Windows, it is signed
  by the project's certificate. The Linux AppImage has the hash check alone, so
  whoever can publish a GitHub Release can ship a Linux update. The macOS signing
  key lives in the repository's protected `release` environment; the Windows key
  never leaves the maintainer's SimplySign login.
