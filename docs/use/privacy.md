# What leaks when

Souspli's rule is that **nothing touches the network unless you asked, and you are
told the cost before it happens**. This page is the whole list.

## Reading a letter: nothing

Opening, reading and interacting with a letter reveals nothing to anyone — not to
its author, not to a server, not to an advertiser.

This is enforced, not promised. The container a letter runs in has no network at
[four independent layers](../how/architecture/container.md), no cookies or storage
that survive, no access to your files, and is told almost nothing about you: your
language and whether you prefer a dark theme. No time zone, no screen size, no
identifier. An author cannot learn that you opened their letter, when, how often, or
what you clicked.

## By action

| You do this | Who learns what |
|---|---|
| Open a `.thing` file, drag one in, paste a bundle | Nobody learns anything. |
| Write, edit or publish a letter | Nobody. Publishing signs; it does not send. |
| Save as file / Copy bundle | Nobody, beyond the channel you then use. |
| Paste `bundle:<hash>` | Nobody. It is looked up in your own store. |
| Paste an `https://` link | That server learns **your IP address** and the time. No cookies or credentials are sent. The box shows `⚠ tells <host> your IP` before you press Ingest. |
| Paste a `magnet:` link | The BitTorrent DHT and every peer learn **your IP** and that you want this letter. Shown as `⚠ contacts the BitTorrent network` first. |
| **Seed over BitTorrent** | The DHT and peers learn your IP and that **you hold this letter** — even a sealed one, whose content stays secret. |
| Add a relay | That relay learns your IP and **what you subscribe to** — the one thing none of the other channels leak. |
| Say yes to **Find people…** | Exactly the row above, for `relay.souspli.org`, plus the welcome forum's roster is added to your library from inside the app — no fetch. Until you say yes: nothing. The offer itself contacts nobody. |
| **Post to relays** | Each relay learns your IP; the relay and all its readers learn that **your key published this letter**. |
| Press **Fetch** on an offer | Whatever the offer's link type reveals (above). Until you press it, nothing: no tracker contacted, no byte pulled. |
| Give a key a petname | Nobody. It never leaves your machine. |
| Publish a **vouch** | Everyone who receives it learns **you know that key**. It discloses your social graph, permanently. |
| Vote, comment, attest, co-sign | Nothing until you share the resulting letter — then its readers learn your key's opinion. |
| Say yes to **Check for updates?**, or choose Help → Check for updates… | GitHub learns **your IP address** and which version of Souspli you run, once a day (or once, for the menu item). Until you answer: nothing. |
| Press **Download** on an update | GitHub learns your IP and that you are fetching that version. Nothing is downloaded until you press it; restarting into it is a separate click. |

## Defaults

- The relay list starts **empty**. Souspli connects to nothing you did not add. It
  *suggests* the project's relay; a suggestion opens no connection.
- Nothing is seeded because it exists. Seeding is switched on per letter.
- Nothing is posted because you wrote it. Posting is a separate, explicit act each
  time.
- Nothing a stranger advertises is ever downloaded automatically.
- Update checks are **off until you answer** the question Souspli asks on first
  launch. A found update is shown, never fetched on its own.

## Things a signature makes permanent

- **A signed letter cannot be unsaid.** Once someone else holds it, it verifies as
  yours forever. You can publish a newer version; you cannot withdraw the old one.
- **Your letters link your two keys.** Each one declares your Nostr key under your
  signature. That is what lets people verify a relay post is really yours, and it
  equally lets anyone correlate the two identities.
- **A seal is not access control.** Any recipient of a sealed letter can forward it
  to anyone, with your signature intact. It is confidentiality against people who
  were never sent it — the paper-letter property, no more.
- **The `created` time on a letter is whatever its author typed.** Souspli orders
  your feed by when *you* received things, and treats the author's date as a claim.

## What Souspli itself collects

Nothing. There is no telemetry, no crash reporting, no analytics, and no server
operated by the project for the app to talk to. The one contact the app itself can
make is the update check above, and only if you agree to it: it goes to GitHub, which
hosts the releases, and it carries no identifier beyond what any web request does.
