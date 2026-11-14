/**
 * Exact decimal money handling for the UI.
 *
 * Every amount in OwnerBook lives in PostgreSQL as `numeric` and travels to the
 * app as a decimal string. This module keeps it that way: values are parsed into
 * BigInt "units" at a fixed internal scale, so no JavaScript number (an IEEE-754
 * double) ever touches money. Rounding is half away from zero, which matches
 * PostgreSQL's `round(numeric, integer)` exactly, so the total previewed on the
 * phone is the total the database stores.
 *
 * The internal scale of 8 decimals covers every value the app can produce:
 * quantities carry at most 3 decimals and unit prices at most 4, so their product
 * needs at most 7. Inputs with more decimals than the server would store are
 * rejected rather than silently truncated.
 */
const INTERNAL_SCALE = 8;
const POW10: bigint[] = Array.from({ length: 20 }, (_, index) => 10n ** BigInt(index));

/** Looks up a power of ten, rejecting scales this module was never designed for. */
function pow10(exponent: number): bigint {
  const value = POW10[exponent];
  if (value === undefined) throw new Error(`Unsupported decimal scale: ${exponent}`);
  return value;
}

export const PRICE_SCALE = 4;
export const QUANTITY_SCALE = 3;
/** Matches the server's `private.parse_decimal`: a plain signed decimal literal. */
const DECIMAL_PATTERN = /^(-?)(\d{1,13})(?:\.(\d+))?$/;

export type Units = bigint;

function roundHalfAwayFromZero(units: bigint, divisor: bigint): bigint {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / divisor;
  const remainder = magnitude % divisor;
  const rounded = remainder * 2n >= divisor ? whole + 1n : whole;
  return negative ? -rounded : rounded;
}

/**
 * Parses user or database input into internal units.
 * Returns null when the text is empty, malformed, uses scientific notation, a
 * thousands separator, a currency symbol, or carries more decimals than allowed.
 */
export function parseAmount(input: string, maxScale: number): Units | null {
  const match = DECIMAL_PATTERN.exec(input.trim());
  if (!match) return null;
  const whole = match[2];
  if (whole === undefined) return null;
  const fraction = match[3] ?? '';
  if (fraction.length > maxScale) return null;
  const units =
    BigInt(whole) * pow10(INTERNAL_SCALE) + BigInt(fraction.padEnd(INTERNAL_SCALE, '0'));
  return match[1] === '-' ? -units : units;
}

/** Parses a database decimal string, which is always valid; throws otherwise. */
export function parseStoredAmount(input: string): Units {
  const units = parseAmount(input, INTERNAL_SCALE);
  if (units === null) throw new Error(`Not a decimal amount: ${input}`);
  return units;
}

/** Renders internal units with exactly `scale` decimals, rounded half away from zero. */
export function toAmountText(units: Units, scale: number): string {
  const rounded = roundHalfAwayFromZero(units, pow10(INTERNAL_SCALE - scale));
  // A rounded zero is never negative, so the UI cannot show "-0.00".
  if (rounded === 0n) return scale === 0 ? '0' : `0.${'0'.repeat(scale)}`;
  const negative = rounded < 0n;
  const magnitude = negative ? -rounded : rounded;
  const divisor = pow10(scale);
  const integerPart = magnitude / divisor;
  const fractionPart = magnitude % divisor;
  const text =
    scale === 0
      ? integerPart.toString()
      : `${integerPart}.${fractionPart.toString().padStart(scale, '0')}`;
  return negative ? `-${text}` : text;
}

/** Rounds internal units to a currency scale and returns the canonical text. */
export function roundAmount(units: Units, scale: number): Units {
  const step = pow10(INTERNAL_SCALE - scale);
  return roundHalfAwayFromZero(units, step) * step;
}

export function addAmounts(...values: Units[]): Units {
  return values.reduce((total: Units, value) => total + value, 0n);
}

export function subtractAmounts(left: Units, right: Units): Units {
  return left - right;
}

/** Exact product of two scaled values, rounded back to the internal scale. */
export function multiplyAmounts(left: Units, right: Units): Units {
  return roundHalfAwayFromZero(left * right, pow10(INTERNAL_SCALE));
}

export function compareAmounts(left: Units, right: Units): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isZeroAmount(value: Units): boolean {
  return value === 0n;
}

export function isNegativeAmount(value: Units): boolean {
  return value < 0n;
}

/** Groups the integer part in threes: 1234567.5 -> 1,234,567.5 */
export function groupAmount(amountText: string): string {
  const negative = amountText.startsWith('-');
  const unsigned = negative ? amountText.slice(1) : amountText;
  const [integerPart, fractionPart] = unsigned.split('.');
  const digits = integerPart ?? '0';
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
  return negative ? `-${text}` : text;
}

/** Display form used across the app: "PKR 1,234.56". */
export function formatMoney(amountText: string, currency?: string | null): string {
  const grouped = groupAmount(amountText);
  return currency ? `${currency} ${grouped}` : grouped;
}

/**
 * Exact line total for a sale preview: round(quantity × unit price) − discount,
 * each rounded to the currency scale exactly as `public.create_sale` does.
 */
export function lineTotal(
  quantity: Units,
  unitPrice: Units,
  discount: Units,
  scale: number,
): Units {
  const gross = roundAmount(multiplyAmounts(quantity, unitPrice), scale);
  return subtractAmounts(gross, roundAmount(discount, scale));
}

/** Sums already-rounded line totals, so the preview equals the stored total. */
export function totalOfLines(lineTotals: Units[]): Units {
  return addAmounts(...lineTotals);
}
