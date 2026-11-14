import {
  formatMoney,
  groupAmount,
  isNegativeAmount,
  lineTotal,
  multiplyAmounts,
  parseAmount,
  parseStoredAmount,
  roundAmount,
  subtractAmounts,
  toAmountText,
  totalOfLines,
} from '../src/lib/decimal';

/** The module's internal scale: 8 decimals, enough for quantity(3) × price(4). */
const INTERNAL_DECIMALS = 8;

/**
 * Money in OwnerBook is never a JavaScript number. These tests pin the exact
 * decimal behaviour the database implements, so the total previewed on a phone
 * is the total PostgreSQL stores.
 */
describe('exact decimal money', () => {
  const units = (text: string) => {
    const parsed = parseAmount(text, INTERNAL_DECIMALS);
    if (parsed === null) throw new Error(`test input is not a decimal: ${text}`);
    return parsed;
  };

  it('rejects anything that is not a plain signed decimal literal', () => {
    for (const junk of [
      '',
      '   ',
      'abc',
      '1e3',
      '1E3',
      '1,000',
      'PKR 500',
      '500 PKR',
      '0x10',
      '+5',
      '5.',
      '.5',
      '--5',
      '5-',
      'NaN',
      'Infinity',
      '1_000',
      '١٢٣',
    ])
      expect(parseAmount(junk, 2)).toBeNull();
  });

  it('accepts plain decimals and surrounding whitespace', () => {
    expect(toAmountText(units('500'), 2)).toBe('500.00');
    expect(toAmountText(units(' 500.50 '), 2)).toBe('500.50');
    expect(toAmountText(units('-12.345'), 3)).toBe('-12.345');
    expect(toAmountText(units('0'), 0)).toBe('0');
  });

  it('refuses more decimals than the caller allows', () => {
    expect(parseAmount('1.234', 2)).toBeNull();
    expect(parseAmount('1.234', 3)).not.toBeNull();
    expect(parseAmount('1.2345678', 6)).toBeNull();
  });

  it('multiplies exactly where binary floating point cannot', () => {
    // 3 × 0.1 is 0.30000000000000004 as a double.
    expect(toAmountText(multiplyAmounts(units('3'), units('0.1')), 2)).toBe('0.30');
    // 100 × 0.01
    expect(toAmountText(multiplyAmounts(units('100'), units('0.01')), 2)).toBe('1.00');
    // 1.5 × 199.999 = 299.9985, rounded half away from zero to 300.00
    expect(toAmountText(multiplyAmounts(units('1.5'), units('199.999')), 2)).toBe('300.00');
    // 0.07 × 100
    expect(toAmountText(multiplyAmounts(units('0.07'), units('100')), 2)).toBe('7.00');
  });

  it('rounds half away from zero, matching PostgreSQL round(numeric, int)', () => {
    expect(toAmountText(units('2.345'), 2)).toBe('2.35');
    expect(toAmountText(units('2.344'), 2)).toBe('2.34');
    expect(toAmountText(units('-2.345'), 2)).toBe('-2.35');
    expect(toAmountText(units('0.005'), 2)).toBe('0.01');
    expect(toAmountText(units('100.6'), 0)).toBe('101');
    expect(toAmountText(units('1.2345'), 3)).toBe('1.235');
  });

  it('never renders a negative zero', () => {
    expect(toAmountText(units('-0.001'), 2)).toBe('0.00');
    expect(toAmountText(units('-0.4'), 0)).toBe('0');
    expect(toAmountText(roundAmount(units('-0.001'), 2), 2)).toBe('0.00');
  });

  it('keeps the currency scales the app supports', () => {
    // JPY has no minor units.
    expect(toAmountText(units('1234'), 0)).toBe('1234');
    // KWD has three.
    expect(toAmountText(units('1.235'), 3)).toBe('1.235');
    // PKR has two.
    expect(toAmountText(units('2500'), 2)).toBe('2500.00');
  });

  it('sums already-rounded lines without drift', () => {
    const lines = [units('0.10'), units('0.10'), units('0.10')];
    expect(toAmountText(totalOfLines(lines), 2)).toBe('0.30');
    expect(toAmountText(subtractAmounts(units('10.00'), units('2.35')), 2)).toBe('7.65');
  });

  it('computes a sale line as round(quantity × price) − round(discount)', () => {
    expect(toAmountText(lineTotal(units('1.5'), units('199.999'), units('0'), 2), 2)).toBe(
      '300.00',
    );
    expect(toAmountText(lineTotal(units('3'), units('0.1'), units('0.05'), 2), 2)).toBe('0.25');
    expect(toAmountText(lineTotal(units('2'), units('10.005'), units('0'), 2), 2)).toBe('20.01');
  });

  it('reports sign without parsing text again', () => {
    expect(isNegativeAmount(units('-0.01'))).toBe(true);
    expect(isNegativeAmount(units('0.00'))).toBe(false);
    expect(isNegativeAmount(units('0.01'))).toBe(false);
  });

  it('groups and labels amounts for small screens', () => {
    expect(groupAmount('1234567.5')).toBe('1,234,567.5');
    expect(groupAmount('-1234.56')).toBe('-1,234.56');
    expect(groupAmount('999')).toBe('999');
    expect(formatMoney('1234.5', 'PKR')).toBe('PKR 1,234.5');
    expect(formatMoney('0.00', 'JPY')).toBe('JPY 0.00');
    expect(formatMoney('2500.00')).toBe('2,500.00');
  });

  it('throws rather than silently accepting a corrupt stored amount', () => {
    expect(() => parseStoredAmount('not-money')).toThrow(/Not a decimal amount/);
    expect(parseStoredAmount('12.34')).toBe(units('12.34'));
  });
});
