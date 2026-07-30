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
the program — switches to Edit mode: input + Save. Saving emits a `publish`
request; approve it in the shell's dialog and a new instance — same program,
`args: {name}` — appears in your feed. In-progress edits survive toggling back
and forth: both modes stay mounted while the thing is open.

While editing, the program streams its working state with
`bridge.emit('draft', {type, args})` (same shape as `publish`; grants
nothing). The shell renders it live: switch to View and you see the draft in
its final form — the same program mounted in view mode with the draft's args —
under a "PREVIEW — unpublished draft" badge instead of "✓ signed".
