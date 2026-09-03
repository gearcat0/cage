---
name: create-poster
description: Build poster things programmatically — the photo-set args schema, the arrangement rules, attachment naming, and limits for a script that emits signed .thing files. Use when generating photo posts in bulk, importing an album or gallery, or producing poster args without going through the in-app editor.
---

# Creating posters programmatically

A poster is a **photo post**: one picture or several, arranged the way social
clients arrange them. It is a thing — `program` (`samples/poster.html`), `args`
(the text and the photo list), and `attachments` (the pictures, by name).

If you have not built a thing before, read the `create-article` skill first:
the signer, the builder call, and the limits are the same. This covers what is
specific to posters.

## The args schema

All strings. No numbers anywhere.

```jsonc
{
  "title":   "Four up",
  "caption": "An afternoon out",
  "layout":  "auto",              // auto | grid | row | stack | carousel
  "photos": [
    { "name": "photo-1", "alt": "A domed building", "caption": "The observatory" },
    { "name": "photo-2", "alt": "",                 "caption": "" }
  ]
}
```

- `photos[].name` addresses an attachment and must match one **exactly**.
  Convention is `photo-1`, `photo-2`, … numbered from 1 — that is what the
  editor generates, so match it if you want the poster to stay editable.
- `alt` is for people who cannot see the picture. Worth filling in from
  whatever the source gives you.
- `caption` is per-photo and renders over the bottom of that tile. The
  post-level `caption` is separate and sits under the title.
- A photo whose attachment is missing renders `not attached: photo-2` rather
  than a broken image. That is legitimate — a thing may name a blob the
  recipient does not hold.

## Arrangements

`layout` picks the shape. Anything unrecognised reads as `auto`.

| layout | what it does |
|---|---|
| `auto` | follows the count, like a photo post |
| `grid` | uniform two columns |
| `row` | one row, equal widths |
| `stack` | one per line, **uncropped** |
| `carousel` | one at a time, with prev/next and a counter |

`auto` by count:

| photos | arrangement |
|---|---|
| 1 | single, full width (4:3) |
| 2 | side by side (3:4 each) |
| 3 | one tall on the left, two stacked on the right |
| 4 | 2×2 |
| 5+ | the first four, with **+N** on the last tile |

Past four, `auto` shows four and says how many more rather than shrinking them
all — so a 30-photo album is a legible post, not thirty thumbnails. If you want
every picture visible, use `grid` or `stack`.

Tiles **crop** (`object-fit: cover`) in every layout except `stack`, because a
mosaic only reads as one composition if the pieces agree on shape. If the
pictures' edges matter — artwork, documents, anything where cropping loses
information — use `stack`, which shows each one whole.

## Back-compat

Posters made before the program held more than one photo carry a single
attachment named `image` and **no `photos` list**. Those still render: the list
is synthesised from the attachment.

You can emit that shape deliberately for a single-photo post, but prefer the
explicit `photos` list — it is the current contract, and it is the only way to
set `alt` or a per-photo caption.

The first photo's `<img>` keeps the id `poster-image` in view mode (the others
are `poster-photo-2`, `poster-photo-3`, …). If you are scripting checks against
rendered output, that is the id to look for.

## MIME matters

Give every attachment its correct MIME. It becomes the `content-type` and is
served under `nosniff`, so a PNG labelled `application/octet-stream` will not
display. Use `image/jpeg`, `image/png`, `image/webp`, `image/gif` as
appropriate — whatever the source actually is, not what the extension claims.

## Limits

Same two sets as any thing, and confusing them is the trap.

**Admission** — bundle 256 MiB, manifest 1 MiB, envelope 64 KiB, 256
attachments, 4096 entries per array, 1 MiB per string.

**Drafts** (the in-app editor) — args 256 KiB, **32 MiB per blob**, **64 MiB
per draft**, and the program caps a post at **20 photos**.

Stay inside the draft limits if the poster should remain editable. Sixty photos
admits and renders; opening it in Edit then streams a draft the shell refuses,
and the preview silently stops updating. Twenty photos at a few MB each is also
how you approach the 64 MiB draft ceiling — downscale before attaching.

## A working builder

```ts
// poster.ts — run with: npx tsx poster.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBundle, jsToCbor } from './src/format/index.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

function ethSigner(priv: Uint8Array) {
  const pub = secp256k1.getPublicKey(priv, false)
  return {
    scheme: 'eth-eip191',
    pubkey: keccak_256(pub.subarray(1)).subarray(12),
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
  const files = ['a.jpg', 'b.jpg', 'c.jpg']
  const attachments = new Map<string, { bytes: Uint8Array; mime: string }>()
  const photos = files.map((f, i) => {
    const name = `photo-${i + 1}`
    attachments.set(name, { bytes: new Uint8Array(readFileSync(f)), mime: 'image/jpeg' })
    return { name, alt: '', caption: '' }
  })

  const tar = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    program: new Uint8Array(readFileSync('samples/poster.html')),
    type: 'poster',
    args: jsToCbor({ title: 'An afternoon out', caption: '', layout: 'auto', photos }),
    attachments
  })
  writeFileSync('out/album.thing', tar)
}

main()
```

Wrap in `main()`: the repo has no `"type": "module"`, so `tsx` treats `.ts` as
CJS and top-level `await` fails.

## Common mistakes

- **`photos[].name` not matching an attachment name.** Renders a placeholder,
  silently — a missing blob is legitimate, so there is no error.
- **Wrong MIME.** Served under `nosniff`; a mislabelled image will not display.
- **Expecting `auto` to show everything.** Past four it shows four and a `+N`.
  Use `grid` or `stack` when every picture must be visible.
- **Cropping surprises.** Every layout but `stack` crops to a shared shape.
- **Renaming photos between versions.** Names are the address.
- **Full-resolution originals.** Twenty phone photos will blow the 64 MiB draft
  ceiling; downscale first.
