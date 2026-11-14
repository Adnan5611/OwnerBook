import type { OwnerBookClient } from './supabase';
import type {
  AdjustmentResult,
  CustomerBalanceResult,
  CustomerResult,
  CustomerRow,
  PaymentDirection,
  PaymentMethod,
  PaymentResult,
  PaymentRow,
  PaymentVoidResult,
  StatementResult,
} from '../types/database';
import { postExactlyOnce } from './posting';
import { validationError } from './errors';
import {
  boundedText,
  normalizeEmail,
  validCustomerName,
  validOptionalEmail,
  validPhone,
  validReason,
} from './validation';
import { isZeroAmount, parseAmount, toAmountText, type Units } from './decimal';

export type CustomerDraft = {
  businessId: string;
  customerId: string | null;
  name: string;
  phone: string;
  email: string;
  address: string;
  /** Decimal string; only ever sent when the khata is first opened. */
  openingBalance: string | null;
  scale: number;
};
export type PaymentDraft = {
  businessId: string;
  customerId: string;
  saleId: string | null;
  direction: PaymentDirection;
  amount: string;
  method: PaymentMethod;
  date: string;
  reference: string;
  note: string;
  scale: number;
};
export type AdjustmentDraft = {
  businessId: string;
  customerId: string;
  /** Signed decimal string: positive charges the customer, negative credits them. */
  amount: string;
  reason: string;
  note: string;
  date: string | null;
  scale: number;
};
export type ListOptions = {
  search?: string;
  includeArchived?: boolean;
  customerId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
  offset?: number;
};

/** Parses and re-renders an amount at the currency scale, or null when invalid. */
export function moneyAt(input: string, scale: number, maxScale = 6): string | null {
  const units: Units | null = parseAmount(input, maxScale);
  return units === null ? null : toAmountText(units, scale);
}

export async function listCustomers(
  client: OwnerBookClient,
  businessId: string,
  options: ListOptions = {},
): Promise<CustomerRow[]> {
  const { data, error } = await client.rpc('list_customers', {
    p_business_id: businessId,
    p_search: options.search?.trim() ? options.search.trim() : null,
    p_include_archived: options.includeArchived ?? false,
    p_limit: options.limit ?? 100,
    p_offset: options.offset ?? 0,
  });
  if (error) throw error;
  return data ?? [];
}

export async function customerBalance(
  client: OwnerBookClient,
  customerId: string,
): Promise<CustomerBalanceResult> {
  const { data, error } = await client.rpc('customer_balance', { p_customer_id: customerId });
  if (error) throw error;
  if (!data) throw validationError('That customer is no longer available.');
  return data;
}

export async function customerStatement(
  client: OwnerBookClient,
  customerId: string,
  options: { from?: string | null; to?: string | null; limit?: number } = {},
): Promise<StatementResult> {
  const { data, error } = await client.rpc('customer_statement', {
    p_customer_id: customerId,
    p_from: options.from ?? null,
    p_to: options.to ?? null,
    p_limit: options.limit ?? 100,
  });
  if (error) throw error;
  if (!data) throw validationError('That khata is no longer available.');
  return data;
}

export async function saveCustomer(
  client: OwnerBookClient,
  draft: CustomerDraft,
): Promise<CustomerResult> {
  if (!validCustomerName(draft.name))
    throw validationError('Enter a customer name of 1–120 characters.');
  if (!validPhone(draft.phone))
    throw validationError('Enter a valid phone number, or leave it blank.');
  if (!validOptionalEmail(draft.email))
    throw validationError('Enter a valid email, or leave it blank.');
  if (!boundedText(draft.address, 240))
    throw validationError('Address must be at most 240 characters.');
  const opening = draft.openingBalance === null ? null : moneyAt(draft.openingBalance, draft.scale);
  if (draft.openingBalance !== null && opening === null)
    throw validationError('Enter the opening balance as a plain number, for example 1500.50.');
  const { result } = await postExactlyOnce<CustomerResult>(async (operationId) => {
    const { data, error } = await client.rpc('save_customer', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_customer_id: draft.customerId,
      p_name: draft.name.trim(),
      p_phone: draft.phone.trim() ? draft.phone.trim() : null,
      p_email: draft.email.trim() ? normalizeEmail(draft.email) : null,
      p_address: draft.address.trim() ? draft.address.trim() : null,
      p_opening_balance: opening,
    });
    if (error) throw error;
    if (!data) throw validationError('The customer was not saved. Try again.');
    return data;
  });
  return result;
}

export async function archiveCustomer(
  client: OwnerBookClient,
  customerId: string,
  archived: boolean,
): Promise<void> {
  const { error } = await client.rpc('archive_customer', {
    p_customer_id: customerId,
    p_archived: archived,
  });
  if (error) throw error;
}

export async function recordPayment(
  client: OwnerBookClient,
  draft: PaymentDraft,
): Promise<PaymentResult> {
  const amount = moneyAt(draft.amount, draft.scale);
  if (amount === null)
    throw validationError('Enter the amount as a plain number, for example 500.');
  const units = parseAmount(amount, draft.scale);
  if (units === null || units <= 0n) throw validationError('Enter an amount greater than zero.');
  if (draft.method === 'credit')
    throw validationError('Choose how the money moved: cash, bank, wallet, cheque or other.');
  if (!draft.date) throw validationError('Choose the payment date.');
  if (!boundedText(draft.reference, 60))
    throw validationError('Reference must be at most 60 characters.');
  if (!boundedText(draft.note, 500)) throw validationError('Note must be at most 500 characters.');
  const { result } = await postExactlyOnce<PaymentResult>(async (operationId) => {
    const { data, error } = await client.rpc('record_payment', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_customer_id: draft.customerId,
      p_sale_id: draft.saleId,
      p_direction: draft.direction,
      p_amount: amount,
      p_payment_method: draft.method,
      p_payment_date: draft.date,
      p_reference: draft.reference.trim() ? draft.reference.trim() : null,
      p_note: draft.note.trim() ? draft.note.trim() : null,
    });
    if (error) throw error;
    if (!data) throw validationError('The payment was not recorded. Try again.');
    return data;
  });
  return result;
}

export async function voidPayment(
  client: OwnerBookClient,
  paymentId: string,
  reason: string,
): Promise<PaymentVoidResult> {
  if (!validReason(reason)) throw validationError('Give a reason of 1–200 characters to void it.');
  const { result } = await postExactlyOnce<PaymentVoidResult>(async (operationId) => {
    const { data, error } = await client.rpc('void_payment', {
      p_operation_id: operationId,
      p_payment_id: paymentId,
      p_reason: reason.trim(),
    });
    if (error) throw error;
    if (!data) throw validationError('The payment was not voided. Try again.');
    return data;
  });
  return result;
}

export async function recordAdjustment(
  client: OwnerBookClient,
  draft: AdjustmentDraft,
): Promise<AdjustmentResult> {
  const amount = moneyAt(draft.amount, draft.scale);
  if (amount === null)
    throw validationError(
      'Enter the amount as a plain number. Use a minus sign to credit the customer.',
    );
  const units = parseAmount(amount, draft.scale);
  if (units === null || isZeroAmount(units))
    throw validationError('Enter an amount that is not zero.');
  if (!validReason(draft.reason)) throw validationError('Give a reason of 1–200 characters.');
  if (!boundedText(draft.note, 300)) throw validationError('Note must be at most 300 characters.');
  const { result } = await postExactlyOnce<AdjustmentResult>(async (operationId) => {
    const { data, error } = await client.rpc('record_customer_adjustment', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_customer_id: draft.customerId,
      p_amount: amount,
      p_reason: draft.reason.trim(),
      p_entry_date: draft.date,
      p_note: draft.note.trim() ? draft.note.trim() : null,
    });
    if (error) throw error;
    if (!data) throw validationError('The adjustment was not recorded. Try again.');
    return data;
  });
  return result;
}

export async function listPayments(
  client: OwnerBookClient,
  businessId: string,
  options: ListOptions = {},
): Promise<PaymentRow[]> {
  const { data, error } = await client.rpc('list_payments', {
    p_business_id: businessId,
    p_customer_id: options.customerId ?? null,
    p_from: options.from ?? null,
    p_to: options.to ?? null,
    p_status: null,
    p_limit: options.limit ?? 50,
    p_offset: options.offset ?? 0,
  });
  if (error) throw error;
  return data ?? [];
}
