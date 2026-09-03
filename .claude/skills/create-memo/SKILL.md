---
name: create-memo
description: Build memo things programmatically — the args schema, enclosure rules, which attachment types render and which cannot, and limits for a script that emits signed .thing files. Use when generating memos in bulk, importing correspondence or records with attached files, or producing memo args without going through the in-app editor.
---

# Creating memos programmatically

A memo is a short addressed note — To / From / Subject / message — that can
carry **enclosures**: attached files. It is a thing: `program`
(`samples/memo.html`), `args`, and `attachments`.

If you have not built a thing before, read the `create-article` skill first:
the signer, the builder call, and the limits are the same. This covers what is
specific to memos, and the one constraint that shapes everything about them.

## The constraint that shapes the design

A memo can only *show* what the cage's CSP permits, and it cannot open
anything.

| what | can the memo do it? |
|---|---|
| images (`img-src thing:`) | **yes** — rendered in place |
| audio and video (`media-src thing:`) | **yes** — with controls, Range seeking |
| PDF, spreadsheet, zip, anything else | **no** — `frame-src 'none'`, no `object-src` |
| download / open externally | **no** — navigation is blocked in the cage |

So an enclosure is either **shown** or **listed**. Listed ones display the type
and size and say outright that they cannot be opened from there, pointing at
**Export**, which writes the whole bundle back out as a file. The bytes are
never lost — only the opening is missing.

Do not design around this. A scripted memo that names a PDF "click to open"
in its `note` is writing a caption that lies; the reader gets a line saying the
opposite two lines below it.

## The args schema

All strings.

```jsonc
{
  "to":      "All staff",
  "from":    "Facilities",
  "subject": "Roof works",
  "message": "Scaffolding goes up Monday.\nAccess via the north door.",
  "enclosures": [
    { "name": "encl-1", "label": "site-plan.png", "note": "Where the scaffolding goes" },
    { "name": "encl-2", "label": "contract.pdf",  "note": "The signed contract" }
  ]
}
```

- `message` keeps line breaks (`white-space: pre-wrap`). Newlines in the string
  are the way to paragraph it.
- Unset `to` / `from` / `subject` / `message` render as `—`.
- `enclosures[].name` addresses an attachment and must match one **exactly**.
  Convention is `encl-1`, `encl-2`, … numbered from 1, matching what the editor
  generates.
- `label` is the human filename shown to the reader — set it to the source
  filename. If omitted, the reader sees the blob name (`encl-1`), which is not
  useful.
- `note` says what the file is. Optional, and worth filling in precisely
  because the reader may not be able to open the file to find out.
- An enclosure whose attachment is missing renders `not attached to this memo`.

## MIME decides what happens

This matters more here than anywhere else: the MIME you attach decides whether
the reader **sees** the file or only reads about it.

- `image/png`, `image/jpeg`, `image/webp`, `image/gif` → shown in place
- `video/mp4`, `audio/mpeg`, and other `video/*` `audio/*` → player with controls
- anything else → listed with type and size

Get it right from the source, not from the file extension. A PNG sent as
`application/octet-stream` will be listed as an unopenable file rather than
displayed — which is the correct behaviour for what you told the shell it was.

The type and size the memo displays come from the **manifest**, not from your
args. You cannot label a file as something it is not: the size is the real byte
count and the MIME is the one recorded at admission.

## Limits

**Admission** — bundle 256 MiB, manifest 1 MiB, envelope 64 KiB, 256
attachments, 4096 entries per array, 1 MiB per string.

**Drafts** (the in-app editor) — args 256 KiB, **32 MiB per blob**, **64 MiB
per draft**, and the program caps a memo at **12 enclosures**.

Stay inside the draft limits if the memo should remain editable in the shell.

## A working builder

```ts
// memo.ts — run with: npx tsx memo.ts
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
  // name -> [source file, mime, label shown to the reader, what it is]
  const files: [string, string, string, string][] = [
    ['encl-1', 'image/png', 'site-plan.png', 'Where the scaffolding goes'],
    ['encl-2', 'application/pdf', 'contract.pdf', 'The signed contract']
  ]
  const attachments = new Map<string, { bytes: Uint8Array; mime: string }>()
  const enclosures = files.map(([name, mime, label, note]) => {
    attachments.set(name, { bytes: new Uint8Array(readFileSync(label)), mime })
    return { name, label, note }
  })

  const tar = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    program: new Uint8Array(readFileSync('samples/memo.html')),
    type: 'memo',
    args: jsToCbor({
      to: 'All staff',
      from: 'Facilities',
      subject: 'Roof works',
      message: 'Scaffolding goes up Monday.\nAccess via the north door.',
      enclosures
    }),
    attachments
  })
  writeFileSync('out/roof-works.thing', tar)
}

main()
```

Wrap in `main()`: the repo has no `"type": "module"`, so `tsx` treats `.ts` as
CJS and top-level `await` fails.

## Common mistakes

- **Wrong or generic MIME.** Decides whether the file is shown or merely
  listed. `application/octet-stream` on an image hides it.
- **Omitting `label`.** The reader sees `encl-1` and learns nothing.
- **A vague `note` on an unopenable file.** For anything not an image, audio or
  video, the note is *all* the reader gets. Say what it contains.
- **`enclosures[].name` not matching an attachment name.** Renders "not
  attached", silently.
- **Writing "open the attached PDF" in the message.** They cannot, from there.
  Say "attached; use Export to save it" if you need to say anything.
- **Renaming enclosures between versions.** Names are the address.
