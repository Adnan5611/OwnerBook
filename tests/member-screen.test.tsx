import { Alert } from 'react-native';
import { fireEvent, act, cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { MemberScreen } from '../src/screens/member-screen';
import type { OwnerBookClient } from '../src/lib/supabase';
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
const mockWorkspace = {
  active: { business: { id: 'biz', name: 'Shop' }, membership: { role: 'staff' } },
  canInvite: false,
  refresh: jest.fn(),
};
const mockMembers = [
  { user_id: 'owner', name: 'Owner', role: 'owner', display_name: null },
  { user_id: 'staff', name: 'Staff', role: 'staff', display_name: null },
];
const mockLoad = jest.fn();
jest.mock('../src/providers/workspace-provider', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('../src/providers/auth-provider', () => ({
  useAuth: () => ({ session: { user: { id: 'staff' } } }),
}));
jest.mock('../src/lib/business-service', () => ({
  loadMembers: (...args: unknown[]) => mockLoad(...args),
}));
const rpc = jest.fn();
const client = { rpc } as unknown as OwnerBookClient;
describe('database-backed team UI', () => {
  beforeEach(async () => {
    await cleanup();
    mockWorkspace.active.membership.role = 'staff';
    mockWorkspace.canInvite = false;
    mockLoad.mockResolvedValue(mockMembers);
    rpc.mockResolvedValue({ error: null });
  });
  it('hides owner actions from staff but still enforces nothing on the client alone', async () => {
    await render(<MemberScreen client={client} invitations={jest.fn()} onCreate={jest.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Owner')[0]).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Change role' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invite member' })).toBeNull();
  });
  it('requires confirmation before removing a member and calls the protected RPC', async () => {
    mockWorkspace.active.membership.role = 'owner';
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<MemberScreen client={client} invitations={jest.fn()} onCreate={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Remove member' })[0]).toBeTruthy(),
    );
    await fireEvent.press(screen.getAllByRole('button', { name: 'Remove member' })[0]!);
    expect(rpc).not.toHaveBeenCalled();
    const buttons = spy.mock.calls[0]![2]!;
    const confirm = buttons.find((button) => button.text === 'Confirm')!;
    await act(async () => {
      confirm.onPress?.();
    });
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('remove_member', {
        p_business_id: 'biz',
        p_user_id: 'owner',
      }),
    );
    spy.mockRestore();
  });
  it('renders a useful retry state after access is revoked', async () => {
    mockLoad.mockRejectedValue({ code: '42501' });
    await render(<MemberScreen client={client} invitations={jest.fn()} onCreate={jest.fn()} />);
    await waitFor(() => expect(screen.getByText(/do not have permission/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Refresh members' })).toBeTruthy();
  });
});
