import { checkSupabaseConnection } from '../src/lib/connection';
import type { OwnerBookClient } from '../src/lib/supabase';

const health = { service: 'ownerbook', schema_version: 3, database_time: '2026-11-01T12:00:00Z' };

function mockClient(response: { data: unknown; error: unknown }) {
  const abortSignal = jest.fn().mockResolvedValue(response);
  const rpc = jest.fn(() => ({ abortSignal }));
  return { client: { rpc } as unknown as OwnerBookClient, rpc, abortSignal };
}

describe('live database connection probe', () => {
  it('reports success only after a valid RPC response', async () => {
    const { client, rpc } = mockClient({ data: health, error: null });
    const result = await checkSupabaseConnection(client);
    expect(rpc).toHaveBeenCalledWith('ownerbook_health');
    expect(result).toMatchObject({ ok: true, health });
  });

  it('distinguishes an unapplied migration from a connection failure', async () => {
    const { client } = mockClient({
      data: null,
      error: { code: 'PGRST202', message: 'function not found' },
    });
    expect(await checkSupabaseConnection(client)).toMatchObject({
      ok: false,
      code: 'MISSING_SCHEMA',
    });
  });

  it.each(['401', '403', 'PGRST301'])('handles rejected key code %s', async (code) => {
    const { client } = mockClient({
      data: null,
      error: { code, message: 'secret-request-details' },
    });
    const result = await checkSupabaseConnection(client);
    expect(result).toMatchObject({ ok: false, code: 'AUTH_REJECTED' });
    expect(JSON.stringify(result)).not.toContain('secret-request-details');
  });

  it('handles HTTP authorization failures', async () => {
    const { client } = mockClient({
      data: null,
      error: { code: 'unknown', status: 401, message: 'denied' },
    });
    expect(await checkSupabaseConnection(client)).toMatchObject({
      ok: false,
      code: 'AUTH_REJECTED',
    });
  });

  it('handles an incorrect project endpoint', async () => {
    const { client } = mockClient({
      data: null,
      error: { code: 'unknown', status: 404, message: 'missing' },
    });
    expect(await checkSupabaseConnection(client)).toMatchObject({
      ok: false,
      code: 'ENDPOINT_NOT_FOUND',
    });
  });

  it.each([
    null,
    {},
    { ...health, service: 'other' },
    { ...health, schema_version: 0 },
    { ...health, schema_version: 1 },
    { ...health, schema_version: 2 },
    { ...health, database_time: 'bad-date' },
  ])('does not treat an invalid response as a connected database', async (data) => {
    const { client } = mockClient({ data, error: null });
    expect(await checkSupabaseConnection(client)).toMatchObject({
      ok: false,
      code: 'INVALID_RESPONSE',
    });
  });

  it('sanitizes network exception details', async () => {
    const abortSignal = jest
      .fn()
      .mockRejectedValue(new Error('https://private.example?key=sensitive'));
    const client = { rpc: () => ({ abortSignal }) } as unknown as OwnerBookClient;
    const result = await checkSupabaseConnection(client);
    expect(result).toMatchObject({ ok: false, code: 'NETWORK' });
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('aborts a stalled request and clears its timeout', async () => {
    jest.useFakeTimers();
    try {
      const abortSignal = jest.fn(() => new Promise(() => {}));
      const client = { rpc: () => ({ abortSignal }) } as unknown as OwnerBookClient;
      const pending = checkSupabaseConnection(client, 100);
      await jest.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ ok: false, code: 'TIMEOUT' });
      expect(abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recognizes a newer compatible schema', async () => {
    const { client } = mockClient({ data: { ...health, schema_version: 4 }, error: null });
    expect(await checkSupabaseConnection(client)).toMatchObject({ ok: true });
  });
});
