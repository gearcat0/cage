// The seeded world.
//
// Built so that opening any account shows something worth looking at, and so
// that the trust surfaces have real shape rather than a single hand-made case:
// a contract signed by everyone it names, one still waiting on two signatures,
// one carrying a signature it never asked for, an article with attestations
// that are partly inside your tribe and partly not, and a vouch graph with
// genuine one-hop, two-hop, and unreachable keys.

import { author, cosign, deliver, introduce, publish, type Delivered } from './author.js'
import type { OpenAccount } from './account.js'

const DAY = 86_400
/** A fixed base time so a rebuilt world has the same timestamps. 2026-06-01. */
const T0 = 1_780_272_000

type Cast = Record<string, OpenAccount>

const cast = (accounts: OpenAccount[]): Cast =>
  Object.fromEntries(accounts.map((a) => [a.who.slug, a])) as Cast

/** Who knows whom, by name. Petnames are local, so this is applied per library
 *  and is deliberately NOT symmetric -- knowing someone is not mutual. */
function introductions(c: Cast, log: (s: string) => void): void {
  const press = ['ada', 'grace', 'alan', 'katherine', 'dorothy', 'mary', 'joan', 'edith']
  const law = ['thurgood', 'sandra', 'ruth', 'oliver', 'clara', 'benjamin', 'ida']

  // Colleagues know each other by name.
  for (const group of [press, law]) {
    for (const a of group) {
      for (const b of group) {
        if (a !== b) introduce(c[a]!, c[b]!, 'colleague')
      }
    }
  }
  // The lease brings two groups together.
  for (const [a, b] of [
    ['ada', 'thurgood'],
    ['thurgood', 'ada'],
    ['rosalind', 'thurgood'],
    ['thurgood', 'rosalind'],
    ['linus', 'thurgood'],
    ['thurgood', 'linus'],
    ['rosalind', 'linus'],
    ['linus', 'rosalind']
  ] as [string, string][]) {
    introduce(c[a]!, c[b]!, 'the Vale Street lease')
  }
  // Freelancers are known to the editor who commissions them, and not to the
  // rest of the newsroom -- which is what makes a tribe two hops deep.
  for (const f of ['hedy', 'claude', 'emmy', 'srinivasa']) {
    introduce(c.ada!, c[f]!, 'commissioned')
    introduce(c[f]!, c.ada!, 'my editor')
  }
  log('  names: colleagues, the lease counterparties, and Ada’s freelancers')
}

/** Vouches: signed, public, and only meaningful along a path from YOU.
 *
 *  Shaped to produce all three cases in the UI -- keys you vouched for (1 hop),
 *  keys reached through them (2 hops), and strangers nobody you trust has ever
 *  vouched for, which must show no badge at all. */
async function vouches(c: Cast, log: (s: string) => void): Promise<void> {
  const edges: [string, string, string][] = [
    // Ada's own vouches: her newsroom and the lawyer she works with.
    ['ada', 'grace', 'reporter, five years'],
    ['ada', 'alan', 'reporter'],
    ['ada', 'katherine', 'checks my copy'],
    ['ada', 'thurgood', 'our solicitor'],
    // One hop further: what Ada's people vouch for becomes her 2-hop tribe.
    ['grace', 'mary', 'shoots for me'],
    ['grace', 'hedy', 'freelance, reliable'],
    ['alan', 'joan', 'desk'],
    ['katherine', 'dorothy', 'checks with me'],
    ['thurgood', 'sandra', 'partner'],
    ['thurgood', 'ruth', 'solicitor'],
    ['thurgood', 'rosalind', 'client'],
    // Three hops from Ada -- deliberately OUTSIDE her tribe, to prove the cap.
    ['sandra', 'clara', 'clerk'],
    ['ruth', 'benjamin', 'clerk'],
    ['mary', 'srinivasa', 'illustrator'],
    // A cluster with no path to Ada at all.
    ['linus', 'dorothyh', 'surveyor'],
    ['dorothyh', 'barbara', 'tenant']
  ]
  let n = 0
  for (const [from, to, relation] of edges) {
    const voucher = c[from]!
    const subject = c[to]!
    // Everyone who could plausibly hold it: the voucher, the subject, and the
    // voucher's own circle -- a vouch you never received cannot count for you.
    const holders = [voucher, subject, c.ada!, c.thurgood!]
    await publish(
      voucher,
      {
        type: 'vouch',
        created: T0 + n * 600,
        args: { about: subject.who.address, aboutScheme: 'eth-eip191', name: subject.who.name, relation, note: '' }
      },
      holders
    )
    n++
  }
  log(`  vouches: ${edges.length} signed (Ada reaches 1- and 2-hop keys; some clusters reach her not at all)`)
}

/** A contract everyone named actually signed. */
async function signedContract(c: Cast, log: (s: string) => void): Promise<Delivered> {
  const parties = [c.linus!, c.rosalind!]
  const witnesses = [c.thurgood!, c.ruth!]
  const all = [...parties, ...witnesses, c.ada!]
  const tar = await author(c.linus!, {
    type: 'contract',
    created: T0 + 3 * DAY,
    args: {
      title: 'Vale Street lease',
      body:
        'The landlord lets and the tenant takes the premises at 14 Vale Street for a term of twelve months ' +
        'from 1 July 2026, at a rent of £1,150 per calendar month payable in advance.\n\n' +
        'The tenant shall keep the interior in good repair, fair wear and tear excepted.',
      signers: [
        { key: c.linus!.who.address, scheme: 'eth-eip191', role: 'landlord', name: c.linus!.who.name },
        { key: c.rosalind!.who.address, scheme: 'eth-eip191', role: 'tenant', name: c.rosalind!.who.name },
        { key: c.thurgood!.who.address, scheme: 'eth-eip191', role: 'witness', name: c.thurgood!.who.name },
        { key: c.ruth!.who.address, scheme: 'eth-eip191', role: 'witness', name: c.ruth!.who.name }
      ]
    }
  })
  const out = deliver(tar, all)
  // Each named signatory adds their own envelope over the same manifest bytes.
  for (const [i, signer] of [c.rosalind!, c.thurgood!, c.ruth!].entries()) {
    deliver(await cosign(signer, tar, T0 + 3 * DAY + (i + 1) * 3600), all)
  }
  log('  contract: Vale Street lease — 4 of 4 signed')
  return out
}

/** One still waiting, so the "not a score" wording is on screen. */
async function pendingContract(c: Cast, log: (s: string) => void): Promise<void> {
  const all = [c.sandra!, c.thurgood!, c.barbara!, c.ada!]
  const tar = await author(c.sandra!, {
    type: 'contract',
    created: T0 + 5 * DAY,
    args: {
      title: 'Consultancy agreement — Harbour & Vale / B. McClintock',
      body:
        'The consultant shall provide advisory services on plant genetics matters arising in the ' +
        'firm’s agricultural practice, at a day rate to be agreed in writing before each engagement.',
      signers: [
        { key: c.sandra!.who.address, scheme: 'eth-eip191', role: 'partner', name: c.sandra!.who.name },
        { key: c.barbara!.who.address, scheme: 'eth-eip191', role: 'consultant', name: c.barbara!.who.name },
        { key: c.thurgood!.who.address, scheme: 'eth-eip191', role: 'witness', name: c.thurgood!.who.name },
        { key: c.oliver!.who.address, scheme: 'eth-eip191', role: 'witness', name: c.oliver!.who.name }
      ]
    }
  })
  deliver(tar, all)
  deliver(await cosign(c.barbara!, tar, T0 + 5 * DAY + 7200), all)
  log('  contract: consultancy — 2 of 4 signed (unsigned is not half-valid)')
}

/** And one carrying a signature nobody asked for. */
async function uninvitedSignature(c: Cast, log: (s: string) => void): Promise<void> {
  const all = [c.oliver!, c.clara!, c.kestrel!, c.ada!]
  const tar = await author(c.oliver!, {
    type: 'contract',
    created: T0 + 6 * DAY,
    args: {
      title: 'Deed of variation — Unit 4, Harbour Yard',
      body: 'The parties agree that clause 7 (assignment) is deleted and replaced as set out in the schedule.',
      signers: [
        { key: c.oliver!.who.address, scheme: 'eth-eip191', role: 'solicitor', name: c.oliver!.who.name },
        { key: c.clara!.who.address, scheme: 'eth-eip191', role: 'witness', name: c.clara!.who.name }
      ]
    }
  })
  deliver(tar, all)
  deliver(await cosign(c.clara!, tar, T0 + 6 * DAY + 3600), all)
  // Not named, and signing anyway. The signature is real; the document simply
  // never asked for it, and the shell says so rather than hiding it.
  deliver(await cosign(c.kestrel!, tar, T0 + 6 * DAY + 9000), all)
  log('  contract: deed of variation — 2 of 2 signed, plus 1 not named')
}

/** An article, and people putting their signature behind a claim about it. */
async function articleWithAttestations(c: Cast, log: (s: string) => void): Promise<void> {
  const readers = Object.values(c)
  const published = await publish(
    c.grace!,
    {
      type: 'article',
      created: T0 + 8 * DAY,
      args: {
        headline: 'Harbour Yard redevelopment approved after two-year inquiry',
        standfirst: 'Councillors voted seven to four in favour, ending the longest planning inquiry in the borough’s history.',
        byline: c.grace!.who.name,
        publisher: 'Meridian Press',
        published: '2026-06-09',
        location: 'Harbour Yard',
        body: [
          { kind: 'p', text: 'The committee approved the scheme on Tuesday evening after a hearing that ran past eleven o’clock.' },
          { kind: 'h2', text: 'What was decided' },
          { kind: 'p', text: 'Consent covers 240 homes, a school, and the retention of the listed crane on the eastern quay.' },
          { kind: 'p', text: 'Objectors have six weeks in which to seek judicial review.' }
        ]
      }
    },
    readers
  )

  // Three attesters Ada reaches through her own vouches, and two she does not:
  // the count is free to manufacture, the tribe half is not.
  const attesters: [OpenAccount, string][] = [
    [c.katherine!, 'Accurately reproduced from the original source'],
    [c.alan!, 'I witnessed this'],
    [c.mary!, 'I have read this'],
    [c.quill!, 'Accurately reproduced from the original source'],
    [c.marlow!, 'I have read this']
  ]
  for (const [i, [who, statement]] of attesters.entries()) {
    await publish(
      who,
      {
        type: 'attestation',
        created: T0 + 8 * DAY + (i + 1) * 5400,
        args: { attests: published.envelopeHash, statement, note: '' }
      },
      readers
    )
  }
  log('  article: Harbour Yard — 5 attestations, 3 of them in Ada’s tribe')
}

/** Everyday content, so a feed is not one contract and a void. */
async function everyday(c: Cast, log: (s: string) => void): Promise<void> {
  let n = 0
  for (const a of Object.values(c)) {
    await publish(a, {
      type: 'nametag',
      created: T0 + 10 * DAY + n * 300,
      args: { name: a.who.name, subtitle: a.who.role }
    })
    n++
  }
  const press = ['ada', 'grace', 'alan', 'katherine', 'dorothy', 'mary', 'joan', 'edith'].map((s) => c[s]!)
  await publish(
    c.joan!,
    {
      type: 'memo',
      created: T0 + 11 * DAY,
      args: {
        to: 'All desks',
        from: c.joan!.who.name,
        subject: 'Copy deadlines move to 16:00 from Monday',
        body: 'The print slot has been brought forward an hour. Filed copy after 16:00 will hold to the next edition.'
      }
    },
    press
  )
  await publish(
    c.mary!,
    {
      type: 'poster',
      created: T0 + 12 * DAY,
      args: { title: 'The crane at dusk', caption: 'Harbour Yard, the evening before the vote.', layout: 'auto', photos: [] }
    },
    press
  )
  log(`  everyday: ${n} nametags, a memo, a poster`)
}

export async function buildWorld(accounts: OpenAccount[], log: (s: string) => void): Promise<void> {
  const c = cast(accounts)
  introductions(c, log)
  await vouches(c, log)
  await signedContract(c, log)
  await pendingContract(c, log)
  await uninvitedSignature(c, log)
  await articleWithAttestations(c, log)
  await everyday(c, log)
}
