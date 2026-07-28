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
→ Sign & save. Open it from the feed: with no args it shows its *set* mode
(input + Save). Saving emits a `publish` request; approve it in the shell's
dialog and a new instance — same program, `args: {name}` — appears in your
feed. Open that one and you get the *view* mode, with an Edit button that loops
back to *set*.
