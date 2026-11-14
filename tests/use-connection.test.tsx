import { act, renderHook } from '@testing-library/react-native';
import { useConnection } from '../src/hooks/use-connection';
import { checkSupabaseConnection } from '../src/lib/connection';
import type { OwnerBookClient } from '../src/lib/supabase';

jest.mock('../src/lib/connection', () => ({ checkSupabaseConnection: jest.fn() }));
const probe = jest.mocked(checkSupabaseConnection);
const client = {} as OwnerBookClient;
const success = {
  ok: true as const,
  health: { service: 'ownerbook', schema_version: 3, database_time: '2026-11-01T12:00:00Z' },
  checkedAt: '2026-11-01T12:00:01Z',
};

describe('connection request lifecycle', () => {
  beforeEach(() => probe.mockResolvedValue(success));

  it('does not make requests without a configured client or while offline', async () => {
    const missing = await renderHook(() => useConnection(null, true));
    await act(async () => {
      await missing.result.current.check();
    });
    const offline = await renderHook(() => useConnection(client, false));
    await act(async () => {
      await offline.result.current.check();
    });
    expect(probe).not.toHaveBeenCalled();
    expect(offline.result.current.state).toEqual({ kind: 'idle' });
  });

  it('publishes a verified response and prevents overlapping checks', async () => {
    let resolve!: (value: typeof success) => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = await renderHook(() => useConnection(client, true));
    await act(async () => {
      const first = result.current.check();
      await result.current.check();
      resolve(success);
      await first;
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: 'checked', result: success });
  });

  it('does not publish a response after unmount', async () => {
    let resolve!: (value: typeof success) => void;
    probe.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, unmount } = await renderHook(() => useConnection(client, true));
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.check();
    });
    await unmount();
    await act(async () => {
      resolve(success);
      await pending;
    });
    expect(result.current.state).toEqual({ kind: 'checking' });
  });

  it('permits retry after a failed request', async () => {
    probe.mockResolvedValueOnce({ ok: false, code: 'NETWORK', message: 'Offline' });
    const { result } = await renderHook(() => useConnection(client, null));
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.state).toMatchObject({ kind: 'checked', result: { ok: false } });
    await act(async () => {
      await result.current.check();
    });
    expect(result.current.state).toEqual({ kind: 'checked', result: success });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
