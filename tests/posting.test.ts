import { isRetryableError, postExactlyOnce } from '../src/lib/posting';
import { isOperationId, newOperationId } from '../src/lib/operation-id';

/**
 * A financial write may be attempted several times but must be recorded once.
 * These tests pin the client half of that contract: one operation id per user
 * action, reused by every retry, and retries only for transport failures.
 */
describe('idempotent posting', () => {
  it('generates RFC 4122 version 4 operation ids and never repeats one', () => {
    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = newOperationId();
      expect(isOperationId(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it('rejects ids that are not version 4', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      '123e4567-e89b-12d3-a456-426614174000',
      123,
      null,
      undefined,
    ])
      expect(isOperationId(bad)).toBe(false);
  });

  it('reuses one operation id across every retry of the same action', async () => {
    const seen: string[] = [];
    let calls = 0;
    const posted = await postExactlyOnce(async (operationId) => {
      seen.push(operationId);
      calls += 1;
      if (calls < 3) throw { message: 'Network request failed' };
      return { replayed: false, total: '10.00' };
    });
    expect(calls).toBe(3);
    expect(new Set(seen).size).toBe(1);
    expect(isOperationId(seen[0])).toBe(true);
    expect(posted.result.total).toBe('10.00');
    expect(posted.attemptsUsed).toBe(3);
    expect(posted.replayed).toBe(false);
  });

  it('reports when the server replayed a stored receipt', async () => {
    const posted = await postExactlyOnce(async () => ({ replayed: true, total: '10.00' }));
    expect(posted.replayed).toBe(true);
    expect(posted.attemptsUsed).toBe(1);
  });

  it('stops immediately when the database has answered with a rejection', async () => {
    const seen: string[] = [];
    const rejection = { code: '23514', message: 'check constraint violated' };
    await expect(
      postExactlyOnce(async (operationId) => {
        seen.push(operationId);
        throw rejection;
      }),
    ).rejects.toBe(rejection);
    expect(seen).toHaveLength(1);
  });

  it('does not loop on a raised PL/pgSQL error', async () => {
    let calls = 0;
    await expect(
      postExactlyOnce(async () => {
        calls += 1;
        throw { code: 'P0002', message: 'This business is archived; restore it first' };
      }),
    ).rejects.toMatchObject({ code: 'P0002' });
    expect(calls).toBe(1);
  });

  it('gives up after the configured number of transport failures', async () => {
    let calls = 0;
    await expect(
      postExactlyOnce(async () => {
        calls += 1;
        throw { message: 'socket hang up' };
      }, 4),
    ).rejects.toMatchObject({ message: 'socket hang up' });
    expect(calls).toBe(4);
  });

  it('never attempts fewer than once', async () => {
    let calls = 0;
    await postExactlyOnce(async () => {
      calls += 1;
      return { replayed: false };
    }, 0);
    expect(calls).toBe(1);
  });

  it('classifies transport failures as retryable and everything else as final', () => {
    for (const retryable of [
      { message: 'Network request failed' },
      { message: 'fetch failed' },
      { message: 'timeout of 10000ms exceeded' },
      { message: 'The operation was aborted' },
      { message: 'read ECONNRESET' },
      { message: 'connect ECONNREFUSED 127.0.0.1:54321' },
      { message: 'getaddrinfo ENOTFOUND db.example.com' },
      { message: 'EHOSTUNREACH' },
      { code: '', message: 'socket hang up' },
    ])
      expect(isRetryableError(retryable)).toBe(true);
    for (const final of [
      { code: '23505', message: 'duplicate key value violates unique constraint' },
      { code: '23514', message: 'new row for relation "payments" violates check constraint' },
      { code: '42501', message: 'permission denied for table payments' },
      { code: '22023', message: 'invalid decimal literal' },
      { code: 'P0002', message: 'archived business' },
      { code: 'OWNERBOOK_VALIDATION', message: 'Enter an amount greater than zero.' },
      { message: 'Enter an amount greater than zero.' },
      { message: '' },
      {},
      null,
      undefined,
      'a string is not an error object',
    ])
      expect(isRetryableError(final)).toBe(false);
  });
});
