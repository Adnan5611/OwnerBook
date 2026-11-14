import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import {
  BusinessForm,
  CreateInvitationScreen,
  InvitationScreen,
} from '../src/screens/business-screens';
import type { OwnerBookClient } from '../src/lib/supabase';
jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
jest.mock('expo-linking', () => ({
  createURL: (path: string) => `ownerbook://${path}`,
  openURL: jest.fn(async () => true),
}));
const mockWorkspace = {
  active: {
    business: {
      id: 'biz',
      name: 'Real shop',
      currency: 'PKR',
      timezone: 'UTC',
      co_owners_can_invite: false,
    },
    membership: { role: 'owner' },
  },
  currencies: [{ code: 'PKR', name: 'Pakistani rupee', minor_units: 2 }],
  canInvite: true,
  refresh: jest.fn(),
  select: jest.fn(),
};
const mockService = {
  createBusiness: jest.fn(),
  saveBusinessSettings: jest.fn(),
  createInvitation: jest.fn(),
  previewInvitation: jest.fn(),
  acceptInvitation: jest.fn(),
};
jest.mock('../src/providers/workspace-provider', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('../src/lib/business-service', () => ({
  createBusiness: (...args: unknown[]) => mockService.createBusiness(...args),
  saveBusinessSettings: (...args: unknown[]) => mockService.saveBusinessSettings(...args),
  createInvitation: (...args: unknown[]) => mockService.createInvitation(...args),
  previewInvitation: (...args: unknown[]) => mockService.previewInvitation(...args),
  acceptInvitation: (...args: unknown[]) => mockService.acceptInvitation(...args),
}));
const client = {} as OwnerBookClient;
describe('persistent business and invitation forms', () => {
  beforeEach(() => {
    mockWorkspace.canInvite = true;
    mockWorkspace.refresh.mockResolvedValue([{ business: { id: 'new-biz' } }]);
    mockService.createBusiness.mockResolvedValue('new-biz');
    Object.values(mockService)
      .filter((fn) => fn !== mockService.createBusiness)
      .forEach((fn) => fn.mockResolvedValue(undefined));
  });
  it('creates a real business and refreshes memberships', async () => {
    const done = jest.fn();
    await render(<BusinessForm client={client} onDone={done} />);
    await fireEvent.changeText(screen.getByLabelText('Business name'), 'My shop');
    await fireEvent.press(screen.getByRole('button', { name: 'Create business' }));
    await waitFor(() =>
      expect(mockService.createBusiness).toHaveBeenCalledWith(
        client,
        'My shop',
        'PKR',
        expect.any(String),
      ),
    );
    expect(mockWorkspace.refresh).toHaveBeenCalled();
    expect(mockWorkspace.select).toHaveBeenCalledWith('new-biz', [{ business: { id: 'new-biz' } }]);
    expect(done).toHaveBeenCalled();
  });
  it('shows validation failures without claiming a save', async () => {
    mockService.createBusiness.mockRejectedValue({
      code: 'OWNERBOOK_VALIDATION',
      message: 'Enter a business name of 1–120 characters.',
    });
    const done = jest.fn();
    await render(<BusinessForm client={client} onDone={done} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Create business' }));
    await waitFor(() =>
      expect(screen.getByText('Enter a business name of 1–120 characters.')).toBeTruthy(),
    );
    expect(done).not.toHaveBeenCalled();
  });
  it('previews before accepting and clears the consumed bearer token', async () => {
    const token = 'a'.repeat(64);
    mockService.previewInvitation.mockResolvedValue({
      token,
      preview: {
        business_id: 'biz',
        business_name: 'Invited shop',
        role: 'staff',
        expires_at: '2026-11-03T00:00:00Z',
      },
    });
    const joined = jest.fn();
    await render(<InvitationScreen client={client} initialToken={token} onJoined={joined} />);
    expect(mockService.acceptInvitation).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Check invitation' }));
    await waitFor(() => expect(screen.getByText('Invited shop')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Accept and join' }));
    await waitFor(() => expect(mockService.acceptInvitation).toHaveBeenCalledWith(client, token));
    expect(joined).toHaveBeenCalled();
  });
  it('does not offer an invitation form to unauthorized roles', async () => {
    mockWorkspace.canInvite = false;
    await render(<CreateInvitationScreen client={client} />);
    expect(screen.getByText('Your current role cannot create invitations.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate secure invitation' })).toBeNull();
  });
  it('shows a new invitation only after the server issues it', async () => {
    const token = 'b'.repeat(64);
    mockService.createInvitation.mockResolvedValue({
      invitation_id: 'invite',
      token,
      expires_at: '2026-11-03T00:00:00Z',
    });
    await render(<CreateInvitationScreen client={client} />);
    expect(screen.queryByText(/ownerbook:\/\/invite/)).toBeNull();
    await fireEvent.changeText(
      screen.getByLabelText('Invitee email (optional but recommended)'),
      'a@b.com',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Generate secure invitation' }));
    await waitFor(() => expect(screen.getByText(`ownerbook://invite?token=${token}`)).toBeTruthy());
    expect(mockService.createInvitation).toHaveBeenCalledWith(
      client,
      'biz',
      'staff',
      'a@b.com',
      168,
    );
    expect(screen.getByLabelText('Invitee email (optional but recommended)').props.editable).toBe(
      false,
    );
    expect(screen.getByRole('button', { name: 'Manager' }).props.accessibilityState.disabled).toBe(
      true,
    );
    expect(
      screen.getByRole('button', { name: 'Generate secure invitation' }).props.accessibilityState
        .disabled,
    ).toBe(true);
  });
});
