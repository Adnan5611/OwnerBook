import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SaleFormScreen } from '../src/screens/transaction-screens';
import { isOperationId } from '../src/lib/operation-id';
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

const customer = {
  id: 'cust-1',
  name: 'Ali Khan',
  phone: null,
  email: null,
  address: null,
  opening_balance: '0.00',
  outstanding: '1500.50',
  archived_at: null,
  last_entry_at: null,
  entry_count: 2,
  created_at: '2026-11-01T09:00:00Z',
};
const product = {
  id: 'prod-1',
  name: 'Basmati rice 5 kg',
  sku: 'RICE-5KG',
  unit: 'bag',
  sale_price: '199.999',
  cost_price: '150',
  archived_at: null,
  created_at: '2026-11-01T09:00:00Z',
};
const saleResult = {
  sale_id: 'sale-1',
  currency: 'PKR',
  scale: 2,
  sale_date: '2026-11-06',
  subtotal: '310.00',
  discount_total: '0.00',
  total: '310.00',
  cogs: '235.00',
  paid_amount: '0.00',
  due: '310.00',
  lines: 2,
  customer_id: 'cust-1',
  customer_outstanding: '1810.50',
  replayed: false,
};

const rpc = jest.fn();
const client = { rpc } as unknown as OwnerBookClient;

/**
 * The service layer is deliberately NOT mocked here: the screen runs the real
 * preview, the real validation and the real idempotent posting, and only the
 * network boundary is faked. That is what proves the previewed total is the
 * total that would be sent to PostgreSQL.
 */
async function buildSale() {
  await fireEvent.press(screen.getByRole('radio', { name: 'Ali Khan' }));
  await fireEvent.press(screen.getByRole('radio', { name: 'Basmati rice 5 kg' }));
  await fireEvent.changeText(screen.getByLabelText('Quantity'), '1.5');
  await fireEvent.press(screen.getByRole('button', { name: 'Add another line' }));
  const customButtons = screen.getAllByRole('button', {
    name: 'Custom item (not in the catalog)',
  });
  await fireEvent.press(customButtons[1] as never);
  // Only the custom line shows name and unit fields; the catalog line does not.
  await fireEvent.changeText(screen.getByLabelText('Item name'), 'Loose sugar');
  await fireEvent.changeText(screen.getByLabelText('Unit'), 'kg');
  const quantities = screen.getAllByLabelText('Quantity');
  await fireEvent.changeText(quantities[1] as never, '2');
  const prices = screen.getAllByLabelText('Unit price (PKR)');
  await fireEvent.changeText(prices[1] as never, '5');
}

describe('sale entry', () => {
  beforeEach(async () => {
    await cleanup();
    rpc.mockReset();
    mockWorkspace.active.business.archived_at = null;
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_customers') return { data: [customer], error: null };
      if (name === 'list_products') return { data: [product], error: null };
      if (name === 'create_sale') return { data: saleResult, error: null };
      return { data: null, error: null };
    });
  });

  it('loads the real catalog and customer list for the business', async () => {
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Basmati rice 5 kg' })).toBeTruthy(),
    );
    expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Counter sale (no khata)' })).toBeTruthy();
    expect(screen.getByText(/Sells at PKR 199.999 per bag/)).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith(
      'list_customers',
      expect.objectContaining({ p_business_id: 'biz' }),
    );
    expect(rpc).toHaveBeenCalledWith(
      'list_products',
      expect.objectContaining({ p_business_id: 'biz' }),
    );
  });

  it('prices each line exactly, rounding per line before summing', async () => {
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    await buildSale();
    // 1.5 × 199.999 = 299.9985 -> 300.00, and 2 × 5 = 10.00; the sale is 310.00.
    await waitFor(() => expect(screen.getByText('PKR 300.00')).toBeTruthy());
    expect(screen.getByText('PKR 10.00')).toBeTruthy();
    expect(screen.getAllByText('PKR 310.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Cost of goods')).toBeTruthy();
    // 1.5 × 150 = 225.00 plus 2 × 0 = 225.00
    expect(screen.getByText('PKR 225.00')).toBeTruthy();
    expect(screen.getByText('PKR 85.00')).toBeTruthy();
  });

  it('keeps a credit sale fully due and hides money received', async () => {
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    await buildSale();
    await fireEvent.press(screen.getByRole('radio', { name: 'Credit (nothing received now)' }));
    await waitFor(() => expect(screen.queryByLabelText(/Amount received now/)).toBeNull());
    // Subtotal, total and due are all 310.00 once nothing is received now.
    expect(screen.getAllByText('PKR 310.00').length).toBe(3);
    expect(screen.getByText('Due from customer')).toBeTruthy();
  });

  it('posts one sale with a snapshot of every line and one operation id', async () => {
    const onDone = jest.fn();
    await render(<SaleFormScreen client={client} onDone={onDone} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    await buildSale();
    await fireEvent.press(screen.getByRole('radio', { name: 'Credit (nothing received now)' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save sale' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Save sale' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = rpc.mock.calls.find((entry: unknown[]) => entry[0] === 'create_sale') as
      [string, Record<string, unknown>] | undefined;
    expect(call).toBeTruthy();
    const args = call?.[1] as Record<string, unknown>;
    expect(args).toMatchObject({
      p_business_id: 'biz',
      p_customer_id: 'cust-1',
      p_payment_method: 'credit',
      p_paid_amount: '0.00',
      p_reference: null,
      p_note: null,
      p_items: [
        {
          product_id: 'prod-1',
          item_name: 'Basmati rice 5 kg',
          unit: 'bag',
          quantity: '1.5',
          unit_price: '199.999',
          discount: '0',
          unit_cost: '150',
        },
        {
          product_id: null,
          item_name: 'Loose sugar',
          unit: 'kg',
          quantity: '2',
          unit_price: '5',
          discount: '0',
          unit_cost: '0',
        },
      ],
    });
    expect(args.p_sale_date).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(isOperationId(args.p_operation_id)).toBe(true);
    expect(rpc.mock.calls.filter((entry: unknown[]) => entry[0] === 'create_sale')).toHaveLength(1);
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('PKR 310.00'));
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('PKR 1,810.50'));
  });

  it('will not save while a line is incomplete and says what is missing', async () => {
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save sale' })).toBeDisabled();
    expect(screen.getByText('Every line needs a name, a quantity and a price.')).toBeTruthy();
    expect(rpc.mock.calls.some((entry: unknown[]) => entry[0] === 'create_sale')).toBe(false);
  });

  it('insists a counter sale is paid in full', async () => {
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('radio', { name: 'Basmati rice 5 kg' }));
    await fireEvent.changeText(screen.getByLabelText('Quantity'), '1');
    await fireEvent.changeText(screen.getByLabelText('Amount received now (PKR)'), '100');
    expect(screen.getByText('A sale without a customer must be paid in full.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save sale' })).toBeDisabled();
  });

  it('reports a server refusal instead of claiming the sale was saved', async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === 'list_customers') return { data: [customer], error: null };
      if (name === 'list_products') return { data: [product], error: null };
      if (name === 'create_sale')
        return {
          data: null,
          error: {
            code: '23514',
            message: 'new row violates check constraint "sales_total_check"',
          },
        };
      return { data: null, error: null };
    });
    const onDone = jest.fn();
    await render(<SaleFormScreen client={client} onDone={onDone} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('radio', { name: 'Ali Khan' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Basmati rice 5 kg' }));
    await fireEvent.changeText(screen.getByLabelText('Amount received now (PKR)'), '199.99');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save sale' })).toBeEnabled());
    await fireEvent.press(screen.getByRole('button', { name: 'Save sale' }));
    await waitFor(() =>
      expect(
        screen.getByText('Those amounts are not allowed. Check the totals and try again.'),
      ).toBeTruthy(),
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('refuses to record a sale for an archived business', async () => {
    mockWorkspace.active.business.archived_at = '2026-10-01T00:00:00Z';
    await render(<SaleFormScreen client={client} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Ali Khan' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Save sale' })).toBeDisabled();
    expect(
      screen.getByText('An archived business cannot take new sales. Restore it in Settings first.'),
    ).toBeTruthy();
  });
});
