import type { OwnerBookClient } from './supabase';
import type {
  CategoryRow,
  ExpenseResult,
  ExpenseRow,
  ExpenseVoidResult,
  PaymentMethod,
} from '../types/database';
import { postExactlyOnce } from './posting';
import { validationError } from './errors';
import { boundedText, validCategory, validReason } from './validation';
import { moneyAt } from './khata-service';
import { parseAmount } from './decimal';

export type ExpenseDraft = {
  businessId: string;
  date: string;
  category: string;
  amount: string;
  method: PaymentMethod;
  reference: string;
  note: string;
  scale: number;
};

export async function listExpenses(
  client: OwnerBookClient,
  businessId: string,
  options: {
    from?: string | null;
    to?: string | null;
    category?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ExpenseRow[]> {
  const { data, error } = await client.rpc('list_expenses', {
    p_business_id: businessId,
    p_from: options.from ?? null,
    p_to: options.to ?? null,
    p_category: options.category ?? null,
    p_status: null,
    p_limit: options.limit ?? 50,
    p_offset: options.offset ?? 0,
  });
  if (error) throw error;
  return data ?? [];
}

export async function expenseCategories(
  client: OwnerBookClient,
  businessId: string,
): Promise<CategoryRow[]> {
  const { data, error } = await client.rpc('expense_categories', { p_business_id: businessId });
  if (error) throw error;
  return data ?? [];
}

export async function createExpense(
  client: OwnerBookClient,
  draft: ExpenseDraft,
): Promise<ExpenseResult> {
  if (!validCategory(draft.category)) throw validationError('Enter a category of 1–60 characters.');
  const amount = moneyAt(draft.amount, draft.scale);
  if (amount === null)
    throw validationError('Enter the amount as a plain number, for example 2500.');
  if ((parseAmount(amount, draft.scale) ?? 0n) <= 0n)
    throw validationError('Enter an amount greater than zero.');
  if (draft.method === 'credit')
    throw validationError(
      'Choose how the expense was paid. Credit purchases arrive with suppliers.',
    );
  if (!draft.date) throw validationError('Choose the expense date.');
  if (!boundedText(draft.reference, 60))
    throw validationError('Reference must be at most 60 characters.');
  if (!boundedText(draft.note, 500)) throw validationError('Note must be at most 500 characters.');
  const { result } = await postExactlyOnce<ExpenseResult>(async (operationId) => {
    const { data, error } = await client.rpc('create_expense', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_expense_date: draft.date,
      p_category: draft.category.trim(),
      p_amount: amount,
      p_payment_method: draft.method,
      p_reference: draft.reference.trim() ? draft.reference.trim() : null,
      p_note: draft.note.trim() ? draft.note.trim() : null,
    });
    if (error) throw error;
    if (!data) throw validationError('The expense was not recorded. Try again.');
    return data;
  });
  return result;
}

export async function voidExpense(
  client: OwnerBookClient,
  expenseId: string,
  reason: string,
): Promise<ExpenseVoidResult> {
  if (!validReason(reason)) throw validationError('Give a reason of 1–200 characters to void it.');
  const { result } = await postExactlyOnce<ExpenseVoidResult>(async (operationId) => {
    const { data, error } = await client.rpc('void_expense', {
      p_operation_id: operationId,
      p_expense_id: expenseId,
      p_reason: reason.trim(),
    });
    if (error) throw error;
    if (!data) throw validationError('The expense was not voided. Try again.');
    return data;
  });
  return result;
}
