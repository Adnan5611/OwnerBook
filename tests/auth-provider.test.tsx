import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { AuthProvider, useAuth } from '../src/providers/auth-provider';
import type { Session } from '@supabase/supabase-js';
import type { OwnerBookClient } from '../src/lib/supabase';
import { consumeAuthLink } from '../src/lib/auth-service';
const mockValues = new Map<string, string>();
const mockInitial = { url: null as string | null };
jest.mock('expo-linking', () => ({
  getInitialURL: () => Promise.resolve(mockInitial.url),
  addEventListener: (_name: string, listener: (event: { url: string }) => void) => {
    void listener;
    return { remove: jest.fn() };
  },
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device',
  getItemAsync: (key: string) => Promise.resolve(mockValues.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    mockValues.set(key, value);
    return Promise.resolve();
  },
  deleteItemAsync: (key: string) => {
    mockValues.delete(key);
    return Promise.resolve();
  },
}));
jest.mock('../src/lib/auth-service', () => ({ consumeAuthLink: jest.fn() }));
const consume = jest.mocked(consumeAuthLink);
const session: Session = {
  user: {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-11-02',
  },
  access_token: 'test',
  refresh_token: 'test',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: 9999999999,
};
function setup(stored: Session | null = null) {
  let listener: (event: string, session: Session | null) => void = () => {};
  const client = {
    auth: {
      onAuthStateChange: (fn: typeof listener) => {
        listener = fn;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      },
      getSession: jest.fn(async () => ({ data: { session: stored }, error: null })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  } as unknown as OwnerBookClient;
  return {
    client,
    emit: (event: string, next: Session | null) => act(async () => listener(event, next)),
  };
}
describe('auth lifecycle and recovery gate', () => {
  beforeEach(() => {
    mockValues.clear();
    mockInitial.url = null;
    consume.mockResolvedValue('recovery');
  });
  it('restores a stored ordinary session', async () => {
    const { client } = setup(session);
    const wrapper = ({ children }: PropsWithChildren) => (
      <AuthProvider client={client}>{children}</AuthProvider>
    );
    const { result } = await renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBe(session);
    expect(result.current.recovery).toBe(false);
  });
  it('keeps recovery gated after process restart', async () => {
    mockValues.set('ownerbook.recovery.v1', session.user.id);
    const { client } = setup(session);
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recovery).toBe(true);
    expect(result.current.session).toBe(session);
  });
  it('handles cold recovery links before publishing the workspace', async () => {
    mockInitial.url = 'ownerbook://auth/recovery?code=valid';
    consume.mockImplementation(async () => {
      expect(mockValues.get('ownerbook.recovery.v1')).toBeTruthy();
      return 'recovery';
    });
    const { client } = setup();
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(consume).toHaveBeenCalled());
    expect(result.current.recovery).toBe(true);
  });
  it('shows a safe error for an invalid link', async () => {
    mockInitial.url = 'ownerbook://auth/recovery?code=expired';
    consume.mockRejectedValue(new Error('secret raw token'));
    const { client } = setup();
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.error).toMatch(/invalid, expired/));
    expect(result.current.error).not.toMatch(/secret raw token/);
    expect(result.current.session).toBeNull();
  });
  it('does not resurrect a stored session after sign-out wins the initialization race', async () => {
    let release!: (value: { data: { session: Session }; error: null }) => void;
    const { client, emit } = setup(session);
    jest.mocked(client.auth.getSession).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await emit('SIGNED_OUT', null);
    await act(async () => {
      release({ data: { session }, error: null });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.session).toBeNull();
  });
  it('signs out globally and clears the recovery marker', async () => {
    mockValues.set('ownerbook.recovery.v1', session.user.id);
    const { client } = setup(session);
    const { result } = await renderHook(() => useAuth(), {
      wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider>,
    });
    await waitFor(() => expect(result.current.session).toBe(session));
    await act(async () => result.current.signOut());
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(result.current.session).toBeNull();
    expect(mockValues.has('ownerbook.recovery.v1')).toBe(false);
  });
});
