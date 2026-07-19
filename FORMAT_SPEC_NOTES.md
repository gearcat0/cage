# Format-spec notes from the phase-2 bridge build

The brief says: when the bridge build proves the format spec impractical, note
it — we update the spec rather than working around it. Nothing below is a
workaround in the code; these are the spec deltas the implementation surfaced.

## 1. Recommend (not require) that `manifest.args` be JSON-representable (§4)

`args` is CBOR `any`, so a manifest can carry maps with integer keys or byte
strings, which structured-clone surfaces to JS as `Map`/`Uint8Array`. Most
programs will want plain JSON-shaped args, and a program author who receives a
`Map` where they expected an object will lose an afternoon to it. Add a SHOULD
to §4: authors are RECOMMENDED to keep `args` JSON-representable. The bridge
passes through whatever structured clone supports either way — this is
authoring guidance, not a decoder rule.

## 2. Add a "shell obligations" section; record that decrypted sealed content is memory-only

The spec currently defines the wire format only, but §7/§8 create an obligation
it never states: a shell that admits a sealed bundle holds decrypted private
bytes, and if it writes them to its persistent content-addressed store it has
silently put someone's private attachment on disk in the clear. The phase-2
shell serves sealed attachments from an ephemeral in-memory store scoped to the
cage's lifetime; the persistent CAS is for public things only (and the suite
pins this). When the spec grows a "shell obligations" section, record this as a
MUST.

## 3. Attachment-table keys need constraints (or an explicit note that shells may refuse names)

§4 keys attachments by arbitrary `tstr`. Shells that serve attachments by name
over a URL route (`thing://<id>/att/<name>`) cannot round-trip every possible
string: a name containing `..` is refused by any sane URL parser (dot-segment
normalization), and path separators / control characters are trouble in every
transport that touches a path. The phase-2 publish path rejects names that are
empty, longer than 255 chars, or contain `/`, `\`, `..`, or control characters.
Suggest the spec either constrain table keys the same way (cheap, matches what
NFC normalization already implies about being picky at the boundary) or state
that shells MAY refuse to admit manifests whose attachment names cannot be
served. Silent per-shell divergence here would be an interop trap.

## 4. The publish draft contract has no MIME for inline blobs

The brief's `emit("publish", {type, args, blobs: {name: Uint8Array}})` carries
bare bytes, but a manifest `Att` row requires `m` (MIME). Phase 2 records
`application/octet-stream` and defers the real value to the review/sign flow.
Before the sign/seal phase lands, decide: either the publish contract grows a
per-blob MIME (e.g. `{bytes, mime}` values — a shape change the brief wanted to
avoid), or the spec/shell blesses "MIME is chosen at review time" as the rule.
Sniffing inside the shell is the one option that should stay off the table
(§4's nosniff stance).

## 5. Confirmation: nothing else fought back

The `ThingArgs` view, name-keyed `getBlob`, admission-time-only hashing, and
the CAS layout (`blobs/<hex-hash>`, §8's bundle shape) all mapped onto the
spec cleanly. §10.4 (program supersedes) says "decide when the bridge lands" —
the bridge landed without needing it; it can stay parked until the naming
layer.
