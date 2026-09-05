# src/shell — the trusted client

The shell is the first component that inverts the cage's "nothing to steal"
posture: it holds the keyring, parses hostile bundles, and mounts admitted
things into cages. It is the trusted process with the crown jewels; its threat
model is "handle hostile input without being compromised, and never leak the
keys."

Everything is in this repo for now (the cage, format, and shell together) for
ease of testing; extraction into packages is a later `git mv`. The **dependency
rule is CI-enforced** (`test/unit/boundary.test.ts`): the cage
(`src/main`, `src/preload`) imports nothing from `src/shell` or `src/format`.
The shell is the only place that knows about all three.

## Internal boundaries

```
src/shell/
├── admission/   hostile-bundle handling. Structural decode (tar + CBOR under
│                caps, canonical validation) runs in an ISOLATED utilityProcess
│                (worker.ts) that holds no keys; signature verify + unseal run in
│                this process on the already-bounded output (index.ts).
├── keyring/     the ONLY code that touches private key bytes. Exposes Signer +
│                Unsealer interfaces; format/cage never receive key material.
│                Software key custody for now (LATER: OS-backed + hardware).
├── library/     SQLite index + content-addressed blob store. One row per
│                admitted envelope; RECEIVED-AT ordering (the reader owns order);
│                fork detection on same (author, path, seq) / different hash.
├── mount/       admitted thing → CageResources → createCage → bridge args →
│                view placed beneath the chrome. Reuses the cage library.
├── transport/   fetch bundle bytes by locator (file: / content-addressed
│                bundle: / magnet:), resource-bounded + content-untrusted —
│                admission is the gate. webtorrent wired behind the interface
│                (lazy import); admitted bundles are retained in a seed store.
├── naming/      name → author key (identity) + name → locator (discovery). A
│                name is shown as VERIFIED only when it provably maps to the
│                thing's signature-proven author key. ENS via an injected
│                EnsClient (viem for live, mock-tested); reverse+forward
│                confirmed. Direct locators pass through; Nostr stubbed.
├── chrome/      the trusted 3-pane renderer (omnibar, feed, per-thing trust
│                header, confirm dialogs). Vanilla TS + the evm-ui design
│                language (CSS tokens/classes, no framework). Every trust signal
│                lives in chrome pixels the thing cannot reach.
└── main.ts      bootstrap: window (chrome view + cage area), library, admission,
                 mount, ingestion, IPC, and the confirm flow.
```

## Trust integrity

The chrome renderer draws the feed, the per-thing header (author, signature
status, content hash), and every human-confirmation dialog. The thing renders
into a **separate native view** composited into the main-content area only, so
it cannot forge or overpaint the trust chrome. This is proven at the pixel level
(`test/shell/chrome.spec.ts`, the N6 test): a thing that floods its viewport and
paints a fake "✓ signed" badge leaves the chrome layer's real badge intact and
its own colour entirely absent from the chrome capture.

A thing's `emit("draft", …)` streams its working state: it grants nothing.
The shell renders it as the live preview, and the chrome **Publish** button
signs exactly the latest draft — after the human confirms in chrome, never
auto-granted. Programs cannot initiate a publish (`emit("publish")` is
retired); all controls live in trusted chrome.

## Ingestion & authoring

**Receive:** file / paste / drag / double-click a `.thing` / locator / name →
admission → library — the "flyer" property, transport-agnostic and
verify-at-the-gate. Double-clicking is just another transport: the bundle
still passes the same gate, and a second launch hands the file to the running
shell (single-instance lock) rather than opening a rival library.

**Author (New):** pick a known type — a built-in starter or any program
already in your library — and the shell starts a local, UNSIGNED draft that
autosaves as you edit and is consumed when you publish it. Drafts live in their
own feed section, never leave the machine, and their header says DRAFT, never
"signed". **New from HTML…** is the raw path: pick a self-contained HTML page (+ optional attachments) →
`format.buildBundle` signs it with the keyring `Signer` → a shareable `.thing`
saved via a native dialog, and admitted + seeded locally like any other thing (so
you see your own creation, and it is re-servable by `bundle:<hash>`). Authoring is
the mirror of admission and lives in `format`; the shell only supplies the
`Signer`. Public things only for now — sealed authoring is deferred with the rest
of sealing. Sharing this phase is **file handoff**; live P2P is the fast-follow.

**Export** writes the open thing to a `.thing` file you can carry anywhere.
Deliberately a byte-for-byte copy of the bundle as it was admitted, taken from
the seed store — never a rebuild, because `buildBundle` signs with the local
keyring and would therefore re-author the thing (someone else's would leave
over *your* signature; your own would arrive under a new envelope hash). So an
exported thing keeps its author, its signature, and its hash wherever it lands,
and a sealed one exports its original ENCRYPTED bytes — decrypted plaintext
still never reaches disk. Drafts have nothing signed to hand over: the button
is hidden, and the operation says to publish it first.

**Drafts hold attachments.** A draft's images live in the CAS like any other
blob, with `draft_blobs` holding the draft's *reference* to them, so a picked
image survives both opening something else and quitting the app — and a program
can re-declare it as `{carry: true}` instead of re-shipping the bytes. The
garbage collector counts draft references as holders: bytes are released only
when the last draft *and* thing that referenced them is gone.

**Petnames** are the one name nobody else can influence. A thing may claim any
name for its author, and an ENS name may even be *proven* to map to the key —
but what **you** call a key is yours: stored locally, never in a thing, never
shared. That is exactly what makes it worth something, and why the chrome keeps
it visually distinct from a verified name (`data-name="petname"`, never
`"verified"`, and never the ✓ treatment). The address stays in the title, so a
name labels the fact rather than replacing it. `File → People…` lists every key
whose things you hold, with your name for it.

There is no reputation here and no score. Naming someone records that YOU
recognise a key, and nothing more.

**Co-signing** is how one document gets many signatures — a contract with two
parties and two witnesses, or an article five people attest to having
reproduced faithfully. It needed **no format change**: the *document* is the
**manifest**, and an envelope is one *signature* over it, so N signatories are
N envelopes sharing one `man` hash, each independently verified and none
privileged over the others. (The rejected alternative was a `sigs[]` array
inside the envelope: each added signature would change the envelope hash, so
the document's identity would shift as it was signed.) Grouping is a
`manifest_hash` lookup, which is why that column gained an index — `CREATE
INDEX` is allowed where `ALTER` is not.

`cosignBundle` re-signs the stored manifest **byte for byte** and never
re-encodes it: those are the bytes the earlier signers signed, and rebuilding
them from decoded parts would be a different document the moment any encoding
detail differed. This is also why a document cannot be *amended* — change one
byte and you have signed something else, with its own hash and its own
signatures.

A document declares its expected signatories in `args.signers`, indexed into
`doc_signers` keyed by manifest. Because that list lives in the manifest, it is
covered by every signature over it: nobody can quietly add themselves to the
named parties. But **being named is a claim, not consent and not a signature** —
anyone may list anyone — so the chrome keeps the two apart: `2 of 4 signed` is
never a percentage, a bar, or a ✓, and the badge says outright that it is *not
a measure of how valid the document is*. A half-signed contract is not
half-valid; it is a document two people have not signed. A signature from
someone the document never named is still a real signature and is shown as
`plus 1 not named` rather than dropped.

The program renders the *claim* (who the document expects) and physically
cannot see the *proof*: signatures live in envelopes, and `getArgs` withholds
the envelope, so a contract program that lied about being fully signed would be
contradicted by chrome it cannot reach.

Two consequences worth stating. The feed shows a co-signed document **once**,
not once per signature — the library still stores every envelope, but four rows
for one contract would be the worse lie. And **Copy is refused** on a document
that names signatories: Copy rebuilds the same program/type/args, and since a
manifest carries no author and no nonce, that *is* a co-signature — it would
put your key on a contract you meant only to duplicate. The refusal points at
Co-sign, which shows you what you are signing first.

**Vouches** are the trust graph, and the only one there is. A `vouch` thing
carries `args {about, aboutScheme, name, relation, note}` where `about` is an
author **key** — not a thing hash, which is why it cannot ride on `refs` (that
table indexes 64-hex envelope hashes) and gets its own `vouches` table. The
voucher comes from the **envelope**, so it is signature-proven and cannot be
written on someone else's behalf; the subject comes from the **args**, so it is
their claim, like every other arg.

The design rests on one asymmetry: **vouches are free to manufacture.** Anyone
can mint a thousand keys and have them vouch for each other, so a raw count is
worth nothing. What cannot be faked is a path starting at *your* key — so only
paths from you are walked, and only to **depth 2**, past which "vouched for by
someone vouched for by someone I once met" is a stranger with extra steps. The
chrome says `you vouched` or `vouched by someone you vouched for`, never a
number, a percentage, or a ✓. There is no global score and no reputation, and a
key outside your tribe gets **no badge at all** — a "0 hops" label would read as
a score and would put a trust-shaped mark on every stranger in the library.

A vouch says the signer *recognises* a key. It does not say they are honest,
that they are who they claim, or that anything they signed is true. Two further
facts the UI states rather than hides: publishing a vouch **discloses your
social graph** — it tells whoever receives it that you know this key — and a
signed thing cannot be unsaid, so amending means publishing a newer vouch, and
only a voucher's **latest** word is counted (otherwise repetition would buy
weight). This is the deliberate opposite of a petname: naming is private,
vouching is public.

**Attestations** are the other indexed relation. An `attestation` thing carries
`args.attests` — the envelope hash of what it speaks about — and the shell
indexes it exactly as it indexes `replyTo`, under `rel='attests'`, so a thing
can show who has put a signature behind a statement about it. The counting is
deliberately not scoring: a signature proves who said something, never that it
is so, and the chrome shows authors rather than a total. Vouches are what
finally answer "does this signer mean anything to *me*": the list marks which
attesters are in your tribe, and the modal leads with the sentence the graph
exists for — *"5 attestations, 3 from your tribe"*. The first half is free to
manufacture; the second is the part that carries.

**One thing can reference another.** A program can never learn a hash by
itself (`getArgs` withholds the envelope), so the shell seeds `args.replyTo`
when you press **Comment** on an open thing, and indexes the reference so the
target can show its comments. That reference is an author **claim**, exactly
like the `created` timestamp: anyone may claim to reply to anything, and the
target's author never consented. The chrome therefore scopes the list to things
in *your library*, and when you don't hold the target it says so plainly rather
than hiding the claim. The ✓ vocabulary is reserved for verification and is
never used here.

## Notes

- **Keys are software-only** for now (safeStorage if present, else static-key
  XChaCha — never the plaintext key on disk). The chrome now carries an explicit
  **safety warning** reflecting the *actual* at-rest mode (`os` vs `software`): a
  first-run modal + a persistent topbar badge. Proper OS-backed storage as the
  default (and a hardware-wallet `Signer`) are still LATER.
- **`better-sqlite3` is native** and must be built against Electron's ABI, not
  Node's — `pnpm rebuild:native` (run automatically by `postinstall`). Because
  of this, the library is tested through Electron (Playwright), not vitest.
- **Sealed content** (format §7.1) is fully decrypted: the library stores a
  sealed thing's plaintext program/manifest/attachments in an **ephemeral
  in-memory store** (never the on-disk CAS), and mounts serve from it. A sealed
  thing not decrypted this session (e.g. after a restart) is unmountable until
  re-ingested — decrypted plaintext never touches disk.
