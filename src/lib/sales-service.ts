import type { OwnerBookClient } from './supabase';
import type {
  PaymentMethod,
  ProductResult,
  ProductRow,
  Sale,
  SaleItem,
  SaleItemDraft,
  SaleResult,
  SaleRow,
  SaleVoidResult,
} from '../types/database';
import { postExactlyOnce } from './posting';
import { validationError } from './errors';
import { boundedText, validProductName, validReason } from './validation';
import { moneyAt } from './khata-service';
import {
  PRICE_SCALE,
  QUANTITY_SCALE,
  compareAmounts,
  lineTotal,
  multiplyAmounts,
  parseAmount,
  roundAmount,
  subtractAmounts,
  toAmountText,
  totalOfLines,
  type Units,
} from './decimal';

export type SaleLineDraft = {
  key: string;
  productId: string | null;
  itemName: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  unitCost: string;
};
export type SaleDraft = {
  businessId: string;
  customerId: string | null;
  date: string;
  method: PaymentMethod;
  paidAmount: string;
  lines: SaleLineDraft[];
  scale: number;
  /** Optional counter reference, for example a slip or token number. */
  reference?: string;
  note?: string;
};
export type PreviewLine = {
  key: string;
  gross: string;
  total: string;
  cogs: string;
  valid: boolean;
};
export type SalePreview = {
  problem: string | null;
  lines: PreviewLine[];
  subtotal: string;
  discountTotal: string;
  total: string;
  cogs: string;
  paid: string;
  due: string;
};
export type ProductDraft = {
  businessId: string;
  productId: string | null;
  name: string;
  sku: string;
  unit: string;
  salePrice: string;
  costPrice: string;
  scale: number;
};

export function emptyLine(key: string, unit = 'pcs'): SaleLineDraft {
  return {
    key,
    productId: null,
    itemName: '',
    unit,
    quantity: '1',
    unitPrice: '',
    discount: '',
    unitCost: '',
  };
}

/**
 * Computes the sale exactly as `public.create_sale` does, using BigInt decimals.
 * The preview and the stored document therefore always agree; the server still
 * recomputes everything and remains the only source of truth.
 */
export function previewSale(draft: SaleDraft): SalePreview {
  const scale = draft.scale;
  const zero = toAmountText(0n, scale);
  const lines: PreviewLine[] = [];
  const grosses: Units[] = [];
  const discounts: Units[] = [];
  const totals: Units[] = [];
  const costs: Units[] = [];
  let problem: string | null = null;
  for (const line of draft.lines) {
    const quantity = parseAmount(line.quantity, QUANTITY_SCALE);
    const unitPrice = parseAmount(line.unitPrice, PRICE_SCALE);
    const discount = parseAmount(line.discount.trim() || '0', scale);
    const unitCost = parseAmount(line.unitCost.trim() || '0', PRICE_SCALE);
    const valid =
      quantity !== null &&
      unitPrice !== null &&
      discount !== null &&
      unitCost !== null &&
      quantity > 0n &&
      unitPrice >= 0n &&
      discount >= 0n &&
      unitCost >= 0n &&
      (line.productId !== null || validProductName(line.itemName));
    if (!valid) {
      problem ??= line.productId
        ? 'Check the quantity, price and discount on every line.'
        : 'Every line needs a name, a quantity and a price.';
      lines.push({ key: line.key, gross: zero, total: zero, cogs: zero, valid: false });
      continue;
    }
    const grossUnits = roundAmount(multiplyAmounts(quantity!, unitPrice!), scale);
    if (compareAmounts(discount!, grossUnits) > 0) {
      problem ??= 'A line discount cannot be larger than the line total.';
      lines.push({ key: line.key, gross: zero, total: zero, cogs: zero, valid: false });
      continue;
    }
    grosses.push(grossUnits);
    discounts.push(roundAmount(discount!, scale));
    totals.push(lineTotal(quantity!, unitPrice!, discount!, scale));
    costs.push(roundAmount(multiplyAmounts(quantity!, unitCost!), scale));
    lines.push({
      key: line.key,
      gross: toAmountText(grossUnits, scale),
      total: toAmountText(totals[totals.length - 1]!, scale),
      cogs: toAmountText(costs[costs.length - 1]!, scale),
      valid: true,
    });
  }
  if (draft.lines.length === 0) problem ??= 'Add at least one line to the sale.';
  if (problem) {
    return {
      problem,
      lines,
      subtotal: zero,
      discountTotal: zero,
      total: zero,
      cogs: zero,
      paid: zero,
      due: zero,
    };
  }
  const subtotalUnits = totalOfLines(grosses);
  const discountUnits = totalOfLines(discounts);
  const totalUnits = subtractAmounts(subtotalUnits, discountUnits);
  const cogsUnits = totalOfLines(costs);
  const paidText = draft.paidAmount.trim();
  const parsedPaid = parseAmount(paidText === '' ? '0' : paidText, scale);
  const paidUnits = roundAmount(parsedPaid ?? 0n, scale);
  if (parsedPaid === null)
    problem = 'Enter the amount received as a plain number, for example 500.';
  else if (compareAmounts(totalUnits, 0n) <= 0)
    problem = 'The sale total must be greater than zero.';
  else if (compareAmounts(paidUnits, 0n) < 0) problem = 'The amount received cannot be negative.';
  else if (compareAmounts(paidUnits, totalUnits) > 0)
    problem = 'The amount received cannot be larger than the sale total.';
  else if (draft.method === 'credit' && compareAmounts(paidUnits, 0n) !== 0)
    problem = 'A credit sale records no money received.';
  else if (draft.method !== 'credit' && compareAmounts(paidUnits, 0n) === 0)
    problem = 'Choose “Credit” when nothing is received now.';
  else if (draft.customerId === null && compareAmounts(paidUnits, totalUnits) !== 0)
    problem = 'A sale without a customer must be paid in full.';
  else if (!draft.date) problem = 'Choose the sale date.';
  if (problem) {
    return {
      problem,
      lines,
      subtotal: toAmountText(subtotalUnits, scale),
      discountTotal: toAmountText(discountUnits, scale),
      total: toAmountText(totalUnits, scale),
      cogs: toAmountText(cogsUnits, scale),
      paid: toAmountText(paidUnits, scale),
      due: zero,
    };
  }
  return {
    problem: null,
    lines,
    subtotal: toAmountText(subtotalUnits, scale),
    discountTotal: toAmountText(discountUnits, scale),
    total: toAmountText(totalUnits, scale),
    cogs: toAmountText(cogsUnits, scale),
    paid: toAmountText(paidUnits, scale),
    due: toAmountText(subtractAmounts(totalUnits, paidUnits), scale),
  };
}

export async function listProducts(
  client: OwnerBookClient,
  businessId: string,
  options: { search?: string; includeArchived?: boolean; limit?: number } = {},
): Promise<ProductRow[]> {
  const { data, error } = await client.rpc('list_products', {
    p_business_id: businessId,
    p_search: options.search?.trim() ? options.search.trim() : null,
    p_include_archived: options.includeArchived ?? false,
    p_limit: options.limit ?? 100,
    p_offset: 0,
  });
  if (error) throw error;
  return data ?? [];
}

export async function saveProduct(
  client: OwnerBookClient,
  draft: ProductDraft,
): Promise<ProductResult> {
  if (!validProductName(draft.name))
    throw validationError('Enter an item name of 1–120 characters.');
  if (!boundedText(draft.sku, 40)) throw validationError('SKU must be at most 40 characters.');
  if (!boundedText(draft.unit, 24)) throw validationError('Unit must be at most 24 characters.');
  const salePrice = moneyAt(draft.salePrice.trim() || '0', draft.scale);
  const costPrice = moneyAt(draft.costPrice.trim() || '0', draft.scale);
  if (salePrice === null || costPrice === null)
    throw validationError('Enter prices as plain numbers, for example 250.50.');
  if ((parseAmount(salePrice, draft.scale) ?? 0n) < 0n)
    throw validationError('A price cannot be negative.');
  if ((parseAmount(costPrice, draft.scale) ?? 0n) < 0n)
    throw validationError('A cost cannot be negative.');
  const { result } = await postExactlyOnce<ProductResult>(async (operationId) => {
    const { data, error } = await client.rpc('save_product', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_product_id: draft.productId,
      p_name: draft.name.trim(),
      p_sku: draft.sku.trim() ? draft.sku.trim() : null,
      p_unit: draft.unit.trim() ? draft.unit.trim() : 'pcs',
      p_sale_price: salePrice,
      p_cost_price: costPrice,
    });
    if (error) throw error;
    if (!data) throw validationError('The item was not saved. Try again.');
    return data;
  });
  return result;
}

export async function createSale(client: OwnerBookClient, draft: SaleDraft): Promise<SaleResult> {
  const preview = previewSale(draft);
  if (preview.problem) throw validationError(preview.problem);
  const reference = draft.reference ?? '';
  const note = draft.note ?? '';
  if (!boundedText(reference, 60))
    throw validationError('Reference must be at most 60 characters.');
  if (!boundedText(note, 500)) throw validationError('Note must be at most 500 characters.');
  const items: SaleItemDraft[] = draft.lines.map((line) => ({
    product_id: line.productId,
    item_name: line.itemName.trim(),
    unit: line.unit.trim() || 'pcs',
    quantity: line.quantity.trim(),
    unit_price: line.unitPrice.trim(),
    discount: line.discount.trim() || '0',
    unit_cost: line.unitCost.trim() || '0',
  }));
  const { result } = await postExactlyOnce<SaleResult>(async (operationId) => {
    const { data, error } = await client.rpc('create_sale', {
      p_operation_id: operationId,
      p_business_id: draft.businessId,
      p_customer_id: draft.customerId,
      p_sale_date: draft.date,
      p_payment_method: draft.method,
      p_paid_amount: preview.paid,
      p_items: items,
      p_reference: reference.trim() ? reference.trim() : null,
      p_note: note.trim() ? note.trim() : null,
    });
    if (error) throw error;
    if (!data) throw validationError('The sale was not recorded. Try again.');
    return data;
  });
  return result;
}

export async function voidSale(
  client: OwnerBookClient,
  saleId: string,
  reason: string,
): Promise<SaleVoidResult> {
  if (!validReason(reason)) throw validationError('Give a reason of 1–200 characters to void it.');
  const { result } = await postExactlyOnce<SaleVoidResult>(async (operationId) => {
    const { data, error } = await client.rpc('void_sale', {
      p_operation_id: operationId,
      p_sale_id: saleId,
      p_reason: reason.trim(),
    });
    if (error) throw error;
    if (!data) throw validationError('The sale was not voided. Try again.');
    return data;
  });
  return result;
}

export type SaleDetail = { sale: Sale; items: SaleItem[] };

/**
 * A single sale with its stored line items, read through row level security.
 * The lines carry the price and cost snapshotted at posting time, so the
 * document still reads correctly after catalog prices change.
 */
export async function saleDetail(client: OwnerBookClient, saleId: string): Promise<SaleDetail> {
  const [sale, items] = await Promise.all([
    client.from('sales').select('*').eq('id', saleId).maybeSingle(),
    client
      .from('sale_items')
      .select('*')
      .eq('sale_id', saleId)
      .order('position', { ascending: true }),
  ]);
  if (sale.error) throw sale.error;
  if (items.error) throw items.error;
  if (!sale.data) throw validationError('That sale is not in this business.');
  return { sale: sale.data, items: items.data ?? [] };
}

export async function listSales(
  client: OwnerBookClient,
  businessId: string,
  options: {
    customerId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
  } = {},
): Promise<SaleRow[]> {
  const { data, error } = await client.rpc('list_sales', {
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
