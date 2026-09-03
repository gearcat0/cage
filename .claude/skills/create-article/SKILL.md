---
name: create-article
description: Build article things programmatically — the args schema, attachment rules, and limits for a scraper or importer that emits signed .thing files. Use when generating articles in bulk, importing from another source, or writing anything that produces article args without going through the in-app editor.
---

# Creating articles programmatically

An article is a **thing**: a signed bundle of `program` (the HTML in
`samples/article.html`), `args` (the content, as canonical CBOR), and
`attachments` (the pictures and video, addressed by name).

A scraper produces `.thing` files. The shell admits them like anything else —
double-click, drag in, `Open file…`, or paste a `file:` locator in the omnibar.

## The args schema

Everything is optional except that an article with no `blocks` renders as
empty. **Every value is a string** — including dates. That is deliberate:
canonical CBOR forbids floats and `-0`, and a string date cannot be wrong about
a timezone. Do not send numbers.

```jsonc
{
  "title":      "Scaffolding goes up on Monday",
  "deck":       "Works begin at the north face",   // standfirst, one line
  "authors":    ["A. Reporter", "B. Photographer"], // list of strings
  "byline":     "A. Reporter",                      // legacy single string; use authors
  "publisher":  "The Example Times",
  "section":    "Local",
  "location":   "NAIROBI",                          // dateline
  "published":  "2026-09-03",                       // YYYY-MM-DD
  "updated":    "2026-09-04",
  "retrieved":  "2026-09-04",                       // when YOU captured it
  "sourceUrl":  "https://example.com/story/1",
  "archiveUrl": "https://archive.example/x",
  "language":   "en",
  "rights":     "© Example Times",
  "keywords":   ["works", "roof"],
  "blocks":     [ /* see below */ ]
}
```

### Blocks

Order is document order. Six kinds:

```jsonc
{ "kind": "heading",    "text": "What is happening" }   // <h2>
{ "kind": "subheading", "text": "The detail" }          // <h3>
{ "kind": "paragraph",  "text": "Body text." }          // <p>
{ "kind": "footnote",   "text": "Per the works order." }
{ "kind": "image", "name": "img-1", "caption": "…", "alt": "…", "placement": "right" }
{ "kind": "video", "name": "vid-1", "caption": "…", "alt": "…", "placement": "full" }
```

- `placement` is `left`, `right`, or `full`. `left`/`right` float so the text
  wraps around them; `full` spans the column. Anything else reads as `full`.
- A **footnote** attaches a numbered marker to the block *before* it and
  collects into a back-linked list at the end. A footnote first in the list has
  nothing to attach to and marks the article body itself.
- Unknown `kind` renders as a paragraph. The program is total over hostile
  args — it never throws on bad input — so malformed blocks degrade rather than
  break the page.

### Attachments

`block.name` must match an attachment name **exactly**. Convention is `img-N`
and `vid-N`, numbered from 1, and the editor generates those — match it so an
article stays editable in the app.

A named attachment that isn't present renders as a labelled placeholder
(`image not attached: img-1`), not a broken image. That is legitimate: a thing
can reference a blob the recipient does not hold.

Give every attachment its correct MIME. It is served as the `content-type`
under `nosniff`, so `image/png` labelled `application/octet-stream` will not
display.

## Provenance is a claim, not a credential

Nothing verifies `publisher`, `sourceUrl`, `published`, or any other metadata
field. Anyone can assert anything. The article view says so explicitly — "As
recorded by whoever made this thing. None of it is verified." — and never uses
the ✓ vocabulary, which belongs to signatures and verified names.

What *is* verified is the **signature**: the envelope proves which key signed
this bundle, and the shell shows that separately. So a scraper's articles are
provably from the scraper's key, and everything they *say* about origin is
hearsay. Do not build anything that depends on the metadata being trustworthy.

## Limits

Two different sets, and confusing them is the trap.

**Admission** — what a `.thing` must satisfy to be accepted at all:

| limit | value |
|---|---|
| bundle, raw | 256 MiB |
| manifest (args live here) | 1 MiB |
| envelope | 64 KiB |
| attachments | 256 |
| entries in any array/map | 4096 |
| any single string | 1 MiB |
| nesting depth | 16 |

**Drafts** — what the in-app editor may stream, which is *much* tighter:

| limit | value |
|---|---|
| args | 256 KiB |
| one blob | 32 MiB |
| all blobs per draft | 64 MiB |

Build inside the **draft** limits if you want your articles to remain editable
in the shell. An article with 500 KiB of args admits and renders perfectly, but
the moment someone opens it in Edit the program streams a draft the shell
refuses — the preview stops updating and Publish stays disabled, with nothing
said about why. Keep articles well under 256 KiB of args; that is a lot of
text, so this only bites on runaway scrapes.

Attachment names cannot be empty, longer than 255 chars, or contain `/`, `\`,
`..`, or control characters — they become URL path segments.

## A working builder

Verified end to end: this produces a `.thing` the shell admits as `valid` and
renders with its image, dateline, and provenance section.

```ts
// scrape.ts — run with: npx tsx scrape.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBundle, jsToCbor } from './src/format/index.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

/** An eth-eip191 signer. The shell's own identity uses this scheme; a scraper
 *  signs with its own key, and readers see that key as the author. */
function ethSigner(priv: Uint8Array) {
  const pub = secp256k1.getPublicKey(priv, false)
  return {
    scheme: 'eth-eip191',
    pubkey: keccak_256(pub.subarray(1)).subarray(12), // the 20-byte address
    async sign(input: Uint8Array): Promise<Uint8Array> {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${input.length}`)
      const buf = new Uint8Array(prefix.length + input.length)
      buf.set(prefix, 0)
      buf.set(input, prefix.length)
      const recd = secp256k1.sign(keccak_256(buf), priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0] // recovery id last
      return out
    }
  }
}

async function main() {
  const args = {
    title: 'Scaffolding goes up on Monday',
    deck: 'Works begin at the north face',
    authors: ['A. Reporter'],
    publisher: 'The Example Times',
    section: 'Local',
    location: 'NAIROBI',
    published: '2026-09-03',
    retrieved: '2026-09-04',
    sourceUrl: 'https://example.com/story/1',
    language: 'en',
    keywords: ['works', 'roof'],
    blocks: [
      { kind: 'heading', text: 'What is happening' },
      { kind: 'paragraph', text: 'Contractors arrive at first light.' },
      { kind: 'image', name: 'img-1', caption: 'The north face', alt: 'Scaffolding', placement: 'right' },
      { kind: 'footnote', text: 'Per the works order.' }
    ]
  }

  const tar = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    program: new Uint8Array(readFileSync('samples/article.html')),
    type: 'article',
    args: jsToCbor(args),                      // plain JS object -> canonical CBOR
    attachments: new Map([
      ['img-1', { bytes: new Uint8Array(readFileSync('photo.png')), mime: 'image/png' }]
    ])
  })
  writeFileSync('out/story-1.thing', tar)
}

main()
```

Notes on running it:

- The repo has no `"type": "module"`, so `tsx` treats `.ts` as CJS and
  **top-level `await` fails**. Wrap in `main()` as above, or use `.mts`.
- `jsToCbor` throws on non-integer numbers and `-0`. Since article args are
  strings only, you will not hit this unless you send a number by accident —
  which is exactly what it is there to catch.
- Reuse one key across a scrape run, or every article looks like a different
  author.

## Getting them into the shell

Any of: double-click the `.thing`, drag it in, **Open file…**, or paste
`file:///path/to/story-1.thing` in the omnibar. Each goes through the same
admission gate — there is no privileged import path.

To check a batch without a GUI, admission is what matters: a bundle either
admits `valid` or it does not, and the reason is reported.

## Common mistakes

- **Numbers in args.** Everything is a string, dates included.
- **`block.name` not matching an attachment name.** Renders a placeholder, not
  the picture. There is no error — a missing blob is legitimate.
- **Wrong MIME.** Served under `nosniff`; a mislabelled image will not display.
- **Renaming attachments between versions.** Names are the address. Renaming
  orphans the blob.
- **Assuming the draft rules apply.** `{carry: true}` and whole-set replacement
  are about `emit('draft')` from inside a running program. A builder passes
  attachments once, as bytes.
- **Huge args.** Admits fine, then cannot be edited in the app. See Limits.
