import {
  emptyLine,
  previewSale,
  type SaleDraft,
  type SaleLineDraft,
} from '../src/lib/sales-service';

function draft(lines: Partial<SaleLineDraft>[], overrides: Partial<SaleDraft> = {}): SaleDraft {
  return {
    businessId: 'biz',
    customerId: 'customer',
    date: '2026-11-06',
    // Arithmetic cases default to credit so they test totals, not payment rules.
    method: 'credit',
    paidAmount: '',
    scale: 2,
    lines: lines.map((line, index) => ({ ...emptyLine(`line-${index}`), ...line })),
    ...overrides,
  };
}

/**
 * The preview must agree with `public.create_sale` line for line, because both
 * round each line before summing. These cases are the same ones the PostgreSQL
 * ledger suite asserts against the stored document.
 */
describe('sale preview arithmetic', () => {
  it('sums three tenths as 0.30, not 0.30000000000000004', () => {
    const preview = previewSale(
      draft([
        { itemName: 'a', quantity: '1', unitPrice: '0.1' },
        { itemName: 'b', quantity: '1', unitPrice: '0.1' },
        { itemName: 'c', quantity: '1', unitPrice: '0.1' },
      ]),
    );
    expect(preview.problem).toBeNull();
    expect(preview.subtotal).toBe('0.30');
    expect(preview.total).toBe('0.30');
  });

  it('rounds each line before summing, exactly as the server does', () => {
    // 1.5 × 199.999 = 299.9985 -> 300.00 per line; two lines are 600.00.
    const preview = previewSale(
      draft([
        { itemName: 'rice', quantity: '1.5', unitPrice: '199.999' },
        { itemName: 'rice', quantity: '1.5', unitPrice: '199.999' },
      ]),
    );
    expect(preview.problem).toBeNull();
    expect(preview.lines.map((line) => line.total)).toEqual(['300.00', '300.00']);
    expect(preview.total).toBe('600.00');
  });

  it('keeps subtotal, discounts and total consistent', () => {
    const preview = previewSale(
      draft([
        { itemName: 'a', quantity: '2', unitPrice: '10.005', discount: '0.01' },
        { itemName: 'b', quantity: '1', unitPrice: '5', discount: '1.5' },
      ]),
    );
    expect(preview.problem).toBeNull();
    expect(preview.subtotal).toBe('25.01');
    expect(preview.discountTotal).toBe('1.51');
    expect(preview.total).toBe('23.50');
  });

  it('calculates cost of goods from the cost recorded on each line', () => {
    const preview = previewSale(
      draft([
        { itemName: 'a', quantity: '3', unitPrice: '100', unitCost: '60.5' },
        { itemName: 'b', quantity: '1', unitPrice: '50', unitCost: '' },
      ]),
    );
    expect(preview.problem).toBeNull();
    expect(preview.cogs).toBe('181.50');
    expect(preview.lines.map((line) => line.cogs)).toEqual(['181.50', '0.00']);
  });

  it('reports the due amount on a partially paid credit sale', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '2000.75' }], {
        method: 'cash',
        paidAmount: '500',
      }),
    );
    expect(preview.problem).toBeNull();
    expect(preview.total).toBe('2000.75');
    expect(preview.paid).toBe('500.00');
    expect(preview.due).toBe('1500.75');
  });

  it('treats a credit sale as fully due with no money received', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], { method: 'credit' }),
    );
    expect(preview.problem).toBeNull();
    expect(preview.paid).toBe('0.00');
    expect(preview.due).toBe('250.00');
  });

  it('rejects money received on a credit sale', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], {
        method: 'credit',
        paidAmount: '10',
      }),
    );
    expect(preview.problem).toMatch(/credit sale records no money/i);
  });

  it('rejects a cash sale that receives nothing', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], { method: 'cash' }),
    );
    expect(preview.problem).toMatch(/choose .credit. when nothing is received/i);
  });

  it('rejects overpayment', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], {
        method: 'cash',
        paidAmount: '250.01',
      }),
    );
    expect(preview.problem).toMatch(/cannot be larger than the sale total/i);
  });

  it('rejects a negative amount received', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], {
        method: 'cash',
        paidAmount: '-5',
      }),
    );
    expect(preview.problem).toMatch(/cannot be negative/i);
  });

  it('insists a counter sale settles in full', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], {
        customerId: null,
        method: 'cash',
        paidAmount: '100',
      }),
    );
    expect(preview.problem).toMatch(/must be paid in full/i);
  });

  it('explains an amount that cannot be parsed instead of assuming zero', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '250' }], { paidAmount: '1,000' }),
    );
    expect(preview.problem).toMatch(/plain number/i);
  });

  it('rejects a line discount larger than the line', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '10', discount: '10.01' }]),
    );
    expect(preview.problem).toMatch(/discount cannot be larger/i);
    expect(preview.lines[0]?.valid).toBe(false);
  });

  it('rejects incomplete lines and says which rule failed', () => {
    expect(previewSale(draft([{ itemName: '', quantity: '1', unitPrice: '10' }])).problem).toMatch(
      /name, a quantity and a price/i,
    );
    expect(
      previewSale(draft([{ productId: 'p1', quantity: '0', unitPrice: '10' }])).problem,
    ).toMatch(/check the quantity/i);
    expect(previewSale(draft([{ itemName: 'a', quantity: '1', unitPrice: '' }])).problem).toMatch(
      /name, a quantity and a price/i,
    );
    expect(previewSale(draft([])).problem).toMatch(/at least one line/i);
  });

  it('rejects a sale that would total zero', () => {
    const preview = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '10', discount: '10' }], {
        paidAmount: '0',
        method: 'credit',
      }),
    );
    expect(preview.problem).toMatch(/greater than zero/i);
  });

  it('uses the currency scale of the business, not two decimals everywhere', () => {
    const jpy = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '100.6' }], {
        scale: 0,
        method: 'credit',
      }),
    );
    expect(jpy.problem).toBeNull();
    expect(jpy.total).toBe('101');
    expect(jpy.due).toBe('101');
    const kwd = previewSale(
      draft([{ itemName: 'a', quantity: '1', unitPrice: '1.2345' }], {
        scale: 3,
        method: 'credit',
      }),
    );
    expect(kwd.total).toBe('1.235');
  });

  it('never loses the lines it could not price', () => {
    const preview = previewSale(
      draft([
        { itemName: 'a', quantity: '1', unitPrice: '10' },
        { itemName: '', quantity: '1', unitPrice: '10' },
      ]),
    );
    expect(preview.lines).toHaveLength(2);
    expect(preview.lines[1]?.valid).toBe(false);
    // Nothing is charged while a line is wrong.
    expect(preview.total).toBe('0.00');
  });
});
