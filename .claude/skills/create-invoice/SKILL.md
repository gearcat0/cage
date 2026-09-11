---
name: create-invoice
description: Build invoice things programmatically — the args schema, the integer-only money model (minor units, thousandths, basis points) that a float will break, how totals are derived rather than supplied, and the logo attachment. Use when generating invoices from a billing system, importing accounting records, or emitting signed .thing invoices in bulk.
---

# Creating invoices programmatically

An invoice is a demand for payment: parties, line items, tax, and what is due.
It is a thing: `program` (`samples/invoice.html`), `args`, and optionally one
`attachments` entry for a logo.

If you have not built a thing before, read the `create-article` skill first:
the signer, the builder call, and the limits are the same. This covers what is
specific to invoices — and one constraint that will stop your script dead if
you ignore it.

## The constraint that shapes everything: no floats

Canonical CBOR forbids floating-point numbers (format §3). `jsToCbor` **throws**
on one. So `19.99` cannot be put in an invoice, and a generator that emits it
fails at signing time — far from the line that caused it.

Every number is an integer:

| field | unit | example |
|---|---|---|
| money (`unitPrice`, `shipping`, `amountPaid`, fixed `discountValue`) | **minor units** | `1999` → £19.99 |
| `quantity` | **thousandths** | `1500` → 1.5 hours |
| `taxRate`, `shippingTaxRate`, percent `discountValue` | **basis points** | `2000` → 20% |

This is not a workaround. It is how money should be held, and EN 16931 — the
European e-invoicing standard — independently requires "at most 2 fraction
digits" for monetary amounts. Your source system almost certainly stores
decimals; convert once, at the boundary:

```ts
const money = (decimal: string | number): number =>
  Math.round(Number(decimal) * 10 ** minorUnits)   // "19.99" -> 1999
const qty = (decimal: string | number): number =>
  Math.round(Number(decimal) * 1000)               // "1.5"   -> 1500
const rate = (percent: string | number): number =>
  Math.round(Number(percent) * 100)                // "20"    -> 2000
```

Use `Math.round`, not truncation: `0.1 + 0.2` arithmetic upstream will hand you
`19.989999999999998`, and `Math.floor` turns that into a penny short.

## Do not send totals

There is no `subtotal`, `tax` or `total` field, and adding one does nothing.
The program derives every total from the lines in front of the reader, so the
arithmetic shown is the arithmetic done. A stored total is a second claim that
can disagree with the lines above it.

What the program computes, in order:

1. **Line net** = `round(quantity × unitPrice / 1000)`, summed to the subtotal.
2. **Discount** — percent of the subtotal, or the fixed amount, capped at it.
3. **Taxable base** = subtotal − discount, spread across the lines **pro rata**
   so a discount reduces the taxable amount rather than being knocked off at
   the end (which would leave the tax overstated). The last line absorbs the
   rounding remainder so the bases sum exactly.
4. **Tax grouped BY RATE** — EN 16931 wants a breakdown a reader can check
   rate by rate, not one lump.
5. **Total** = taxable + tax + shipping + shipping tax.
6. **Amount due** = total − `amountPaid`.

So: get the lines right and the invoice is right.

## The args schema

```jsonc
{
  "invoiceNumber": "INV-2026-0042",
  "issued": "2026-09-11",          // plain ISO date strings, author's claim
  "due":    "2026-10-11",
  "poNumber": "PO-778",

  "currency":   "GBP",             // ISO 4217, shown via Intl in the READER's locale
  "minorUnits": 2,                 // 2 for GBP/USD/EUR, 0 for JPY, 3 for KWD

  "seller": {
    "name": "Harbour & Vale LLP",
    "address": "12 Harbour Yard\nLondon SE16 4RT",
    "email": "accounts@harbourvale.example",
    "phone": "+44 20 7946 0000",
    "taxLabel": "VAT",             // the LABEL is yours: VAT / EIN / ABN / GSTIN
    "taxId": "GB 418 2299 07",
    "reg": "Registered in England, OC392214",
    "country": "United Kingdom"
  },
  "buyer":  { /* same shape */ },
  "shipTo": { /* same shape; omit or leave empty when it is the buyer */ },

  "lines": [
    {
      "description": "Pre-publication review",
      "detail": "Two rounds, including the objectors' submissions.",
      "quantity":  6500,           // 6.5
      "unit":      "hours",        // FREE TEXT: hours, days, items, kg, licences
      "unitPrice": 24000,          // £240.00
      "taxRate":   2000            // 20%
    }
  ],

  "discountKind":  "percent",      // "percent" | "amount"
  "discountValue": 500,            // 5% here; minor units when kind is "amount"
  "shipping":        0,
  "shippingTaxRate": 0,
  "amountPaid":  50000,            // £500 already paid -> shows PART PAID

  "paymentTerms": "Net 30. Interest at 2% per month on overdue sums.",
  "paymentInstructions": "Sort 20-45-12  Account 4410 2298\nReference: HV-2026-0184",
  "notes": "Thank you.",
  "terms": "Fees are as agreed in our engagement letter of 3 March 2026."
}
```

Everything is optional. An invoice with no lines renders `Nothing itemised`
rather than breaking, which is what a fresh draft looks like.

### Fields worth care

- **`minorUnits` must match the currency.** `JPY` with `minorUnits: 2` prints
  `¥5,000.00`, which is wrong. 0 for JPY/KRW, 3 for KWD/BHD/JOD, 2 for most.
- **`taxLabel`** is the author's, because the right word differs by country.
  Set it from the seller's jurisdiction, not from a hardcoded "VAT".
- **`unit`** is free text and rendered as given — this is what lets one program
  invoice hours, kilograms, licences or widgets.
- **`taxRate` is per line.** Mixed rates are normal: standard-rated work, a
  reduced rate, and a zero-rated disbursement on one invoice.
- **`shipTo`** appears only when non-empty. Do not copy the buyer into it "for
  completeness" — you will produce a ship-to block that says nothing.
- **`amountPaid`** greater than the total shows `OVERPAID`, deliberately. It is
  a real state and worth seeing rather than clamping.
- **`issued` / `due`** are strings, shown as given. They are the author's claim
  like every date in this system; there is no validation and no timezone.

## The logo

One optional attachment named exactly **`logo`**. Any MIME the cage's CSP will
render as an image (`image/png`, `image/jpeg`, `image/webp`, `image/gif`); the
in-app editor caps it at 8 MB. Anything else attaches fine and simply does not
display.

```ts
attachments: new Map([['logo', { bytes: new Uint8Array(readFileSync('logo.png')), mime: 'image/png' }]])
```

## Payment status is a claim frozen at signing

A thing is immutable. `amountPaid` is what the seller said when they signed, so
`PAID` / `PART PAID` means *as issued* — a payment made afterwards can never
appear on it. For a running balance, issue a new invoice or a receipt thing;
do not expect this one to age.

## Limits

**Admission** — bundle 256 MiB, manifest 1 MiB, envelope 64 KiB, 256
attachments, 4096 entries per array, 1 MiB per string.

**Drafts** (the in-app editor) — args 256 KiB, 32 MiB per blob, 64 MiB per
draft. The program reads at most **200 lines**; beyond that they are dropped.

## A working builder

```ts
// invoice.ts — run with: npx tsx invoice.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { buildBundle, jsToCbor } from './src/format/index.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'

function ethSigner(priv: Uint8Array) {
  const pub = secp256k1.getPublicKey(priv, false)
  return {
    scheme: 'eth-eip191',
    pubkey: keccak_256(pub.subarray(1)).subarray(12),
    async sign(input: Uint8Array): Promise<Uint8Array> {
      const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${input.length}`)
      const buf = new Uint8Array(prefix.length + input.length)
      buf.set(prefix, 0)
      buf.set(input, prefix.length)
      const recd = secp256k1.sign(keccak_256(buf), priv, { prehash: false, format: 'recovered' })
      const out = new Uint8Array(65)
      out.set(recd.subarray(1, 65), 0)
      out[64] = recd[0] // recovery id last
      return out
    }
  }
}

const MINOR = 2
const money = (d: string | number) => Math.round(Number(d) * 10 ** MINOR)
const qty = (d: string | number) => Math.round(Number(d) * 1000)
const rate = (p: string | number) => Math.round(Number(p) * 100)

async function main() {
  // Whatever your billing system hands you, in decimals.
  const source = [
    { desc: 'Pre-publication review', detail: 'Two rounds.', hours: '6.5', price: '240.00', vat: '20' },
    { desc: 'Advice on the retention condition', detail: '', hours: '2', price: '240.00', vat: '20' },
    { desc: 'Filing fee (disbursement)', detail: 'Paid on your behalf.', hours: '1', price: '115.00', vat: '0' }
  ]

  const tar = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    program: new Uint8Array(readFileSync('samples/invoice.html')),
    type: 'invoice',
    args: jsToCbor({
      invoiceNumber: 'HV-2026-0184',
      issued: '2026-06-10',
      due: '2026-07-10',
      currency: 'GBP',
      minorUnits: MINOR,
      seller: {
        name: 'Harbour & Vale LLP',
        address: '12 Harbour Yard\nLondon SE16 4RT',
        taxLabel: 'VAT',
        taxId: 'GB 418 2299 07',
        country: 'United Kingdom'
      },
      buyer: { name: 'Meridian Press Ltd', address: '4 Fleet Buildings\nLondon EC4Y 1AA' },
      lines: source.map((r) => ({
        description: r.desc,
        detail: r.detail,
        quantity: qty(r.hours),
        unit: 'hours',
        unitPrice: money(r.price),
        taxRate: rate(r.vat)
      })),
      discountKind: 'percent',
      discountValue: rate('5'),
      amountPaid: money('500.00'),
      paymentTerms: 'Net 30.',
      paymentInstructions: 'Sort 20-45-12  Account 4410 2298\nReference: HV-2026-0184'
    }),
    attachments: new Map([
      ['logo', { bytes: new Uint8Array(readFileSync('logo.png')), mime: 'image/png' }]
    ])
  })
  writeFileSync('out/HV-2026-0184.thing', tar)
}

main()
```

Wrap in `main()`: the repo has no `"type": "module"`, so `tsx` treats `.ts` as
CJS and top-level `await` fails.

## Common mistakes

- **A float anywhere in args.** `unitPrice: 19.99` throws at `jsToCbor`, not at
  render. Convert at the boundary and never again.
- **Truncating instead of rounding.** `Math.floor(19.99 * 100)` is `1998` when
  upstream floating point hands you `19.989999999999998`.
- **Sending a `total`.** There is no such field. Fix the lines instead.
- **`minorUnits` not matching the currency.** `¥5,000.00` is not a price.
- **Applying your own discount to the line prices.** Use `discountValue`, or the
  invoice cannot show what was discounted and the tax base will not match.
- **Hardcoding "VAT" as the tax label** for a US or Australian seller.
- **Copying the buyer into `shipTo`.** It then renders a redundant block; leave
  it empty unless delivery really differs.
- **Expecting `PAID` to update.** It is frozen at signing, like everything else
  in a thing.
