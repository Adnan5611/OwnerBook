import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CustomerDetailScreen, KhataTab, PaymentFormScreen } from '../src/screens/khata-screens';
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
      timezone: 'UTC',
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

const mockService = {
  listCustomers: jest.fn(),
  customerBalance: jest.fn(),
  customerStatement: jest.fn(),
  archiveCustomer: jest.fn(),
  recordPayment: jest.fn(),
  recordAdjustment: jest.fn(),
  saveCustomer: jest.fn(),
};
jest.mock('../src/lib/khata-service', () => ({
  listCustomers: (...args: unknown[]) => mockService.listCustomers(...args),
  customerBalance: (...args: unknown[]) => mockService.customerBalance(...args),
  customerStatement: (...args: unknown[]) => mockService.customerStatement(...args),
  archiveCustomer: (...args: unknown[]) => mockService.archiveCustomer(...args),
  recordPayment: (...args: unknown[]) => mockService.recordPayment(...args),
  recordAdjustment: (...args: unknown[]) => mockService.recordAdjustment(...args),
  saveCustomer: (...args: unknown[]) => mockService.saveCustomer(...args),
}));

const client = {} as OwnerBookClient;
const customers = [
  {
    id: 'cust-1',
    name: 'Ali Khan',
    phone: '+923001234567',
    email: null,
    address: null,
    opening_balance: '0.00',
    outstanding: '1500.50',
    archived_at: null,
    last_entry_at: '2026-11-05T09:00:00Z',
    entry_count: 4,
    created_at: '2026-11-01T09:00:00Z',
  },
  {
    id: 'cust-2',
    name: 'Fatima Stores',
    phone: null,
    email: null,
    address: null,
    opening_balance: '0.00',
    outstanding: '-250.00',
    archived_at: null,
    last_entry_at: null,
    entry_count: 1,
    created_at: '2026-11-02T09:00:00Z',
  },
];

describe('customer khata screens', () => {
  beforeEach(async () => {
    await cleanup();
    mockWorkspace.active.business.archived_at = null;
    mockWorkspace.active.membership.role = 'owner';
    mockService.listCustomers.mockResolvedValue(customers);
    mockService.customerBalance.mockResolvedValue({
      customer_id: 'cust-1',
      business_id: 'biz',
      customer_name: 'Ali Khan',
      customer_archived_at: null,
      currency: 'PKR',
      scale: 2,
      outstanding: '1500.50',
    });
    mockService.customerStatement.mockResolvedValue({
      customer_id: 'cust-1',
      business_id: 'biz',
      customer_name: 'Ali Khan',
      customer_archived_at: null,
      currency: 'PKR',
      scale: 2,
      from: null,
      to: null,
      entry_count: 2,
      truncated: false,
      opening_outstanding: '0.00',
      closing_outstanding: '1500.50',
      debited_total: '2000.50',
      credited_total: '500.00',
      entries: [
        {
          id: 'led-1',
          entry_type: 'sale',
          amount: '2000.50',
          entry_date: '2026-11-04',
          running_balance: '2000.50',
          reference_type: 'sale',
          reference_id: 'sale-1',
          note: null,
          created_at: '2026-11-04T09:00:00Z',
          created_by: 'user',
        },
        {
          id: 'led-2',
          entry_type: 'payment',
          amount: '-500.00',
          entry_date: '2026-11-05',
          running_balance: '1500.50',
          reference_type: 'payment',
          reference_id: 'pay-1',
          note: 'Cash at counter',
          created_at: '2026-11-05T09:00:00Z',
          created_by: 'user',
        },
      ],
    });
    mockService.recordPayment.mockResolvedValue({
      payment_id: 'pay-2',
      direction: 'received',
      amount: '500.00',
      currency: 'PKR',
      customer_outstanding: '1000.50',
      replayed: false,
    });
    mockService.archiveCustomer.mockResolvedValue(undefined);
  });

  it('shows real balances from the ledger, positive and negative', async () => {
    await render(<KhataTab client={client} onOpenCustomer={jest.fn()} onNewCustomer={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Ali Khan')).toBeTruthy());
    expect(screen.getByText('PKR 1,500.50')).toBeTruthy();
    expect(screen.getByText('Fatima Stores')).toBeTruthy();
    expect(screen.getByText('PKR -250.00')).toBeTruthy();
    expect(screen.getByText('Owing you')).toBeTruthy();
  });

  it('opens the khata of the customer that was pressed', async () => {
    const onOpenCustomer = jest.fn();
    await render(
      <KhataTab client={client} onOpenCustomer={onOpenCustomer} onNewCustomer={jest.fn()} />,
    );
    await waitFor(() => expect(screen.getByText('Ali Khan')).toBeTruthy());
    await fireEvent.press(screen.getByText('Ali Khan'));
    expect(onOpenCustomer).toHaveBeenCalledWith('cust-1');
  });

  it('searches on the server rather than filtering a page locally', async () => {
    await render(<KhataTab client={client} onOpenCustomer={jest.fn()} onNewCustomer={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Ali Khan')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('Search customers'), '  fatima  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mockService.listCustomers).toHaveBeenLastCalledWith(
        client,
        'biz',
        expect.objectContaining({ search: 'fatima' }),
      ),
    );
  });

  it('explains an empty khata instead of showing zeros', async () => {
    mockService.listCustomers.mockResolvedValue([]);
    await render(<KhataTab client={client} onOpenCustomer={jest.fn()} onNewCustomer={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('No customers yet')).toBeTruthy());
    expect(screen.getByText(/never estimated/)).toBeTruthy();
  });

  it('reports a failure honestly and changes nothing on the device', async () => {
    mockService.listCustomers.mockRejectedValue({
      code: '42501',
      message: 'permission denied for function list_customers',
    });
    await render(<KhataTab client={client} onOpenCustomer={jest.fn()} onNewCustomer={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/could not load customers|permission/i)).toBeTruthy(),
    );
  });

  it('blocks new records for an archived business but keeps history readable', async () => {
    mockWorkspace.active.business.archived_at = '2026-10-01T00:00:00Z';
    await render(<KhataTab client={client} onOpenCustomer={jest.fn()} onNewCustomer={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Ali Khan')).toBeTruthy());
    expect(screen.getByText(/archived\. History is readable/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add customer' })).toBeNull();
  });

  it('renders a statement with a running balance per entry', async () => {
    await render(
      <CustomerDetailScreen
        client={client}
        customerId="cust-1"
        onEdit={jest.fn()}
        onPayment={jest.fn()}
        onAdjust={jest.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('PKR 1,500.50')).toBeTruthy());
    expect(screen.getByText('This customer owes you this amount.')).toBeTruthy();
    expect(screen.getByText('Sale')).toBeTruthy();
    expect(screen.getByText('Payment')).toBeTruthy();
    expect(screen.getByText('balance 2,000.50')).toBeTruthy();
    expect(screen.getByText('balance 1,500.50')).toBeTruthy();
    expect(screen.getByText(/Cash at counter/)).toBeTruthy();
    // The statement carries the name, so no customer list is paged through.
    expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0);
    expect(mockService.listCustomers).not.toHaveBeenCalled();
    expect(mockService.customerStatement).toHaveBeenCalledWith(client, 'cust-1', { limit: 100 });
  });

  it('shows what the customer owes before a payment is recorded', async () => {
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Before this payment')).toBeTruthy());
    expect(screen.getByText('Currently outstanding')).toBeTruthy();
    expect(screen.getByText('PKR 1,500.50')).toBeTruthy();
    expect(screen.getByText(/A payment received reduces this balance./)).toBeTruthy();
    expect(mockService.listCustomers).not.toHaveBeenCalled();
  });

  it('explains a customer advance instead of calling it a debt', async () => {
    mockService.customerBalance.mockResolvedValue({
      customer_id: 'cust-1',
      business_id: 'biz',
      customer_name: 'Ali Khan',
      customer_archived_at: null,
      currency: 'PKR',
      scale: 2,
      outstanding: '-250.00',
    });
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('PKR -250.00')).toBeTruthy());
    expect(screen.getByText(/This customer is in advance/)).toBeTruthy();
  });

  it('hides khata corrections and archiving from staff', async () => {
    mockWorkspace.active.membership.role = 'staff';
    await render(
      <CustomerDetailScreen
        client={client}
        customerId="cust-1"
        onEdit={jest.fn()}
        onPayment={jest.fn()}
        onAdjust={jest.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText('PKR 1,500.50')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Credit or debit note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive customer' })).toBeNull();
    // Staff still record payments: the database allows it and so does the UI.
    expect(screen.getByRole('button', { name: 'Record a payment' })).toBeTruthy();
  });

  it('records a payment and reports the balance the server returned', async () => {
    const onDone = jest.fn();
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByText('Record payment')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('Amount (PKR)'), '500');
    await fireEvent.press(screen.getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(mockService.recordPayment).toHaveBeenCalled());
    const [, draft] = mockService.recordPayment.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(draft).toMatchObject({
      businessId: 'biz',
      customerId: 'cust-1',
      direction: 'received',
      amount: '500',
      method: 'cash',
      scale: 2,
    });
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(expect.stringContaining('PKR 1,000.50')),
    );
  });

  it('records a refund as money going back to the customer', async () => {
    const onDone = jest.fn();
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={onDone} />);
    await waitFor(() => expect(screen.getByText('Record payment')).toBeTruthy());
    await fireEvent.press(screen.getByRole('radio', { name: 'Refunded to customer' }));
    await fireEvent.changeText(screen.getByLabelText('Amount (PKR)'), '50');
    await fireEvent.press(screen.getByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(mockService.recordPayment).toHaveBeenCalled());
    const [, draft] = mockService.recordPayment.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(draft).toMatchObject({ direction: 'refunded' });
  });

  it('shows why a payment was refused without pretending it was saved', async () => {
    mockService.recordPayment.mockRejectedValue({
      code: 'OWNERBOOK_VALIDATION',
      message: 'Enter an amount greater than zero.',
    });
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Record payment')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Save payment' }));
    await waitFor(() =>
      expect(screen.getByText('Enter an amount greater than zero.')).toBeTruthy(),
    );
  });

  it('offers every way money can move, but not credit', async () => {
    await render(<PaymentFormScreen client={client} customerId="cust-1" onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByText('Record payment')).toBeTruthy());
    for (const label of ['Cash', 'Bank transfer', 'Mobile wallet', 'Cheque', 'Other'])
      expect(screen.getByRole('radio', { name: label })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /credit/i })).toBeNull();
  });
});
