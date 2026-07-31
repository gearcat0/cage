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

## memo.html

The same contract with structured state: `args: {to, from, subject, message}`.
View mode renders a classic memo sheet (em-dash placeholders for unset fields,
line breaks preserved in the message); edit mode is four fields, each streaming
a draft on input. Create it via **Create…** with type `memo`.
