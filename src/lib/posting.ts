import { newOperationId, type OperationId } from './operation-id';

/**
 * Posting a financial document is allowed to be attempted more than once, but it
 * may only ever be recorded once.
 *
 * One operation id is generated per user action and reused for every attempt at
 * that action. If a response is lost, the retry reaches the database with the same
 * id and the stored idempotency receipt returns the original document instead of
 * writing a second one. Only transport failures are retried: when the server has
 * answered with a rejection, repeating the request cannot produce a different
 * result and would only hide the reason from the user.
 */
export type PostResult<T> = {
  result: T;
  operationId: OperationId;
  replayed: boolean;
  attemptsUsed: number;
};

const TRANSPORT_PATTERN =
  /network|fetch|timeout|aborted|socket|econnreset|econnrefused|ehostunreach|enotfound/i;

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  // A PostgREST/PostgreSQL error code means the database answered the request.
  if (
    typeof candidate.code === 'string' &&
    candidate.code !== '' &&
    !TRANSPORT_PATTERN.test(candidate.code)
  )
    return false;
  return TRANSPORT_PATTERN.test(message);
}

export async function postExactlyOnce<T extends { replayed?: boolean }>(
  run: (operationId: OperationId) => Promise<T>,
  attempts = 3,
): Promise<PostResult<T>> {
  const operationId = newOperationId();
  const maximum = Math.max(1, attempts);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximum; attempt++) {
    try {
      const result = await run(operationId);
      return {
        result,
        operationId,
        replayed: result?.replayed === true,
        attemptsUsed: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt === maximum || !isRetryableError(error)) throw error;
    }
  }
  // Unreachable: the loop either returns or throws. Kept so the type is total.
  throw lastError;
}
