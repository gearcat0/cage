import cardHtml from '../../../samples/card.html?raw'
import inviteHtml from '../../../samples/invite.html?raw'
import memoHtml from '../../../samples/memo.html?raw'
import nametagHtml from '../../../samples/nametag.html?raw'
import posterHtml from '../../../samples/poster.html?raw'
import todoHtml from '../../../samples/todo.html?raw'

// ── Built-in starter programs ────────────────────────────────────────────────
// The sample programs, shipped INSIDE the app so "New → Nametag" works on a
// fresh install with nothing in the library yet.
//
// They are inlined at BUILD time via vite's `?raw`, which means: no runtime
// file reads, no packaging rules to keep in sync (electron-builder already
// ships out/**), and dev / built / asar are literally the same code path.
// samples/*.html stays the single source of truth — the unit test asserts
// these strings still byte-match the files on disk, so a starter can never
// silently drift from the sample everyone else reads.

export interface Starter {
  /** Stable menu key: `starter:<name>`. */
  key: string
  /** The manifest type a new instance is created with. */
  type: string
  label: string
  description: string
  html: string
}

export const STARTERS: readonly Starter[] = [
  {
    key: 'starter:nametag',
    type: 'nametag',
    label: 'Name tag',
    description: 'A name, in big letters.',
    html: nametagHtml
  },
  {
    key: 'starter:card',
    type: 'card',
    label: 'Contact card',
    description: 'Name, role, and how to reach you.',
    html: cardHtml
  },
  {
    key: 'starter:memo',
    type: 'memo',
    label: 'Memo',
    description: 'To, from, subject, message.',
    html: memoHtml
  },
  {
    key: 'starter:invite',
    type: 'invite',
    label: 'Invitation',
    description: 'An event, with the date shown in the reader’s locale.',
    html: inviteHtml
  },
  {
    key: 'starter:todo',
    type: 'todo',
    label: 'To-do list',
    description: 'A list of things to check off.',
    html: todoHtml
  },
  {
    key: 'starter:poster',
    type: 'poster',
    label: 'Poster',
    description: 'A picture with a title and caption.',
    html: posterHtml
  }
]

export function starterBytes(s: Starter): Uint8Array {
  return new TextEncoder().encode(s.html)
}

export function starterByKey(key: string): Starter | null {
  return STARTERS.find((s) => s.key === key) ?? null
}
