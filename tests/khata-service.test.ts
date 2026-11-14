import {
  archiveCustomer,
  customerStatement,
  listCustomers,
  moneyAt,
  recordAdjustment,
  recordPayment,
  saveCustomer,
  voidPayment,
  type AdjustmentDraft,
  type CustomerDraft,
  type PaymentDraft,
} from '../src/lib/khata-service';
import { isOperationId } from '../src/lib/operation-id';
import type { OwnerBookClient } from '../src/lib/supabase';

const payment: PaymentDraft = {
  businessId: 'biz',
  customerId: 'cust',
  saleId: null,
  direction: 'received',
  amount: '500',
  method: 'cash',
  date: '2026-11-06',
  reference: '',
  note: '',
  scale: 2,
};
const adjustment: AdjustmentDraft = {
  businessId: 'biz',
  customerId: 'cust',
  amount: '-25.5',
  reason: 'Goods returned',
  note: '',
  date: '2026-11-06',
  scale: 2,
};
const customer: CustomerDraft = {
  businessId: 'biz',
  customerId: null,
  name: 'Ali Khan',
  phone: '+923001234567',
  email: '',
  address: '',
  openingBalance: '1500.5',
  scale: 2,
};

function clientReturning(data: unknown) {
  const rpc = jest.fn().mockResolvedValue({ data, error: null });
  return { client: { rpc } as unknown as OwnerBookClient, rpc };
}

/**
 * The service layer is the last place a bad amount can be stopped before it
 * reaches the server, and the first place an idempotency key is attached.
 */
describe('khata service', () => {
  it('normalises money to the currency scale exactly', () => {
    expect(moneyAt('500', 2)).toBe('500.00');
    expect(moneyAt('500.005', 2)).toBe('500.01');
    expect(moneyAt('-25.5', 2)).toBe('-25.50');
    expect(moneyAt('1234', 0)).toBe('1234');
    expect(moneyAt('1.2345', 3)).toBe('1.235');
    expect(moneyAt('abc', 2)).toBeNull();
    expect(moneyAt('1,000', 2)).toBeNull();
    expect(moneyAt('1.2345678', 2)).toBeNull();
  });

  it('records a payment with a normalized amount and an operation id', async () => {
    const { client, rpc } = clientReturning({
      payment_id: 'pay',
      amount: '500.00',
      currency: 'PKR',
      customer_outstanding: '1500.50',
      replayed: false,
    });
    const result = await recordPayment(client, payment);
    expect(result.customer_outstanding).toBe('1500.50');
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('record_payment');
    expect(args).toEqual({
      p_operation_id: expect.any(String),
      p_business_id: 'biz',
      p_customer_id: 'cust',
      p_sale_id: null,
      p_direction: 'received',
      p_amount: '500.00',
      p_payment_method: 'cash',
      p_payment_date: '2026-11-06',
      p_reference: null,
      p_note: null,
    });
    expect(isOperationId(args.p_operation_id)).toBe(true);
  });

  it('sends the reference and note when the user actually wrote one', async () => {
    const { client, rpc } = clientReturning({ replayed: false });
    await recordPayment(client, { ...payment, reference: ' TID 42 ', note: ' Paid at counter ' });
    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_reference).toBe('TID 42');
    expect(args.p_note).toBe('Paid at counter');
  });

  it('reuses the same operation id when a lost response forces a retry', async () => {
    const rpc = jest
      .fn()
      .mockRejectedValueOnce({ message: 'Network request failed' })
      .mockResolvedValueOnce({ data: { replayed: true, amount: '500.00' }, error: null });
    const client = { rpc } as unknown as OwnerBookClient;
    const result = await recordPayment(client, payment);
    expect(result.replayed).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
    const [first, second] = rpc.mock.calls as [string, Record<string, unknown>][];
    expect(first?.[1].p_operation_id).toBe(second?.[1].p_operation_id);
  });

  it('surfaces a database rejection without retrying it', async () => {
    const rejection = { code: 'P0002', message: 'This business is archived; restore it first' };
    const rpc = jest.fn().mockRejectedValue(rejection);
    const client = { rpc } as unknown as OwnerBookClient;
    await expect(recordPayment(client, payment)).rejects.toBe(rejection);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('validates a payment before any network call', async () => {
    const cases: [Partial<PaymentDraft>, RegExp][] = [
      [{ amount: '0' }, /greater than zero/i],
      [{ amount: '-5' }, /greater than zero/i],
      [{ amount: 'abc' }, /plain number/i],
      [{ amount: '1,000' }, /plain number/i],
      [{ method: 'credit' }, /how the money moved/i],
      [{ date: '' }, /payment date/i],
      [{ reference: 'x'.repeat(61) }, /at most 60 characters/i],
      [{ note: 'x'.repeat(501) }, /at most 500 characters/i],
    ];
    for (const [patch, message] of cases) {
      const rpc = jest.fn();
      const client = { rpc } as unknown as OwnerBookClient;
      await expect(recordPayment(client, { ...payment, ...patch })).rejects.toMatchObject({
        code: 'OWNERBOOK_VALIDATION',
        message: expect.stringMatching(message),
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('voids a payment only with a reason, and passes it through', async () => {
    const { client, rpc } = clientReturning({ replayed: false, amount: '500.00' });
    await voidPayment(client, 'pay', '  Entered twice  ');
    expect(rpc).toHaveBeenCalledWith('void_payment', {
      p_operation_id: expect.any(String),
      p_payment_id: 'pay',
      p_reason: 'Entered twice',
    });
    for (const reason of ['', '   ', 'x'.repeat(201)]) {
      const rejecting = { rpc: jest.fn() } as unknown as OwnerBookClient;
      await expect(voidPayment(rejecting, 'pay', reason)).rejects.toMatchObject({
        code: 'OWNERBOOK_VALIDATION',
      });
      expect((rejecting as unknown as { rpc: jest.Mock }).rpc).not.toHaveBeenCalled();
    }
  });

  it('records a signed khata adjustment for a credit note', async () => {
    const { client, rpc } = clientReturning({ replayed: false, amount: '-25.50' });
    await recordAdjustment(client, adjustment);
    expect(rpc).toHaveBeenCalledWith('record_customer_adjustment', {
      p_operation_id: expect.any(String),
      p_business_id: 'biz',
      p_customer_id: 'cust',
      p_amount: '-25.50',
      p_reason: 'Goods returned',
      p_entry_date: '2026-11-06',
      p_note: null,
    });
  });

  it('refuses a zero adjustment or a missing reason', async () => {
    for (const patch of [{ amount: '0' }, { amount: '0.00' }, { reason: '' }, { amount: 'abc' }]) {
      const rpc = jest.fn();
      const client = { rpc } as unknown as OwnerBookClient;
      await expect(recordAdjustment(client, { ...adjustment, ...patch })).rejects.toMatchObject({
        code: 'OWNERBOOK_VALIDATION',
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('sends an opening balance only when the khata is opened', async () => {
    const { client, rpc } = clientReturning({ replayed: false, name: 'Ali Khan' });
    await saveCustomer(client, customer);
    const [, created] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(created.p_opening_balance).toBe('1500.50');
    expect(created.p_customer_id).toBeNull();
    expect(created.p_email).toBeNull();
    await saveCustomer(client, { ...customer, customerId: 'cust', openingBalance: null });
    const [, updated] = rpc.mock.calls[1] as [string, Record<string, unknown>];
    expect(updated.p_customer_id).toBe('cust');
    expect(updated.p_opening_balance).toBeNull();
  });

  it('validates a customer before any network call', async () => {
    const cases: [Partial<CustomerDraft>, RegExp][] = [
      [{ name: '' }, /customer name/i],
      [{ name: 'x'.repeat(121) }, /customer name/i],
      [{ phone: 'not a phone' }, /valid phone/i],
      [{ email: 'not an email' }, /valid email/i],
      [{ address: 'x'.repeat(241) }, /at most 240 characters/i],
      [{ openingBalance: 'abc' }, /opening balance/i],
    ];
    for (const [patch, message] of cases) {
      const rpc = jest.fn();
      const client = { rpc } as unknown as OwnerBookClient;
      await expect(saveCustomer(client, { ...customer, ...patch })).rejects.toMatchObject({
        code: 'OWNERBOOK_VALIDATION',
        message: expect.stringMatching(message),
      });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('archives and restores through a status call, not a delete', async () => {
    const { client, rpc } = clientReturning(null);
    await archiveCustomer(client, 'cust', true);
    expect(rpc).toHaveBeenCalledWith('archive_customer', {
      p_customer_id: 'cust',
      p_archived: true,
    });
    await archiveCustomer(client, 'cust', false);
    expect(rpc).toHaveBeenLastCalledWith('archive_customer', {
      p_customer_id: 'cust',
      p_archived: false,
    });
  });

  it('lists customers with the search and archive filters applied', async () => {
    const { client, rpc } = clientReturning([{ id: 'cust', name: 'Ali Khan' }]);
    const rows = await listCustomers(client, 'biz', {
      search: '  ali  ',
      includeArchived: true,
      limit: 25,
    });
    expect(rows).toHaveLength(1);
    expect(rpc).toHaveBeenCalledWith('list_customers', {
      p_business_id: 'biz',
      p_search: 'ali',
      p_include_archived: true,
      p_limit: 25,
      p_offset: 0,
    });
  });

  it('treats an empty result as an empty list, never as undefined', async () => {
    const { client } = clientReturning(null);
    await expect(listCustomers(client, 'biz')).resolves.toEqual([]);
  });

  it('says so when a khata is no longer readable instead of returning null', async () => {
    const { client } = clientReturning(null);
    await expect(customerStatement(client, 'gone')).rejects.toMatchObject({
      code: 'OWNERBOOK_VALIDATION',
      message: expect.stringMatching(/no longer available/i),
    });
  });

  it('passes a server error through untouched so the UI can explain it', async () => {
    const error = { code: '42501', message: 'permission denied for function customer_statement' };
    const rpc = jest.fn().mockResolvedValue({ data: null, error });
    const client = { rpc } as unknown as OwnerBookClient;
    await expect(customerStatement(client, 'cust')).rejects.toBe(error);
  });
});
