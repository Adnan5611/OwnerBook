import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppNavigation } from '../src/navigation/app-navigation';
import type { OwnerBookClient } from '../src/lib/supabase';
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockAuth = {
  session: null as { user: { id: string; email: string } } | null,
  recovery: false,
};
const mockWorkspace = {
  active: null as null | {
    business: { id: string; name: string; currency: string; timezone: string; archived_at: null };
    membership: { role: string };
  },
  memberships: [],
  profile: null,
  loading: false,
  error: null,
  currencies: [],
  canInvite: false,
  refresh: jest.fn(),
  select: jest.fn(),
};
jest.mock('../src/providers/auth-provider', () => ({ useAuth: () => mockAuth }));
jest.mock('../src/providers/workspace-provider', () => ({
  useWorkspace: () => mockWorkspace,
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/hooks/use-connection', () => ({
  useConnection: () => ({ state: { kind: 'idle' }, check: jest.fn() }),
}));
jest.mock('@react-native-community/netinfo', () => ({
  useNetInfo: () => ({ isConnected: true, isInternetReachable: true }),
}));
jest.mock('../src/screens/member-screen', () => ({
  MemberScreen: () => null,
  InvitationsScreen: () => null,
}));
jest.mock('../src/screens/home-screen', () => ({
  HomeScreen: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Home route</Text>;
  },
}));
jest.mock('../src/screens/khata-screens', () => ({
  KhataTab: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Khata route</Text>;
  },
  CustomerDetailScreen: () => null,
  CustomerFormScreen: () => null,
  PaymentFormScreen: () => null,
  AdjustmentFormScreen: () => null,
}));
jest.mock('../src/screens/transaction-screens', () => ({
  TransactionsTab: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Transactions route</Text>;
  },
  SaleFormScreen: () => null,
  SaleDetailScreen: () => null,
  ExpenseFormScreen: () => null,
}));
jest.mock('../src/screens/catalog-screen', () => ({
  CatalogScreen: () => null,
  ProductFormScreen: () => null,
}));
jest.mock('../src/screens/business-screens', () => ({
  BusinessForm: () => null,
  CreateInvitationScreen: () => null,
  InvitationScreen: ({ initialToken }: { initialToken?: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>Invitation route: {initialToken}</Text>;
  },
  ArchiveBusiness: () => null,
  BusinessPicker: () => null,
}));
const client = {} as OwnerBookClient;
describe('Android navigation gates', () => {
  beforeEach(() => {
    mockAuth.session = null;
    mockAuth.recovery = false;
    mockWorkspace.active = null;
    mockWorkspace.loading = false;
  });
  it('waits for workspace routes before opening a pending invitation link', async () => {
    mockAuth.session = { user: { id: 'user', email: 'a@b.com' } };
    mockWorkspace.active = null;
    mockWorkspace.loading = true;
    const view = await render(
      <AppNavigation client={client} inviteToken={'a'.repeat(64)} clearInvite={jest.fn()} />,
    );
    expect(screen.queryByText(/Invitation route:/)).toBeNull();
    mockWorkspace.loading = false;
    await view.rerender(
      <AppNavigation client={client} inviteToken={'a'.repeat(64)} clearInvite={jest.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByText(`Invitation route: ${'a'.repeat(64)}`)).toBeTruthy(),
    );
  });
  it('does not mount business navigation before authentication', async () => {
    await render(<AppNavigation client={client} clearInvite={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Home')).toBeNull();
  });
  it('shows the five required bottom tabs for an actual active membership', async () => {
    mockAuth.session = { user: { id: 'user', email: 'a@b.com' } };
    mockWorkspace.active = {
      business: {
        id: 'biz',
        name: 'Real business',
        currency: 'PKR',
        timezone: 'UTC',
        archived_at: null,
      },
      membership: { role: 'owner' },
    };
    await render(<AppNavigation client={client} clearInvite={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Home route')).toBeTruthy());
    for (const tab of ['Home', 'Khata', 'Transactions', 'Chat', 'Settings'])
      expect(screen.getByRole('tab', { name: new RegExp(tab) })).toBeTruthy();
    await fireEvent.press(screen.getByRole('tab', { name: /Khata/ }));
    await waitFor(() => expect(screen.getByText('Khata route')).toBeTruthy());
    await fireEvent.press(screen.getByRole('tab', { name: /Transactions/ }));
    await waitFor(() => expect(screen.getByText('Transactions route')).toBeTruthy());
    await fireEvent.press(screen.getByRole('tab', { name: /Chat/ }));
    await waitFor(() => expect(screen.getByText('No demo data')).toBeTruthy());
    await fireEvent.press(screen.getByRole('tab', { name: /Settings/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy());
  });
});
