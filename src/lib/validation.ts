import type {
  DocumentStatus,
  LedgerEntryType,
  PaymentDirection,
  PaymentMethod,
} from '../types/database';

export const ROLE_LABELS = {
  owner: 'Owner',
  co_owner: 'Co-owner',
  manager: 'Manager',
  accountant: 'Accountant',
  staff: 'Staff',
} as const;
export const ASSIGNABLE_ROLES = ['co_owner', 'manager', 'accountant', 'staff'] as const;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
export function validDisplayName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && Array.from(name).length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
}
export function validBusinessName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && Array.from(name).length <= 120 && !/[\x00-\x1f\x7f]/.test(name);
}
export function utf8Length(value: string): number {
  let length = 0;
  // Index by UTF-16 code units explicitly: Expo's ES5 downleveling must not
  // turn a Unicode string iterator into an iteration over surrogate halves.
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point >= 0xd800 && point <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index++;
        continue;
      }
    }
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : 3;
  }
  return length;
}
export function passwordProblem(password: string, confirmation?: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (utf8Length(password) > 72)
    return 'Password must be at most 72 UTF-8 bytes (Supabase bcrypt limit).';
  if (confirmation !== undefined && password !== confirmation) return 'Passwords do not match.';
  return null;
}
export function extractInvitationToken(value: string): string | null {
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/.test(trimmed)) return trimmed;
  try {
    const match = /^ownerbook:\/\/invite\?token=([a-f0-9]{64})$/.exec(trimmed);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Phase 3 domain validation. Every rule here mirrors a constraint in the
 * `20261103000100_khata_sales_expenses` migration: the client validates so the
 * user gets an immediate, specific message, and the database validates so no
 * client — including a modified one — can store an invalid record.
 */
export const PHONE_PATTERN = /^\+?[0-9][0-9 \-()]{2,31}$/;
export function validCustomerName(value: string): boolean {
  const name = value.trim();
  return name.length > 0 && Array.from(name).length <= 120 && !/[\x00-\x1f\x7f]/.test(name);
}
export function validProductName(value: string): boolean {
  return validCustomerName(value);
}
export function validPhone(value: string): boolean {
  const phone = value.trim();
  return phone === '' || PHONE_PATTERN.test(phone);
}
export function validOptionalEmail(value: string): boolean {
  return value.trim() === '' || validEmail(value.trim().toLowerCase());
}
export function boundedText(value: string, max: number): boolean {
  return Array.from(value.trim()).length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
export function validReason(value: string): boolean {
  const reason = value.trim();
  return reason.length > 0 && Array.from(reason).length <= 200;
}
export function validCategory(value: string): boolean {
  const category = value.trim();
  return (
    category.length > 0 && Array.from(category).length <= 60 && !/[\x00-\x1f\x7f]/.test(category)
  );
}
export const PAYMENT_METHODS = [
  'cash',
  'bank',
  'mobile_wallet',
  'cheque',
  'credit',
  'other',
] as const satisfies readonly PaymentMethod[];
export const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank: 'Bank transfer',
  mobile_wallet: 'Mobile wallet',
  cheque: 'Cheque',
  credit: 'Credit (nothing received now)',
  other: 'Other',
};
/** Methods that move money; 'credit' is only valid on a sale that receives nothing. */
export const MONEY_METHODS: readonly PaymentMethod[] = [
  'cash',
  'bank',
  'mobile_wallet',
  'cheque',
  'other',
];
export const LEDGER_LABELS: Record<LedgerEntryType, string> = {
  opening_balance: 'Opening balance',
  sale: 'Sale',
  sale_void: 'Sale voided',
  payment: 'Payment',
  payment_void: 'Payment voided',
  adjustment: 'Adjustment',
};
export const DIRECTION_LABELS: Record<PaymentDirection, string> = {
  received: 'Received',
  refunded: 'Refunded',
};
export const STATUS_LABELS: Record<DocumentStatus, string> = {
  posted: 'Posted',
  voided: 'Voided',
};
export const ACTIVITY_LABELS: Record<string, string> = {
  'customer.created': 'Customer added',
  'customer.updated': 'Customer updated',
  'customer.archived': 'Customer archived',
  'customer.restored': 'Customer restored',
  'customer.debit_note': 'Debit note',
  'customer.credit_note': 'Credit note',
  'product.created': 'Item added',
  'product.updated': 'Item updated',
  'sale.created': 'Sale recorded',
  'sale.voided': 'Sale voided',
  'payment.received': 'Payment received',
  'payment.refunded': 'Payment refunded',
  'payment.voided': 'Payment voided',
  'expense.created': 'Expense recorded',
  'expense.voided': 'Expense voided',
};
