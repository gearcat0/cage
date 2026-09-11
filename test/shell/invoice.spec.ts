import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, launchShell, buildBundle, ethSigner, secp256k1, jsToCbor, type ShellHandle } from './helpers.js'

// ── Invoice ──────────────────────────────────────────────────────────────────
// A demand for payment, signed by whoever is demanding it. The signature proves
// who is asking — not that the amounts are right, that anything was delivered,
// or that the buyer agreed.
//
// The numbers are the interesting part. Canonical CBOR forbids floats, so an
// invoice cannot store 19.99: money is minor units, quantities are thousandths,
// tax rates are basis points. That is not a workaround, it is how money should
// be held anyway, and EN 16931 independently caps monetary amounts at two
// fraction digits. What is pinned here is that the arithmetic done on those
// integers comes out right.

const INVOICE = readFileSync(join(__dirname, '..', '..', 'samples', 'invoice.html'))

let shell: ShellHandle
test.beforeEach(async () => {
  shell = await launchShell()
})
test.afterEach(async () => {
  await shell?.close()
})

interface ModeState {
  activeMode: 'view' | 'edit'
  viewWcId: number | null
  editWcId: number | null
}

async function thingEval<T>(js: string, which: 'view' | 'edit' = 'view'): Promise<T> {
  return shell.app.evaluate(
    async (electron, a) => {
      const s = (electron.app as unknown as { __shell: { modeState: () => ModeState } }).__shell.modeState()
      const id = a.which === 'edit' ? s?.editWcId : s?.viewWcId
      if (id == null) throw new Error(`no ${a.which} cage`)
      const wc = electron.webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error('cage wc gone')
      return (await wc.executeJavaScript(a.js)) as never
    },
    { which, js }
  )
}

/** Publish an invoice with these args and open it in view mode. */
async function openInvoice(args: Record<string, unknown>): Promise<void> {
  const bundle = await buildBundle(ethSigner(secp256k1.utils.randomSecretKey()), {
    type: 'invoice',
    program: new Uint8Array(INVOICE),
    args: jsToCbor(args)
  })
  const outcome = await shell.ingest(bundle)
  expect(outcome.status, JSON.stringify(outcome)).toBe('valid')
  await shell.openThing(outcome.envelopeHash as string)
  await expect
    .poll(() => thingEval<boolean>(`!!document.getElementById('invoice-total')`), { timeout: 20_000 })
    .toBe(true)
}

const LINE = (q: number, price: number, tax: number, desc = 'Work'): Record<string, unknown> => ({
  description: desc,
  detail: '',
  quantity: q,
  unit: 'hours',
  unitPrice: price,
  taxRate: tax
})

test('a float in the args is refused outright — money must be integers', () => {
  // The constraint that shapes the whole data model. 19.99 cannot be signed,
  // so it is stored as 1999 minor units instead.
  expect(() => jsToCbor({ unitPrice: 19.99 })).toThrow(/non-integer|float/i)
  expect(() => jsToCbor({ unitPrice: 1999 })).not.toThrow()
})

test('line amounts, tax by rate, and the total are computed from the lines', async () => {
  // 1.5 h @ £80.00 = £120.00, plus 2 items @ £10.00 = £20.00. Tax 20% on both.
  await openInvoice({
    invoiceNumber: 'INV-1',
    currency: 'GBP',
    minorUnits: 2,
    seller: { name: 'Acme Ltd' },
    buyer: { name: 'A Customer' },
    lines: [LINE(1500, 8000, 2000), { ...LINE(2000, 1000, 2000), unit: 'items', description: 'Widgets' }]
  })
  const totals = await thingEval<string>(`document.getElementById('invoice-totals').textContent`)
  expect(totals).toContain('£140.00') // subtotal
  expect(totals).toContain('£28.00') // 20% of 140
  const total = await thingEval<string>(`document.getElementById('invoice-total').textContent`)
  expect(total).toContain('£168.00')
})

test('two tax rates are broken out separately, never lumped', async () => {
  // EN 16931 wants the breakdown BY RATE so a reader can check each one.
  await openInvoice({
    currency: 'GBP',
    minorUnits: 2,
    lines: [LINE(1000, 10000, 2000, 'Standard rated'), LINE(1000, 10000, 500, 'Reduced rated')]
  })
  const totals = await thingEval<string>(`document.getElementById('invoice-totals').textContent`)
  expect(totals).toMatch(/20%/)
  expect(totals).toMatch(/5%/)
  expect(totals).toContain('£20.00') // 20% of 100
  expect(totals).toContain('£5.00') // 5% of 100
  expect(await thingEval<string>(`document.getElementById('invoice-total').textContent`)).toContain('£225.00')
})

test('a discount reduces the taxable base, not just the bottom line', async () => {
  // Knocking a discount off at the end would leave the tax overstated.
  await openInvoice({
    currency: 'GBP',
    minorUnits: 2,
    discountKind: 'percent',
    discountValue: 1000, // 10%
    lines: [LINE(1000, 10000, 2000)]
  })
  const totals = await thingEval<string>(`document.getElementById('invoice-totals').textContent`)
  expect(totals).toContain('£10.00') // the discount
  expect(totals).toContain('£18.00') // 20% of 90, NOT 20 of 100
  expect(await thingEval<string>(`document.getElementById('invoice-total').textContent`)).toContain('£108.00')
})

test('a part payment shows what is actually due', async () => {
  await openInvoice({
    currency: 'GBP',
    minorUnits: 2,
    amountPaid: 5000,
    lines: [LINE(1000, 10000, 0)]
  })
  expect(await thingEval<string>(`document.getElementById('invoice-due').textContent`)).toContain('£50.00')
  // And says so at the top, as the seller's claim when it was signed.
  expect(await thingEval<string>(`document.getElementById('invoice-stamp').textContent`)).toBe('PART PAID')
})

test('a currency with no decimal places is not given any', async () => {
  await openInvoice({
    currency: 'JPY',
    minorUnits: 0,
    lines: [LINE(1000, 5000, 0, 'Consulting')]
  })
  const total = await thingEval<string>(`document.getElementById('invoice-total').textContent`)
  expect(total).toMatch(/5,?000/)
  expect(total).not.toContain('.00')
})

test('a separate shipping address appears only when there is one', async () => {
  await openInvoice({
    currency: 'GBP',
    minorUnits: 2,
    seller: { name: 'Acme Ltd', taxLabel: 'VAT', taxId: 'GB123456789' },
    buyer: { name: 'A Customer' },
    lines: [LINE(1000, 1000, 0)]
  })
  expect(await thingEval<number>(`document.querySelectorAll('#invoice-shipto').length`)).toBe(0)
  // The seller's tax id is shown with the label they chose — VAT, EIN, ABN.
  expect(await thingEval<string>(`document.getElementById('invoice-seller').textContent`)).toContain('VAT: GB123456789')

  await openInvoice({
    currency: 'GBP',
    minorUnits: 2,
    seller: { name: 'Acme Ltd' },
    buyer: { name: 'A Customer', address: 'Billing Road' },
    shipTo: { name: 'A Warehouse', address: 'Dock 4' },
    lines: [LINE(1000, 1000, 0)]
  })
  expect(await thingEval<string>(`document.getElementById('invoice-shipto').textContent`)).toContain('A Warehouse')
})

test('an empty invoice renders rather than breaking', async () => {
  // A draft is opened before anything is typed into it.
  await openInvoice({})
  expect(await thingEval<string>(`document.getElementById('invoice-lines').getAttribute('data-count')`)).toBe('0')
  expect(await thingEval<string>(`document.getElementById('invoice-lines').textContent`)).toContain('Nothing itemised')
})

test('it claims only what a signature can carry', async () => {
  await openInvoice({ currency: 'GBP', minorUnits: 2, lines: [LINE(1000, 1000, 0)] })
  const weight = await thingEval<string>(`document.getElementById('invoice-weight').textContent`)
  expect(weight).toMatch(/proves who is asking/i)
  expect(weight).toMatch(/does not prove the amounts are right/i)
  expect(weight).toMatch(/delivered|buyer agreed/i)
})

test('typing 19.99 into a price stores 1999, so it can actually be signed', async () => {
  // The whole point of minor units, and the failure it prevents: a float in
  // args is refused at SIGNING time, so an edit UI that emitted 19.99 would
  // produce a draft that could never be published. What the human types is
  // decimal; what leaves is an integer.
  test.setTimeout(60_000)
  const types = await shell.knownTypes()
  const invoice = types.find((t) => t.testKey === 'starter-invoice')!
  const created = await shell.newDraft(invoice.key, {})
  expect(created.id, JSON.stringify(created)).toBeTruthy()
  await shell.openThing(created.id!)
  await expect
    .poll(() => thingEval<boolean>(`!!document.getElementById('line-add')`, 'edit'), { timeout: 20_000 })
    .toBe(true)

  await thingEval(`document.getElementById('line-add').click()`, 'edit')
  await thingEval(
    `(() => {
       const p = document.getElementById('line-price-0')
       p.value = '19.99'
       p.dispatchEvent(new Event('input', { bubbles: true }))
       const q = document.getElementById('line-qty-0')
       q.value = '2.5'
       q.dispatchEvent(new Event('input', { bubbles: true }))
     })()`,
    'edit'
  )

  const drafted = await expect
    .poll(
      async () => {
        const d = await shell.drafts()
        const args = d[0]?.args as { lines?: { unitPrice?: number; quantity?: number }[] } | undefined
        return args?.lines?.[0]?.unitPrice ?? null
      },
      { timeout: 20_000 }
    )
    .toBe(1999)
  void drafted

  const args = (await shell.drafts())[0]!.args as { lines: { unitPrice: number; quantity: number }[] }
  expect(args.lines[0]!.unitPrice, '£19.99 is 1999 minor units').toBe(1999)
  expect(args.lines[0]!.quantity, '2.5 hours is 2500 thousandths').toBe(2500)
  // And it is signable: no float anywhere in what would be stored.
  expect(() => jsToCbor(args)).not.toThrow()
})
