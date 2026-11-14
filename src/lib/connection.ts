import type { OwnerBookClient } from './supabase';

export const REQUIRED_SCHEMA_VERSION = 3;
export type DatabaseHealth = { service: string; schema_version: number; database_time: string };
export type ConnectionFailureCode =
  | 'MISSING_SCHEMA'
  | 'AUTH_REJECTED'
  | 'ENDPOINT_NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export type ConnectionResult =
  | { ok: true; health: DatabaseHealth; checkedAt: string }
  | { ok: false; code: ConnectionFailureCode; message: string };

const failures: Record<ConnectionFailureCode, string> = {
  MISSING_SCHEMA:
    'The project is reachable, but the required OwnerBook migrations have not been applied.',
  AUTH_REJECTED: 'Supabase rejected the public key. Check the publishable key and API settings.',
  ENDPOINT_NOT_FOUND: 'The API endpoint was not found. Check the project URL and migrations.',
  TIMEOUT: 'The database did not respond in time. Check the connection or project availability.',
  NETWORK: 'Could not reach Supabase. Check your connection and project URL.',
  INVALID_RESPONSE:
    'The endpoint returned an unexpected or outdated schema response. Apply the Phase 3 migration.',
  UNKNOWN: 'The connection check failed. Review the project setup and try again.',
};

function failure(code: ConnectionFailureCode): ConnectionResult {
  return { ok: false, code, message: failures[code] };
}

function isDatabaseHealth(value: unknown): value is DatabaseHealth {
  if (!value || typeof value !== 'object') return false;
  const health = value as Record<string, unknown>;
  return (
    health.service === 'ownerbook' &&
    typeof health.schema_version === 'number' &&
    Number.isInteger(health.schema_version) &&
    health.schema_version >= REQUIRED_SCHEMA_VERSION &&
    typeof health.database_time === 'string' &&
    Number.isFinite(Date.parse(health.database_time))
  );
}

/** A real RPC round trip, not a ping to a website or a hardcoded success state. */
export async function checkSupabaseConnection(
  client: OwnerBookClient,
  timeoutMs = 10_000,
): Promise<ConnectionResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = client.rpc('ownerbook_health').abortSignal(controller.signal);
    const response = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('CONNECTION_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
    if (response.error) {
      const { code, message } = response.error;
      const status = 'status' in response.error ? response.error.status : undefined;
      if (code === 'PGRST202' || code === '42883') return failure('MISSING_SCHEMA');
      if (
        status === 401 ||
        status === 403 ||
        code === 'PGRST301' ||
        code === '401' ||
        code === '403'
      )
        return failure('AUTH_REJECTED');
      if (status === 404) return failure('ENDPOINT_NOT_FOUND');
      if (/fetch|network|abort/i.test(message)) return failure('NETWORK');
      return failure('UNKNOWN');
    }
    if (!isDatabaseHealth(response.data)) return failure('INVALID_RESPONSE');
    return { ok: true, health: response.data, checkedAt: new Date().toISOString() };
  } catch (error) {
    // Native/network errors may contain request details. Never render or log them.
    return failure(
      error instanceof Error && error.message === 'CONNECTION_TIMEOUT' ? 'TIMEOUT' : 'NETWORK',
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
