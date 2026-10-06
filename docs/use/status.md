# Status: what is and is not there

Souspli is an **experimental alpha**. This page is the plain list, kept next to the
user guide on purpose: nothing here should surprise you after you have installed it.

## Solid

Built, and covered by the automated suites (about 270 end-to-end tests against the
real app, about 190 unit tests, 41 cross-implementation conformance vectors, on
macOS, Windows and Linux):

- The **sealed container**: 49 escape attempts — network by every route, storage,
  navigation, window-opening, permissions, overlaying the trusted header — all
  blocked, verified from *outside* the renderer by a listener that must stay silent.
- The **format**: canonical encoding, hashing, signing, sealing, and the admission
  gate that refuses anything not fully verified.
- Writing, publishing, versioning, copying and exporting letters; the fifteen
  built-in [types](types.md); drafts with attachments.
- Comments and threads, attestations, co-signed documents, votes.
- Groups and forums: rosters, join requests, posting and replying from the app,
  tribe-weighted ranking, moderators' verdicts and the folding of hidden posts.
- Petnames, vouches, and the depth-two tribe.
- Transports: file, paste, double-click, `bundle:` by hash, BitTorrent magnets with
  resumable background transfers, and Nostr relays with on-demand offers.

## Not there yet

| Missing | What it means for you |
|---|---|
| **Writing sealed (private) letters** | The format supports encrypted letters and Souspli can *open* them, but there is no way to *write* one from the app. Everything you publish is readable by whoever gets the file. |
| **Verified names (ENS)** | The logic is written and tested, but the library it needs is not shipped and there is no setting for an Ethereum node. In current builds no name is ever shown as verified; you have petnames. |
| **Key rotation and revocation** | A stolen key signs as you forever. No mechanism yet. |
| **Recovery phrase for an existing key** | A phrase is shown only when an identity is generated. Afterwards the only backup is the raw private key. |
| **Hardware wallets, OS-backed signing** | Keys are held in software. |
| **Other signature schemes for writing** | Letters are signed with an Ethereum-style key only. Nostr-key signatures verify on receipt; the SSH scheme in the specification is not implemented. |
| **A busy place to go** | The app suggests the project's relay and its welcome forum, *Coffee Talk* — offered, never connected silently. It is new and small; do not expect a crowd. |
| **Opening enclosed PDFs and documents** | They travel intact and can be exported, but the container cannot display them. |
| **Mobile, or a web viewer** | Desktop only. |

## Likely to change

- The specification is a **draft**; nothing in it is stable, and it ends with its own
  [list of known gaps](../how/protocol/spec.md).
- The relay event kind and tag names are provisional.
- Fetching letters from `https://` links is a development convenience and is
  expected to be removed before a first stable release.
- An independent security review of the format and the container has not happened
  yet. Until it has, treat every guarantee on these pages as *tested by its authors*.

## So what should I use it for?

Trying the idea. Reading and writing things you would be content to see public.
Running a small forum among people who know each other. Telling us where it breaks.

Not yet: anything confidential, anything valuable, or anything you need to still be
able to open in five years without keeping your own backups.

What comes next is on the [roadmap](../next/roadmap.md).
