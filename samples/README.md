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

Try it: launch the shell → **Create…** → choose `nametag.html`, type `nametag`
→ Sign & save. Open it from the feed: it lands in **View** mode (a blank tag
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

The contract with an **attachment**: `args {title, caption}` plus an `image`
attachment. A program can display its image (`getBlob('image')`) but cannot
read the bytes back, so its drafts either include freshly picked bytes
(`blobs: {image: {bytes, mime}}`) or declare `{carry: true}` — "keep my
current image" — which the shell resolves from the instance's own store.
Create it via **Create…** with type `poster`; pick the image in Edit mode.

## memo.html

The same contract with structured state: `args: {to, from, subject, message}`.
View mode renders a classic memo sheet (em-dash placeholders for unset fields,
line breaks preserved in the message); edit mode is four fields, each streaming
a draft on input. Create it via **Create…** with type `memo`.

## invite.html

An event invitation: `args {title, host, date, time, location, details}`.
The date is STORED as ISO (data, not presentation) and RENDERED in the
viewer's locale via `viewerInfo()` — the one bridge method no other sample
uses. Unset fields don't render. Create it via **Create…** with type
`invite`.
