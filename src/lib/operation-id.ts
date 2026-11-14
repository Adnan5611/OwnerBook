import { randomUUID } from 'expo-crypto';

/**
 * Operation ids are what make retrying a financial write safe.
 *
 * One id is generated per user action and reused for every attempt at that
 * action. The database stores an idempotency receipt against it, so a retry that
 * arrives after a lost response returns the original document instead of posting
 * the money a second time. Without a real CSPRNG there is no safe id, so this
 * fails loudly rather than falling back to something predictable.
 */
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type OperationId = string;

export function newOperationId(): OperationId {
  const value = randomUUID().toLowerCase();
  if (!OPERATION_ID_PATTERN.test(value)) {
    throw new Error('This device cannot generate a safe operation id');
  }
  return value;
}

export function isOperationId(value: unknown): value is OperationId {
  return typeof value === 'string' && OPERATION_ID_PATTERN.test(value);
}
