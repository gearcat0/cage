# Security review round 2 — resolution

This records how the carried-over review findings were resolved on the
`phase-2-bridge` branch. Sources: `CAGE_REMEDIATION.md` (round 1) and
`CAGE_REVIEW_ROUND2.md` (round 2, authoritative where they conflict), plus the
line-level PR-review checklist in `CODE_SESSION_HANDOFF.md`.

Guiding principle throughout: **a green suite and an accurate-sounding
description do not distinguish "the guarantee holds" from "the test passes for
the wrong reason."** Several fixes here are "make the assertion observe
something real," and each new test was checked for the false-pass class it could
belong to.

**Status:** all findings addressed except N6 (deliberately kept as the geometry
assertion — see below). Suite: **39 Playwright + 46 unit, green**; both
typecheck projects clean. The green-wall banner now states the OS-sandbox status
(`OS SANDBOX: OFF — Layer 1 not exercised; --no-sandbox` under Playwright).

---

## P0 — harness integrity

### P0-1 — OS-sandbox honesty (`8b…`/`7e1babb`)
The suite ran with the OS sandbox **off** (Playwright's `_electron.launch`
injects `--no-sandbox` by default) while the banner printed an unqualified
`CAGE HOLDS`. Fixed so the wall can never overstate what was proven:
- The app records ground truth at startup as a `sandbox-state` event, detecting
  `--no-sandbox` via **both** `process.argv` and `app.commandLine.hasSwitch`.
  `process.argv` alone gave a false "ON" — the honest failure direction is to
  report OFF, so both signals are OR'd.
- `test/helpers.ts` scrubs `ELECTRON_DISABLE_SANDBOX` from the child env so it
  cannot be inherited from a shell/CI and silently weaken Layer 1.
- A `harness integrity` test reads the recorded state and **fails** a
  `--no-sandbox` run unless `CAGE_ALLOW_NO_SANDBOX=1` acknowledges it (set by
  `pnpm test:cage`). The reporter prints the status in the banner.
- `test/unit/hardening.test.ts` statically asserts every `webPreferences`
  Layer 1 flag and that the partition is non-persistent — the only guard against
  a refactor dropping `sandbox: true`, since every behavioral test passes with
  it off.
- README and the `helpers.ts` comment corrected to match reality.

### P0-3 — unbounded event log (`7e1babb`)
`record()` survives into the real shell and was an unbounded memory sink.
- `cage.events` is now a ring buffer (cap 2000) with a `dropped` counter.
- `emit` records store `channel + bytes + hash`, **never the payload**.
- The stderr mirror is capped (500 lines) and silent under `CAGE_QUIET=1`.
- Payloads needed for assertions moved to a separate, gated
  (`CAGE_TEST_CAPTURE=1`), bounded (count + per-entry bytes) **test-only**
  capture buffer.
- Flood tests rewritten to assert *boundedness*: a large-payload flood proves
  payloads are not retained (≈40 MB emitted, log stays tiny); an emit-count
  flood proves eviction deterministically (`dropped > 0`); a blocked-request
  flood proves the canceller path stays bounded and silent. Ring-buffer math is
  also unit-tested (`test/unit/events.test.ts`).

### P0-2 → P2 — WebRTC switches (`7e1babb`)
Round 1's "delete the switch" was wrong (round 2 corrected it). Both switches
kept; the comment now names each one's real effect —
`force-webrtc-ip-handling-policy` is the load-bearing control,
`disable-features=WebRtcHideLocalIpsWithMdns` is a companion that makes a
hypothetical breach *more* visible, not a disabler.

---

## P1 — decorative tests made load-bearing

### P1-4 — `net-thing-unknown` (`7e1babb`)
Both original vectors were hollow (a `supportFetchAPI:false` fetch and an image
to host `main`, which is a hostname miss). Now the index.html-route vector uses
the thing's **own** id with an unsupplied path, and a new cross-id test hands one
session another session's real id and proves it still 404s (per-session
registration).

### P1-5 / PR-review 1.1 — `parseThingUrl` traversal (`7e1babb`)
The old test asserted a fact about the WHATWG URL parser, leaving the
`path.includes('..')` guard dead code. New unit tests reject percent-encoded
traversal (`%2e%2e%2f`) that survives normalisation — removing the guard now
fails a test — and pin `att/` name decoding so the admitted **table**, not string
shape, is the gate.

### P1-6 — same-run storage race (`96bed84`)
The reader could pass because nothing had been written yet. The secondary cage
now mounts only after the primary's `write-done` emit (env-gated
`CAGE_AWAIT_PRIMARY_EMIT`), so a null read means "isolated". The race-free
launch-separated test is unchanged.

---

## New attacks (round 2)

### N1 (P1) — iframe / srcdoc (`fa78a68`)
`escalate-iframe.html` proves `frame-src 'none'` blocks `<iframe src=thing://>`
(observed via a `securitypolicyviolation`), and that a `srcdoc` child — the
historically-inconsistent case — has no `window.bridge`, no `require`, and a
silent canary fetch if it materialises at all. The child reports via
`postMessage`; the canary is the out-of-process witness.

### N2 (P1) — DNS / speculative connection (`fa78a68`)
`net-dns-prefetch.html` fires `dns-prefetch`, `preconnect`, `fetch`, and `img`
at an attacker **hostname**. The test maps that hostname straight at the canary
via `host-resolver-rules`, so any socket that leaked past the dead proxy /
`connect-src` would land on the canary. Nothing did. The canary also now decodes
DNS question names (`parseDnsQuestionName`) so a DNS datagram would be witnessed
by name.
- **Result:** no finding. The dead proxy + `connect-src` close the
  CSP-ungoverned speculative channels for hostname targets.
- **Residual (documented):** routing a *real* DNS datagram to an external
  resolver-shaped canary would need resolver reconfiguration this container does
  not allow. In the shipped config that channel is blocked by the dead-proxy
  delegation; the name-decoding canary is the regression witness if that ever
  changes.

### N3 (P2) — default-session egress (`fa78a68`)
The trusted chrome session's hardening had zero coverage. The test drives the
chrome `webContents` to fetch the canary and asserts it targeted the real canary,
did not resolve, and stayed silent — the default session blocks remote origins
even from trusted chrome.

### N4 (P2) — `data:` as a document (`fa78a68`)
A `data:` image resolves as a subresource (allowed), but `window.open` /
`location.assign` to a `data:text/html` document cannot become a document.
- **Note surfaced by the test:** top-level `data:` navigation is blocked by
  **Chromium itself**, before `will-navigate` fires — so there is (correctly) no
  `navigation-blocked` event for that vector. The test pins the *outcome*
  (stayed on `thing://`, `window.open` denied) rather than a mechanism; our
  `will-navigate` handler is defense in depth.

---

## P3 / lifecycle

### N5 / P3-10 / P3-11 (`7e1babb`)
`createCage` is now async and **awaits** `setProxy` (the layer whose job is
catching bypasses of the other layers must be installed before load).
`unbindCage` is wired to the `webContents` `destroyed` event, and the ephemeral
sealed store is cleared on teardown so decrypted plaintext does not outlive the
cage.

### N6 (P3) — chrome-spoof pixels — **kept as geometry assertion**
Reviewed and **deliberately left as-is.** The guarantee is architectural (the
chrome strip is a separate native `WebContentsView` sibling the thing has no
handle to), the review itself rated a pixel screenshot low priority, and the
geometry assertion is a cheap secondary check. A pixel-level screenshot via
`capturePage()` remains an option if desired later.

---

## PR-review checklist (CODE_SESSION_HANDOFF Part 1)

| Item | Outcome |
|---|---|
| 1.1 `att/` name validation | Verified in code; the table + hex-validated hash is the gate, thing input never reaches the filesystem. Unit-tested (P1-5). |
| 1.2 Range parser | Verified; parser unit tests + **response-level** tests asserting `Content-Range`, `Content-Length`, byte slice, 416, 404 (`0c4d1d2`). |
| 1.3 Sealed off disk | Strengthened: scans the CAS **and** Electron's userData tree for a magic marker, with a public-render control proving the scanner is not vacuous (`96bed84`). |
| 1.4 `getArgs` withholds envelope | Verified: test asserts the exact key set `{type, args, attachments}` and attachment rows carry only `{name, mime, size}` (no hash). |
| 1.5 `viewerInfo` coarse | Verified: test asserts the exact key set `{locale, colorScheme}`. |
| 1.6 `emit("publish")` caps | Verified: per-blob AND total-bytes AND count caps, all unit-tested; rejects record, grant nothing. |
| 1.7 Boundary hygiene | Verified: `protocol.ts` / `store.ts` / `cage.ts` import no bridge/draft/format code. |
| 1.8 Canary false-pass | Guarded: the image beacon reports the URL it targeted; the test asserts it was the real canary, so silence means "blocked", not "misfired" (`35c8638`). |

---

## What is genuinely good (for auditors)

Stated by round 2 and unchanged: five independent egress controls (scheme
registration + request canceller + CSP + dead proxy + per-contents WebRTC
policy); canary-verified-from-outside as the test philosophy; default-session
hardening that exceeds the brief; `Object.freeze` + exact-key-set surface tests;
`BaseWindow` + sibling `WebContentsView` for unspoofable chrome. None of the
findings were architectural — they were "make the tests observe what the
architecture already does."
