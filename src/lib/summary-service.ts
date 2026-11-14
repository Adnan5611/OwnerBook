import type { OwnerBookClient } from './supabase';
import type { ActivityRow, BalanceSummaryResult, PeriodSummaryResult } from '../types/database';
import { validationError } from './errors';
import { isValidIsoDate } from './business-time';

/**
 * Reports are read straight from the records. There is no cached, estimated or
 * hardcoded figure anywhere in this module: if the business has no records yet,
 * the summaries return zeros and the screens say so.
 */
export async function periodSummary(
  client: OwnerBookClient,
  businessId: string,
  from: string,
  to: string,
): Promise<PeriodSummaryResult> {
  if (!isValidIsoDate(from) || !isValidIsoDate(to))
    throw validationError('Choose a valid reporting period.');
  if (from > to) throw validationError('The period must start before it ends.');
  const { data, error } = await client.rpc('period_summary', {
    p_business_id: businessId,
    p_from: from,
    p_to: to,
  });
  if (error) throw error;
  if (!data) throw validationError('The report is not available yet. Pull to refresh.');
  return data;
}

export async function balanceSummary(
  client: OwnerBookClient,
  businessId: string,
): Promise<BalanceSummaryResult> {
  const { data, error } = await client.rpc('balance_summary', { p_business_id: businessId });
  if (error) throw error;
  if (!data) throw validationError('The business position is not available yet. Pull to refresh.');
  return data;
}

export async function listActivity(
  client: OwnerBookClient,
  businessId: string,
  limit = 25,
): Promise<ActivityRow[]> {
  const { data, error } = await client.rpc('list_activity', {
    p_business_id: businessId,
    p_limit: limit,
    p_before: null,
  });
  if (error) throw error;
  return data ?? [];
}
