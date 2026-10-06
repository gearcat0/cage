# What comes next

Two lists. The first is engineering: known, scoped, and mostly a matter of doing it.
The second is research: directions the design makes unusually cheap, where the right
answer is not yet known.

Nothing here is a promise or has a date.

## Near: finishing what is started

| | Why it matters |
|---|---|
| **Writing sealed letters** | The format, the cryptography and the receiving side are done and tested. What is missing is the interface: choosing recipients, and saying plainly at the moment of sealing that *any recipient can forward it*. Until then Souspli has no private mode. |
| **Forums per subscription** | The app asks a relay for *every* letter posted there. On a busy public relay that is too much: subscribe per forum, and let people choose which. |
| **Key rotation and revocation** | The largest gap in the design. Likely a signed, chained statement from the old key naming its successor, discoverable the same way new versions are. |
| **Recovery and custody** | A recovery phrase for an existing key; OS-backed signing by default; a hardware-wallet signer (`personal_sign` already works on Ledger and Trezor). |
| **More ways to sign** | `ssh-ed25519`, as the specification describes — millions of developers already hold a key. Then Nostr-native signing of letters. |
| **Verified names that work** | Ship the ENS client and a setting for the node it asks; Nostr names (NIP-05) behind the same interface. |
| **Spec to v1** | Absorb the [pending amendments](../how/protocol/spec.md), settle the relay event, freeze, and publish `@souspli/format` and `@souspli/conformance` as packages. |
| **Independent security review** | Of the format and of the container. Nothing should be called safe before it. |

## Further: what this design makes possible

### Prove you belong, without saying who you are

A group's roster is already a signed, versioned list of keys. Commit to it as a
Merkle root inside the group letter, and a member can produce a **zero-knowledge
proof of membership**: "the author of this post is on the current roster of this
forum" — verifiable by anyone holding the roster, revealing nothing else.
(Semaphore-style group signatures are the known construction.)

That gives a members-only forum where posts are anonymous *even to other members*,
and yet nobody outside can post. A whistleblowing channel inside an organisation. A
ballot.

### One member, one vote — anonymously

Add a **nullifier** to that proof — a value derived from the member's key and the
thing being voted on — and each member can vote exactly once without anyone learning
how they voted, or even which members voted. A club can hold a secret ballot with no
election server.

It also repairs a real cost in today's design: a public vouch **discloses your social
graph**. With membership proofs, "three people in your tribe endorse this" could be
shown without revealing which three.

### Endorsements that carry weight without carrying names

The same machinery generalises from rosters to any signed set: "a licensed
physician attests to this", "an employee of this company wrote this", "someone who
co-signed the original contract disputes this version" — each provable against a
published list without identifying the individual.

### Identity proofs, selectively disclosed

The specification deliberately left a slot for identity documents rather than
supporting them, because binding content to a legal identity is close to the
opposite of what Souspli is for. Zero-knowledge changes the trade. Proofs over a
passport chip's signature or a DKIM-signed email can show "a unique person", "over
eighteen", "a citizen of this country" or "holds an address at this domain" —
**without the document, the name or the number**. For a forum that wants one account
per human and nothing else about them, that is the right primitive.

### Letters that agents can read

A letter carries its own schema. A vendor's software can check an incoming purchase
order against its catalogue on its own machine, reject a withdrawn SKU, and reply
with a memorandum — itself a letter. The
[generation guides](../how/develop/generating-letters.md) are a first step: they
already let a coding agent produce valid articles, memos and invoices. The
interesting part is the reverse direction: agents as *correspondents*, with every
exchange signed, kept by both sides, and auditable afterwards.

### A reader in the browser, and on a phone

The format library already runs in browsers. A drag-and-drop page that verifies a
letter and renders it in a locked-down frame would let someone *read* a letter with
no install — weaker than the desktop container, clearly labelled as such, and the
obvious way for a curious person to take the first step. Mobile readers follow the
same shape: verify, then render with the network off.

### A second implementation

The real test of a protocol. The [conformance vectors](../how/protocol/conformance.md)
exist so that someone can write a reader in another language and prove it agrees.
A command-line verifier and an archival indexer are the natural first ones.

## Deliberately not planned

- A global feed, a recommendation algorithm, or any reputation score.
- Accounts, or a server the project runs that the app depends on.
- Smart-contract wallet signatures: verifying them requires asking a blockchain,
  and a letter must be verifiable with no network at all.
- Read receipts, presence, or analytics of any kind.
