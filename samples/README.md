# Samples — well-behaved thing programs

Sample programs demonstrating the composition convention: **a program supplies
its own UI for creating new instances of itself; the shell never composes
args.** The shell's compose flow only signs a program blank; everything after
that — gathering the state, requesting the publish — is the program's job,
running inside the cage. The shell's part is the trusted confirm dialog and the
signing that follows approval.

This is a convention, not something the shell can enforce. The expectation is
that users converge on a standard library of high-quality, well-known types and
disfavor programs that hardcode state or lack proper self-instance creation.

## nametag.html

The smallest program with real state: renders `Name: <name>`, where the label
is part of the program and the name comes from `args`.

These are **built into the shell** as starters: press **New** and pick one
(the shell also offers any program type already in your library, plus **New
from HTML…** for your own page). Picking a type starts a local, unsigned
**draft** — it stays on your machine, autosaves as you edit, and becomes a real
signed thing only when you Publish.

Try it: **New → Name tag**. Open it from the feed: it lands in **View** mode (a blank tag
shows `—`). The **View | Edit** toggle in the shell's trusted header — not in
the program — switches to Edit mode. As you edit, the program streams its
working state with `bridge.emit('draft', {type, args})` (grants nothing); the
shell renders it live — switch to View and you see the draft in its final
form, under a "PREVIEW — unpublished draft" badge instead of "✓ signed" — and
the header's **Publish** button signs EXACTLY that latest draft after you
confirm. A new instance — same program, `args: {name}` — appears in your feed.
In-progress edits survive toggling back and forth: both modes stay mounted
while the thing is open.

Programs have no Save/Publish buttons of their own (`emit('publish')` is
retired): rendering and state are the program's; every control is the shell's.

## poster.html

The contract with **attachments**: `args {title, caption, layout, photos}`
where each photo is `{name, alt, caption}`. A program can display its pictures
(`getBlob(name)`) but cannot read the bytes back, so its drafts either include
freshly picked bytes (`blobs: {name: {bytes, mime}}`) or declare
`{carry: true}` — "keep what you already hold" — which the shell resolves from
the instance's own store. Make one with **New → Poster**; add photos in Edit
mode.

**Arrangements** work the way a social photo post does. `auto` follows the
count: one full-width, two side by side, three as one tall picture beside two
stacked, four as a 2×2 — and past four it shows four with a `+N` marker rather
than shrinking them all. `grid`, `row` and `carousel` crop tiles to a shared
shape so the mosaic reads as one composition; `stack` is the exception and
shows each picture whole, for photographs whose edges matter.

Posters published before this program held more than one photo carry a single
`image` attachment and no `photos` list. They still render: the list is
synthesised from the attachment, and the first picture keeps the id
`poster-image` that the rest of the world already knows it by.

## todo.html

The contract with **array state**: `args {title, items: [{text, done}]}`.
View mode is the signed artifact, read-only — checking things off is editing,
done in Edit mode (add / remove / toggle / retext, every change streaming a
draft) and made real by publishing. Make one with **New → To-do list**.

## memo.html

The same contract with structured state: `args: {to, from, subject, message}`.
View mode renders a classic memo sheet (em-dash placeholders for unset fields,
line breaks preserved in the message); edit mode is four fields, each streaming
a draft on input. Make one with **New → Memo**.

## article.html

The richest sample: a news article as a **block document**. `args {title,
deck, authors, …, blocks}`, where a block is a heading, subheading, paragraph,
image, video, or footnote — strings only, never numbers, so the canonical-CBOR
float rules can never bite. Media blocks carry `{name, caption, alt,
placement}`; `left` and `right` float so the text wraps around them, `full`
spans the column. A footnote marks the block above it and collects into a
numbered list with back-links at the end. Edit mode is a block editor: add,
reorder, delete, pick media, set placement.

**Video** blocks play from their attachment — `thing://` serves attachments
with Range support, so the player seeks rather than buffering the whole clip.
A draft blob is capped at 32 MiB (64 MiB per draft), so this is a short clip,
not a film; the editor refuses an oversized file at pick time rather than
letting the shell reject the draft and leave the preview silently frozen.

**Provenance metadata** — publisher, section, dateline, published/updated/
retrieved dates, original and archive URLs, language, rights, keywords — is
carried for articles that are copies of something published elsewhere. Every
field of it is the author's **claim**, exactly like the envelope's `created`
timestamp or a comment's `replyTo`: nothing is checked by the shell or anyone
else. The view says so in as many words and renders URLs as text, not links —
a thing cannot open your browser, and a link that silently does nothing is
worse than an address you can read.

Two contract rules it demonstrates, both easy to get wrong elsewhere: args and
blobs are **whole-set replacement**, so every image still in the article is
re-declared on every emit — fresh bytes when just picked, `{carry: true}`
otherwise, so megabytes do not move per keystroke — and image names are never
renamed, because renaming orphans the carried blob and drops the picture.

## comment.html

A comment on another thing: `args {replyTo, body}`. A program can never learn a
thing's hash by itself (`getArgs` withholds the envelope), so the **shell**
seeds `replyTo` when you press **Comment** on something you have open. Two
rules the program lives by, both worth copying: args are whole-set replacement,
so it echoes `replyTo` on every emit (dropping it would silently unthread the
comment), and it calls the reference a *claim* — anyone may claim to reply to
anything, and only the shell's header says whether that thing is in your
library.

## card.html

A contact / business card: `args {name, role, org, email, phone, url}` —
pure scalars. View mode renders a card that shows only the fields that are
set (a real card has no empty labels); edit mode is six inputs, each
streaming a draft. Make one with **New → Contact card**.

## invite.html

An event invitation: `args {title, host, date, time, location, details}`.
The date is STORED as ISO (data, not presentation) and RENDERED in the
viewer's locale via `viewerInfo()` — the one bridge method no other sample
uses. Unset fields don't render. Make one with **New → Invitation**.
