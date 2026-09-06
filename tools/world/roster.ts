// The cast: 30 named accounts, derived from one phrase.
//
// Reproducibility is the point. The same mnemonic always yields the same 30
// keys, so `reset` + `provision` rebuilds a byte-identical world and any note
// you wrote about "the contract Ada drafted" still refers to the same key.

import { mnemonicToAccounts } from '../../src/shell/keyring/hd.js'

/** A DEV phrase, hardcoded on purpose.
 *
 *  This is not a secret and must never hold anything of value. It is checked
 *  into a tools directory, every key it derives is written to disk in software
 *  mode (`SHELL_FORCE_SOFTWARE_KEYS=1`), and the whole `world/` tree is
 *  gitignored. It exists so a throwaway world can be rebuilt identically, and
 *  for no other reason. */
export const WORLD_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'

export interface RosterEntry {
  /** Stable directory name and CLI handle. */
  slug: string
  /** What the world calls them. */
  name: string
  /** Flavour only — it decides who signs what in the scenario. */
  role: string
}

/** Thirty people with enough shape to build a believable social graph: two
 *  organisations, a couple of freelancers, and some strangers nobody knows. */
export const ROSTER: readonly RosterEntry[] = [
  // ── Meridian Press — a small newsroom ───────────────────────────────────
  { slug: 'ada', name: 'Ada Lovelace', role: 'editor' },
  { slug: 'grace', name: 'Grace Hopper', role: 'reporter' },
  { slug: 'alan', name: 'Alan Turing', role: 'reporter' },
  { slug: 'katherine', name: 'Katherine Johnson', role: 'fact-checker' },
  { slug: 'dorothy', name: 'Dorothy Vaughan', role: 'fact-checker' },
  { slug: 'mary', name: 'Mary Jackson', role: 'photographer' },
  { slug: 'joan', name: 'Joan Clarke', role: 'sub-editor' },
  { slug: 'edith', name: 'Edith Clarke', role: 'archivist' },

  // ── Harbour & Vale — a law practice ─────────────────────────────────────
  { slug: 'thurgood', name: 'Thurgood Marshall', role: 'partner' },
  { slug: 'sandra', name: 'Sandra Okonjo', role: 'partner' },
  { slug: 'ruth', name: 'Ruth Bader', role: 'solicitor' },
  { slug: 'oliver', name: 'Oliver Wendell', role: 'solicitor' },
  { slug: 'clara', name: 'Clara Barton', role: 'clerk' },
  { slug: 'benjamin', name: 'Benjamin Cardozo', role: 'clerk' },
  { slug: 'ida', name: 'Ida Wells', role: 'paralegal' },

  // ── Tenants and counterparties ──────────────────────────────────────────
  { slug: 'rosalind', name: 'Rosalind Franklin', role: 'tenant' },
  { slug: 'barbara', name: 'Barbara McClintock', role: 'tenant' },
  { slug: 'linus', name: 'Linus Pauling', role: 'landlord' },
  { slug: 'dorothyh', name: 'Dorothy Hodgkin', role: 'surveyor' },

  // ── Freelancers, loosely connected ──────────────────────────────────────
  { slug: 'hedy', name: 'Hedy Lamarr', role: 'freelance photographer' },
  { slug: 'claude', name: 'Claude Shannon', role: 'freelance writer' },
  { slug: 'emmy', name: 'Emmy Noether', role: 'freelance editor' },
  { slug: 'srinivasa', name: 'Srinivasa Ramanujan', role: 'freelance illustrator' },

  // ── Strangers: nobody vouches for these, and that is the point ──────────
  { slug: 'kestrel', name: 'Kestrel Nine', role: 'stranger' },
  { slug: 'quill', name: 'Quill Redgrave', role: 'stranger' },
  { slug: 'marlow', name: 'Marlow Ash', role: 'stranger' },
  { slug: 'vesper', name: 'Vesper Coyne', role: 'stranger' },
  { slug: 'tobias', name: 'Tobias Crane', role: 'stranger' },
  { slug: 'wren', name: 'Wren Halloway', role: 'stranger' },
  { slug: 'sable', name: 'Sable Voss', role: 'stranger' }
]

export interface WorldAccount extends RosterEntry {
  index: number
  address: string
  privkey: Uint8Array
}

/** The roster with its keys. Pure: derives, writes nothing. */
export function deriveRoster(count = ROSTER.length): WorldAccount[] {
  const wanted = ROSTER.slice(0, count)
  const accounts = mnemonicToAccounts(WORLD_MNEMONIC, wanted.length)
  return wanted.map((entry, i) => ({
    ...entry,
    index: i,
    address: accounts[i]!.address,
    privkey: accounts[i]!.privkey
  }))
}

export function bySlug(accounts: WorldAccount[], slug: string): WorldAccount {
  const found = accounts.find((a) => a.slug === slug)
  if (!found) throw new Error(`no such account: ${slug} (try: ${accounts.map((a) => a.slug).join(', ')})`)
  return found
}
