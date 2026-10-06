# Install

Souspli runs on macOS, Windows and Linux.

## Download

Installers are attached to each release at
**[github.com/souspli/souspli/releases](https://github.com/souspli/souspli/releases)**:

| Platform | File |
|---|---|
| macOS | `Souspli-<version>-mac-<arch>.dmg` |
| Windows | `Souspli-<version>-win-x64.exe` |
| Linux | `Souspli-<version>-linux-<arch>.AppImage`, or the `.deb` |

If no release is listed yet, [build it from source](../how/develop/building.md) — it
is three commands.

## Installing

- **macOS** — open the `.dmg` and drag Souspli to Applications. Builds are signed
  and notarized by Apple. For now there is one build, for Intel (`x64`); on an Apple
  Silicon Mac it runs through Rosetta 2, which macOS offers to install the first
  time. A native Apple Silicon build will arrive as an ordinary update.
- **Windows** — run the installer. It is signed, but SmartScreen may still warn
  while the certificate is new: **More info → Run anyway**.
- **Linux** — `chmod +x Souspli-*.AppImage`, then run it; or install the `.deb`.

## Updates

Souspli asks, on first launch, whether it may check GitHub for a new version once a
day ([what that reveals](privacy.md)). If you say no, Help →
Check for updates… still works. A found update is shown with its notes and is only
downloaded, then installed on restart, when you say so.

The `.deb` package does not replace itself; Souspli tells you about the new version
and opens its release page. The AppImage, the macOS app and the Windows installer
update in place.

## First run

Souspli shows a notice headed **⚠ Experimental alpha** and asks you to acknowledge
it. Read it; it is short and it is true:

- Your identity key is created on first launch and stored on your machine —
  protected by your operating system's keychain where one is available, and by a
  weaker software scheme where it is not. The badge in the top bar tells you which.
- Do not use this identity for anything valuable, and do not put anything in a
  letter that you could not bear to leak. **A signed letter is public and permanent
  once shared.**

Then Souspli opens onto a **welcome letter** — a real one, bundled with the app and
checked exactly like a letter from a stranger before it was shown. It is there so the
first thing you see is what matters most: a letter below, and above it the header
that tells you who signed it. It was signed by a key made for that one letter and
then destroyed, so the address is a stranger's, and the header says so.

It is offered once. Delete it and it will not come back; a library that already
holds something never receives it. With nothing open, the window says what Souspli
is and offers the two ways in: **Write a letter** and **Open a letter file…**.

Next: [write your first letter](first-letter.md), or open a `.thing` file somebody
sent you.

## Where your data lives

| | |
|---|---|
| macOS | `~/Library/Application Support/Souspli` |
| Windows | `%APPDATA%\Souspli` |
| Linux | `~/.config/Souspli` |

That directory holds your encrypted identity file, the library index, the
content-addressed blob store and the bundles you are able to re-serve. Deleting it
deletes your identity. [Back up your key first](identity.md).
