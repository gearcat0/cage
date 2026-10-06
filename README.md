<p align="center">
  <img src=".github/assets/logo.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Souspli</h1>

<p align="center">
  <a href="https://github.com/souspli/souspli/actions/workflows/test.yml"><img src="https://github.com/souspli/souspli/actions/workflows/test.yml/badge.svg?branch=master" alt="Tests"></a>
  <a href="https://github.com/souspli/souspli/actions/workflows/site-live.yml"><img src="https://github.com/souspli/souspli/actions/workflows/site-live.yml/badge.svg?branch=master" alt="souspli.org"></a>
  <a href="https://codecov.io/gh/souspli/souspli"><img src="https://codecov.io/gh/souspli/souspli/graph/badge.svg?branch=master" alt="Unit test coverage"></a>
</p>

**Signed, self-contained letters that people send each other and keep — instead of
pages a server renders for them.**

A Souspli letter is one file. It carries its own content, images, layout and
behaviour, and its author's signature covers all of it. It opens in a sealed
container with no network, so it can be as interactive as a web page and still
cannot report on its reader. Hand it on by any channel — a file, a paste, a torrent,
a relay — and whoever receives it verifies it without asking anyone.

Out of that one object: articles, invitations, invoices, contracts with several
signatures, clubs with rosters, forums with threads, votes and moderation. No
accounts, no host, nothing to shut down.

> **Experimental alpha.** It works and it is tested hard. It has not been
> independently reviewed, and private (sealed) letters cannot yet be written from
> the app. [The plain list](docs/use/status.md).

*sous pli* — French, "under sealed cover".

## Read at the depth you want

| | |
|---|---|
| **[Why](docs/why/index.md)** | What is wrong with the web's shape, and what a letter fixes. · [Compared with Nostr, Mastodon, IPFS, PGP…](docs/why/compared.md) · [A very old idea](docs/why/an-old-idea.md) |
| **[Use](docs/use/index.md)** | [Install](docs/use/install.md) · [your first letter](docs/use/first-letter.md) · [sharing](docs/use/sharing.md) · [forums](docs/use/forums.md) · [contracts](docs/use/contracts.md) · [people and trust](docs/use/people.md) · [what leaks when](docs/use/privacy.md) |
| **[How](docs/how/index.md)** | [The format specification](docs/how/protocol/spec.md) · [architecture](docs/how/architecture/overview.md) · [the sealed container](docs/how/architecture/container.md) · [security and threat model](docs/how/architecture/security.md) · [writing a type](docs/how/develop/writing-a-type.md) |
| **[Next](docs/next/roadmap.md)** | Sealed authoring, key rotation, signed releases — and zero-knowledge membership, anonymous ballots, identity proofs. |

## Try it

Download an installer from [Releases](https://github.com/souspli/souspli/releases),
or build it:

```bash
pnpm install
pnpm dev
```

Needs Node 22, pnpm and a C++ toolchain. [Build notes](docs/how/develop/building.md),
including the Linux sandbox note for containers and CI.

The fastest way to see what it is *for*:

```bash
pnpm world provision && pnpm world seed
pnpm world forum        # one forum, ranked differently for two readers — by whom each trusts
pnpm world open ada     # the real app, on a populated library
```

## What is in this repository

| Path | |
|---|---|
| `src/format/` | The letter format: canonical CBOR, hashing, signing, sealing, admission. Pure TypeScript; no Electron, no network, holds no keys. |
| `src/conformance/` | 41 portable test vectors so a second implementation can prove it agrees. |
| `src/main/`, `src/preload/` | The sealed container ("the cage"). Imports nothing from the rest — enforced in CI. |
| `src/shell/` | The desktop client ("the shell"): admission, keyring, library, transports, relays, trusted header. |
| `samples/` | The fifteen built-in types, one HTML file each. |
| `relay/` | relay.souspli.org: a small Nostr relay for letters, on Cloudflare Workers + one Durable Object. Standalone package. |
| `site/` | souspli.org, built from `docs/`. Standalone package. |
| `test/` | The escape battery, ~270 end-to-end tests against the real app, ~190 unit tests. |
| `docs/` | Everything above. [`docs/design-notes/`](docs/design-notes/index.md) keeps the original build briefs as decision records. |

The coverage badge counts the unit tests only. They cover the format closely
(`src/format/` is at about 95%), but the shell and the cage are tested by the escape
battery, which runs inside Electron and isn't measured, so the overall figure
understates what is tested.

The code calls a letter a *thing*, a type a *program*, and the client the *shell* —
[glossary](docs/glossary.md). Nothing on the wire was renamed.

## Contributing and security

[CONTRIBUTING.md](CONTRIBUTING.md) · report vulnerabilities privately:
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).
