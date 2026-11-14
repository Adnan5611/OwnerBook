import { cleanup, render, screen, waitFor } from '@testing-library/react-native';
import { HomeScreen, type HomeActions } from '../src/screens/home-screen';
import type { OwnerBookClient } from '../src/lib/supabase';

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) =>
    jest.requireActual('react').useEffect(callback, [callback]),
}));
jest.mock('@react-native-community/netinfo', () => ({
  useNetInfo: () => ({ isConnected: true, isInternetReachable: true }),
}));

const mockWorkspace = {
  active: {
    business: {
      id: 'biz',
      name: 'Real shop',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      archived_at: null as string | null,
    },
    membership: { role: 'owner' as string },
  },
  currencies: [{ code: 'PKR', name: 'Pakistani rupee', minor_units: 2 }],
  profile: null,
  loading: false,
  error: null,
  refresh: jest.fn(),
  select: jest.fn(),
};
jest.mock('../src/providers/workspace-provider', () => ({ useWorkspace: () => mockWorkspace }));

const mockSummary = {
  balanceSummary: jest.fn(),
  periodSummary: jest.fn(),
  listActivity: jest.fn(),
};
jest.mock('../src/lib/summary-service', () => ({
  balanceSummary: (...args: unknown[]) => mockSummary.balanceSummary(...args),
  periodSummary: (...args: unknown[]) => mockSummary.periodSummary(...args),
  listActivity: (...args: unknown[]) => mockSummary.listActivity(...args),
}));

const client = {} as OwnerBookClient;
const actions: HomeActions = {
  onNewSale: jest.fn(),
  onCatalog: jest.fn(),
  onKhata: jest.fn(),
  onMembers: jest.fn(),
  onBusinesses: jest.fn(),
  onJoinBusiness: jest.fn(),
  onOpenSale: jest.fn(),
};
const balance = {
  business_id: 'biz',
  currency: 'PKR',
  scale: 2,
  currency_locked_at: '2026-11-01T00:00:00Z',
  financial_activity: true,
  as_of: '2026-11-06T12:00:00Z',
  customer_count: 7,
  product_count: 12,
  receivables_total: '12500.00',
  customers_owing_count: 4,
  customer_credit_total: '300.00',
  customers_in_credit_count: 1,
  net_receivables: '12200.00',
  cash_methods: [
    { method: 'cash', received: '9000.00', paid: '1200.00', net: '7800.00' },
    { method: 'bank', received: '2000.00', paid: '0.00', net: '2000.00' },
  ],
  cash_received_total: '11000.00',
  cash_paid_total: '1200.00',
  cash_net_total: '9800.00',
};
const period = {
  business_id: 'biz',
  currency: 'PKR',
  scale: 2,
  from: '2026-11-01',
  to: '2026-11-30',
  sales_count: 9,
  subtotal: '20000.00',
  discount_total: '500.00',
  revenue: '19500.00',
  cogs: '12000.00',
  gross_profit: '7500.00',
  expense_count: 3,
  expense_total: '4300.00',
  net_profit: '3200.00',
  counter_receipts_total: '6000.00',
  collections_count: 5,
  collections_total: '5000.00',
  refunds_count: 1,
  refunds_total: '200.00',
  cash_received_total: '11000.00',
  cash_paid_total: '5500.00',
  cogs_coverage_percent: '86.5',
};
const activity = [
  {
    id: 'act-1',
    actor_id: 'user',
    actor_name: 'Ali Owner',
    action: 'sale.created',
    entity_type: 'sale',
    entity_id: 'sale-1',
    summary: 'Sold 2 items to Ali Khan',
    amount: '2000.50',
    created_at: '2026-11-05T09:00:00Z',
  },
  {
    id: 'act-2',
    actor_id: 'user',
    actor_name: 'Ali Owner',
    action: 'expense.created',
    entity_type: 'expense',
    entity_id: 'exp-1',
    summary: 'Recorded rent',
    amount: '4000.00',
    created_at: '2026-11-04T09:00:00Z',
  },
];

describe('role-aware dashboard', () => {
  beforeEach(async () => {
    await cleanup();
    mockWorkspace.active.membership.role = 'owner';
    mockWorkspace.active.business.archived_at = null;
    mockWorkspace.error = null;
    mockSummary.balanceSummary.mockResolvedValue(balance);
    mockSummary.periodSummary.mockResolvedValue(period);
    mockSummary.listActivity.mockResolvedValue(activity);
  });

  it('shows receivables, cash and profit calculated by the server', async () => {
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText('PKR 12,500.00')).toBeTruthy());
    expect(screen.getByText('PKR 12,200.00')).toBeTruthy();
    expect(screen.getByText('PKR 9,800.00')).toBeTruthy();
    expect(screen.getByText('PKR 19,500.00')).toBeTruthy();
    expect(screen.getByText('PKR 12,000.00')).toBeTruthy();
    expect(screen.getByText('PKR 7,500.00')).toBeTruthy();
    expect(screen.getByText('PKR 4,300.00')).toBeTruthy();
    expect(screen.getByText('PKR 3,200.00')).toBeTruthy();
    expect(screen.getByText(/86.5% of this month's revenue has a recorded cost/)).toBeTruthy();
  });

  it('keeps cash separate from profit and says why', async () => {
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText('Cash on hand')).toBeTruthy());
    expect(screen.getByText(/revenue today but cash only when the customer pays/)).toBeTruthy();
    expect(screen.getByText(/Net profit = revenue − cost of goods sold − expenses/)).toBeTruthy();
    expect(screen.getByText('cash')).toBeTruthy();
    expect(screen.getByText('bank')).toBeTruthy();
  });

  it('asks the server for the current business month in the business timezone', async () => {
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(mockSummary.periodSummary).toHaveBeenCalled());
    expect(mockSummary.balanceSummary).toHaveBeenCalledWith(client, 'biz');
    expect(mockSummary.listActivity).toHaveBeenCalledWith(client, 'biz', 12);
    const [, businessId, from, to] = mockSummary.periodSummary.mock.calls[0] as unknown[];
    expect(businessId).toBe('biz');
    expect(from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(to).toMatch(/^\d{4}-\d{2}-(28|29|30|31)$/);
  });

  it('shows the activity feed with the amount formatted in the business currency', async () => {
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText('Sale recorded')).toBeTruthy());
    expect(screen.getByText('Expense recorded')).toBeTruthy();
    expect(screen.getByText('Sold 2 items to Ali Khan')).toBeTruthy();
    expect(screen.getByText('PKR 2,000.50')).toBeTruthy();
    expect(screen.getAllByText(/Ali Owner ·/).length).toBe(2);
  });

  it('does not ask for summaries a role is not allowed to read', async () => {
    mockWorkspace.active.membership.role = 'staff';
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText(/cannot read financial summaries/)).toBeTruthy());
    expect(mockSummary.balanceSummary).not.toHaveBeenCalled();
    expect(mockSummary.periodSummary).not.toHaveBeenCalled();
    // The feed is readable by every member, and it is still requested.
    expect(mockSummary.listActivity).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Record a sale' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Items and prices' })).toBeNull();
  });

  it('offers no financial shortcut on an archived business', async () => {
    mockWorkspace.active.business.archived_at = '2026-10-01T00:00:00Z';
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText(/This business is archived/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Record a sale' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the khata' })).toBeTruthy();
  });

  it('reports a failed load instead of showing zeros', async () => {
    mockSummary.balanceSummary.mockRejectedValue({
      code: 'P0002',
      message: 'You are not a member of this business',
    });
    await render(<HomeScreen client={client} actions={actions} />);
    // The raw server text is never shown; the mapped copy explains the refusal.
    await waitFor(() =>
      expect(screen.getByText('That record no longer exists. Refresh and try again.')).toBeTruthy(),
    );
    expect(screen.queryByText('PKR 12,500.00')).toBeNull();
    expect(screen.queryByText(/You are not a member/)).toBeNull();
  });

  it('says so when the books are genuinely empty', async () => {
    mockSummary.balanceSummary.mockResolvedValue({
      ...balance,
      financial_activity: false,
      receivables_total: '0.00',
      net_receivables: '0.00',
      cash_net_total: '0.00',
      customers_owing_count: 0,
      customer_credit_total: '0.00',
      customers_in_credit_count: 0,
    });
    mockSummary.listActivity.mockResolvedValue([]);
    await render(<HomeScreen client={client} actions={actions} />);
    await waitFor(() => expect(screen.getByText('Nothing recorded yet')).toBeTruthy());
    expect(screen.getByText(/every figure below is a real zero rather than a sample/)).toBeTruthy();
  });
});
