import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PropsWithChildren } from 'react';
import { WorkspaceProvider, useWorkspace } from '../src/providers/workspace-provider';
import { loadWorkspace } from '../src/lib/business-service';
import { readSelection, saveSelection } from '../src/lib/business-selection';
import type { OwnerBookClient } from '../src/lib/supabase';
jest.mock('../src/lib/business-service', () => ({ loadWorkspace: jest.fn() }));
jest.mock('../src/lib/business-selection', () => ({
  readSelection: jest.fn(),
  saveSelection: jest.fn(),
  chooseMembership: (items: { business: { id: string } }[], id: string | null) =>
    items.find((item) => item.business.id === id) ?? items[0] ?? null,
}));
const load = jest.mocked(loadWorkspace);
const read = jest.mocked(readSelection);
const save = jest.mocked(saveSelection);
const profile = { id: 'user-a', display_name: 'A', created_at: 'now', updated_at: 'now' };
const make = (id: string, role: 'owner' | 'staff' = 'owner') => ({
  business: {
    id,
    name: id,
    currency: 'PKR',
    timezone: 'UTC',
    co_owners_can_invite: false,
    created_by: 'user-a',
    archived_at: null,
    currency_locked_at: null,
    created_at: 'now',
    updated_at: 'now',
  },
  membership: {
    business_id: id,
    user_id: 'user-a',
    role,
    display_name: null,
    invited_by: null,
    removed_at: null,
    created_at: 'now',
    updated_at: 'now',
  },
});
const client = {} as OwnerBookClient;
const wrapper = ({ children }: PropsWithChildren) => (
  <WorkspaceProvider client={client} userId="user-a">
    {children}
  </WorkspaceProvider>
);
describe('tenant-scoped workspace state', () => {
  beforeEach(() => {
    read.mockResolvedValue(null);
    save.mockResolvedValue();
    load.mockResolvedValue({
      memberships: [make('a'), make('b', 'staff')],
      profile,
      currencies: [],
    });
  });
  it('loads persistent memberships and selects only a member business', async () => {
    read.mockResolvedValue('b');
    const { result } = await renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.active?.business.id).toBe('b'));
    expect(result.current.canInvite).toBe(false);
    await act(async () => result.current.select('a'));
    expect(result.current.active?.business.id).toBe('a');
    expect(save).toHaveBeenCalledWith('user-a', 'a');
    await expect(result.current.select('foreign')).rejects.toBeTruthy();
  });
  it('falls back after membership removal and clears active state when none remain', async () => {
    read.mockResolvedValue('removed');
    const { result, rerender } = await renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.active?.business.id).toBe('a'));
    load.mockResolvedValue({ memberships: [], profile, currencies: [] });
    await act(async () => result.current.refresh());
    expect(result.current.active).toBeNull();
    expect(result.current.memberships).toEqual([]);
    await act(async () => rerender(undefined));
  });
  it('ignores an older response that finishes after a newer refresh', async () => {
    let finishOld!: (value: Awaited<ReturnType<typeof loadWorkspace>>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const { result } = await renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.active?.business.id).toBe('a');
    await act(async () => {
      finishOld({ memberships: [make('stale')], profile, currencies: [] });
    });
    expect(result.current.active?.business.id).toBe('a');
    expect(result.current.memberships.map((item) => item.business.id)).toEqual(['a', 'b']);
  });
  it('does not let an older refresh overwrite an explicit business selection', async () => {
    const { result } = await renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.active?.business.id).toBe('a'));
    let release!: (value: Awaited<ReturnType<typeof loadWorkspace>>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.refresh();
    });
    await act(async () => {
      await result.current.select('b');
    });
    await act(async () => {
      release({ memberships: [make('a')], profile, currencies: [] });
      await pending;
    });
    expect(result.current.active?.business.id).toBe('b');
    expect(result.current.loading).toBe(false);
  });
  it('clears tenant state when remounted for a different account', async () => {
    let userId = 'user-a';
    const accountWrapper = ({ children }: PropsWithChildren) => (
      <WorkspaceProvider key={userId} client={client} userId={userId}>
        {children}
      </WorkspaceProvider>
    );
    const { result, rerender } = await renderHook(() => useWorkspace(), {
      wrapper: accountWrapper,
    });
    await waitFor(() => expect(result.current.active?.business.id).toBe('a'));
    let resolveNew!: (value: Awaited<ReturnType<typeof loadWorkspace>>) => void;
    load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveNew = resolve;
        }),
    );
    userId = 'user-b';
    await act(async () => {
      rerender(undefined);
    });
    expect(result.current.active).toBeNull();
    expect(result.current.memberships).toEqual([]);
    await act(async () => {
      resolveNew({ memberships: [], profile: { ...profile, id: userId }, currencies: [] });
    });
    expect(read).toHaveBeenLastCalledWith('user-b');
  });
  it('surfaces load failures rather than inventing businesses', async () => {
    load.mockRejectedValue({ code: 'network', message: 'Failed to fetch' });
    const { result } = await renderHook(() => useWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.error).toMatch(/Could not connect/));
    expect(result.current.active).toBeNull();
  });
});
