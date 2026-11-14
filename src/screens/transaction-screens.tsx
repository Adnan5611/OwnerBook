import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { OwnerBookClient } from '../lib/supabase';
import { useWorkspace } from '../providers/workspace-provider';
import {
  AmountRow,
  Button,
  Card,
  Choice,
  EmptyState,
  Field,
  ListItem,
  Loading,
  Notice,
  Screen,
  SectionTitle,
  Segmented,
  Tag,
  colors,
} from '../components/ui';
import { OfflineBanner } from '../components/OfflineBanner';
import {
  createSale,
  emptyLine,
  listProducts,
  listSales,
  previewSale,
  saleDetail,
  voidSale,
  type SaleDetail,
  type SaleDraft,
  type SaleLineDraft,
} from '../lib/sales-service';
import { createExpense, listExpenses, voidExpense } from '../lib/expense-service';
import { listCustomers, listPayments, voidPayment } from '../lib/khata-service';
import { periodSummary } from '../lib/summary-service';
import { capabilitiesFor } from '../lib/permissions';
import { safeErrorMessage } from '../lib/errors';
import { formatMoney, parseStoredAmount, subtractAmounts, toAmountText } from '../lib/decimal';
import {
  currentMonthRange,
  formatDayLabel,
  isValidIsoDate,
  isoDateInTimezone,
} from '../lib/business-time';
import {
  DIRECTION_LABELS,
  METHOD_LABELS,
  MONEY_METHODS,
  PAYMENT_METHODS,
  STATUS_LABELS,
} from '../lib/validation';
import type {
  CustomerRow,
  ExpenseRow,
  PaymentMethod,
  PaymentRow,
  PeriodSummaryResult,
  ProductRow,
  SaleRow,
} from '../types/database';

type Props = { client: OwnerBookClient };
type TransactionTab = 'sales' | 'payments' | 'expenses';

const TABS: readonly { value: TransactionTab; label: string }[] = [
  { value: 'sales', label: 'Sales' },
  { value: 'payments', label: 'Payments' },
  { value: 'expenses', label: 'Expenses' },
];

/**
 * Every total on this screen is read from PostgreSQL. The period card only
 * appears for the roles the database lets read financial summaries.
 */
export function TransactionsTab({
  client,
  onNewSale,
  onNewExpense,
  onOpenSale,
}: Props & {
  onNewSale: () => void;
  onNewExpense: () => void;
  onOpenSale: (saleId: string) => void;
}) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const timezone = business?.timezone ?? 'UTC';
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const [tab, setTab] = useState<TransactionTab>('sales');
  const [range, setRange] = useState(() => currentMonthRange(timezone));
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [summary, setSummary] = useState<PeriodSummaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<{ kind: 'payment' | 'expense'; id: string } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!business) return;
    if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
      setError('Enter a valid period, for example 2026-11-01 to 2026-11-30.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const window = { from, to, limit: 100 };
      const [saleRows, paymentRows] = await Promise.all([
        listSales(client, business.id, window),
        listPayments(client, business.id, window),
      ]);
      setSales(saleRows);
      setPayments(paymentRows);
      if (capabilities.canReadExpenses) {
        const [expenseRows, period] = await Promise.all([
          listExpenses(client, business.id, window),
          capabilities.canReadFinancialSummary
            ? periodSummary(client, business.id, from, to)
            : Promise.resolve(null),
        ]);
        setExpenses(expenseRows);
        setSummary(period);
      }
    } catch (cause) {
      setError(
        safeErrorMessage(cause, 'Could not load transactions. Nothing on this device changed.'),
      );
    } finally {
      setLoading(false);
    }
  }, [
    business,
    capabilities.canReadExpenses,
    capabilities.canReadFinancialSummary,
    client,
    from,
    to,
  ]);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) return refresh();
      });
      return () => {
        cancelled = true;
      };
    }, [refresh]),
  );
  const applyRange = () => {
    setRange({ from, to });
    void refresh();
  };
  const thisMonth = () => {
    const month = currentMonthRange(timezone);
    setFrom(month.from);
    setTo(month.to);
    setRange(month);
  };
  const confirmVoid = async () => {
    if (!voiding || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (voiding.kind === 'payment') {
        const result = await voidPayment(client, voiding.id, reason);
        setMessage(
          `Payment of ${formatMoney(result.amount, result.currency)} voided. Customer balance is now ${formatMoney(result.customer_outstanding, result.currency)}.`,
        );
      } else {
        const result = await voidExpense(client, voiding.id, reason);
        setMessage(
          `Expense of ${formatMoney(result.amount, result.currency)} voided and removed from the period total.`,
        );
      }
      setVoiding(null);
      setReason('');
      await refresh();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const tabs = capabilities.canReadExpenses
    ? TABS
    : TABS.filter((item) => item.value !== 'expenses');
  const rows =
    tab === 'sales' ? sales.length : tab === 'payments' ? payments.length : expenses.length;
  return (
    <Screen
      title="Transactions"
      subtitle={
        business ? `Sales, payments and expenses in ${business.name}` : 'Select a business first'
      }
    >
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      {!!message && <Notice>{message}</Notice>}
      {business?.archived_at && (
        <Notice>This business is archived. Records are readable; new ones are disabled.</Notice>
      )}
      <Segmented options={tabs} value={tab} onChange={setTab} />
      <Card>
        <SectionTitle>Period</SectionTitle>
        <Field
          label="From (YYYY-MM-DD)"
          value={from}
          onChangeText={setFrom}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <Field
          label="To (YYYY-MM-DD)"
          value={to}
          onChangeText={setTo}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="Apply" secondary onPress={applyRange} />
          <Button title="This month" secondary onPress={thisMonth} />
        </View>
        <Text style={{ color: colors.muted, fontSize: 12 }}>
          Dates are business days in {timezone}. The period shown is {formatDayLabel(range.from)} to{' '}
          {formatDayLabel(range.to)}.
        </Text>
      </Card>
      {summary && (
        <Card>
          <SectionTitle>Period result</SectionTitle>
          <AmountRow label="Revenue" amount={formatMoney(summary.revenue, currency)} />
          <AmountRow label="Cost of goods sold" amount={formatMoney(summary.cogs, currency)} />
          <AmountRow
            label="Gross profit"
            amount={formatMoney(summary.gross_profit, currency)}
            emphasis
          />
          <AmountRow label="Expenses" amount={formatMoney(summary.expense_total, currency)} />
          <AmountRow
            label="Net profit"
            amount={formatMoney(summary.net_profit, currency)}
            emphasis
            tone={parseStoredAmount(summary.net_profit) < 0n ? 'bad' : 'good'}
          />
          <AmountRow label="Cash in" amount={formatMoney(summary.cash_received_total, currency)} />
          <AmountRow label="Cash out" amount={formatMoney(summary.cash_paid_total, currency)} />
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
            Net profit = revenue − cost of goods sold − expenses. {summary.cogs_coverage_percent}%
            of this period&apos;s revenue has a recorded cost; the rest is still uncovered, so gross
            profit is a floor, not a final figure. Cash is counted separately from profit: money on
            credit is revenue but not cash yet.
          </Text>
        </Card>
      )}
      {!business?.archived_at && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {capabilities.canRecordSales && tab === 'sales' && (
            <Button title="Record a sale" onPress={onNewSale} />
          )}
          {capabilities.canRecordExpenses && tab === 'expenses' && (
            <Button title="Record an expense" onPress={onNewExpense} />
          )}
        </View>
      )}
      {loading && rows === 0 ? <Loading label="Loading transactions…" /> : null}
      {!loading && rows === 0 ? (
        <EmptyState
          title={`No ${tab} in this period`}
          message="Change the period, or record the first entry. Nothing here is estimated: the list is exactly what is stored for this business."
        />
      ) : null}
      {tab === 'sales' &&
        sales.map((sale) => (
          <ListItem
            key={sale.id}
            title={sale.customer_name ?? 'Counter sale'}
            subtitle={`${formatDayLabel(sale.sale_date)} · ${METHOD_LABELS[sale.payment_method]} · ${sale.item_count} line${sale.item_count === 1 ? '' : 's'}${sale.reference ? ` · ${sale.reference}` : ''}`}
            right={
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={{ fontSize: 15, fontWeight: '700', color: colors.ink }}>
                  {formatMoney(sale.total, sale.currency)}
                </Text>
                {sale.status === 'voided' ? (
                  <Tag label="VOIDED" tone="bad" />
                ) : parseStoredAmount(sale.due) > 0n ? (
                  <Text style={{ fontSize: 12, color: colors.red }}>
                    due {formatMoney(sale.due, sale.currency)}
                  </Text>
                ) : null}
              </View>
            }
            muted={sale.status === 'voided'}
            onPress={() => onOpenSale(sale.id)}
          />
        ))}
      {tab === 'payments' &&
        payments.map((payment) => (
          <View key={payment.id} style={{ gap: 8 }}>
            <ListItem
              title={`${DIRECTION_LABELS[payment.direction]} · ${payment.customer_name}`}
              subtitle={`${formatDayLabel(payment.payment_date)} · ${METHOD_LABELS[payment.payment_method]}${payment.reference ? ` · ${payment.reference}` : ''}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.ink }}>
                    {formatMoney(payment.amount, payment.currency)}
                  </Text>
                  {payment.status === 'voided' ? <Tag label="VOIDED" tone="bad" /> : null}
                </View>
              }
              muted={payment.status === 'voided'}
            />
            {capabilities.canVoidDocuments &&
              payment.status === 'posted' &&
              !business?.archived_at &&
              (voiding?.id === payment.id ? (
                <Card>
                  <Field
                    label="Reason for voiding"
                    value={reason}
                    onChangeText={setReason}
                    placeholder="Entered twice by mistake"
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button
                      title="Confirm void"
                      danger
                      busy={busy}
                      onPress={() => void confirmVoid()}
                    />
                    <Button
                      title="Cancel"
                      secondary
                      onPress={() => {
                        setVoiding(null);
                        setReason('');
                      }}
                    />
                  </View>
                  <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
                    Voiding reverses the khata entry and keeps the original record with your reason.
                    Nothing is deleted.
                  </Text>
                </Card>
              ) : (
                <Button
                  title="Void this payment"
                  secondary
                  danger
                  onPress={() => {
                    setReason('');
                    setVoiding({ kind: 'payment', id: payment.id });
                  }}
                />
              ))}
          </View>
        ))}
      {tab === 'expenses' &&
        expenses.map((expense) => (
          <View key={expense.id} style={{ gap: 8 }}>
            <ListItem
              title={expense.category}
              subtitle={`${formatDayLabel(expense.expense_date)} · ${METHOD_LABELS[expense.payment_method]}${expense.note ? ` · ${expense.note}` : ''}`}
              right={
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Text style={{ fontSize: 15, fontWeight: '700', color: colors.ink }}>
                    {formatMoney(expense.amount, expense.currency)}
                  </Text>
                  {expense.status === 'voided' ? <Tag label="VOIDED" tone="bad" /> : null}
                </View>
              }
              muted={expense.status === 'voided'}
            />
            {capabilities.canVoidDocuments &&
              expense.status === 'posted' &&
              !business?.archived_at &&
              (voiding?.id === expense.id ? (
                <Card>
                  <Field
                    label="Reason for voiding"
                    value={reason}
                    onChangeText={setReason}
                    placeholder="Wrong category, re-entered"
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <Button
                      title="Confirm void"
                      danger
                      busy={busy}
                      onPress={() => void confirmVoid()}
                    />
                    <Button
                      title="Cancel"
                      secondary
                      onPress={() => {
                        setVoiding(null);
                        setReason('');
                      }}
                    />
                  </View>
                </Card>
              ) : (
                <Button
                  title="Void this expense"
                  secondary
                  danger
                  onPress={() => {
                    setReason('');
                    setVoiding({ kind: 'expense', id: expense.id });
                  }}
                />
              ))}
          </View>
        ))}
      <Button title="Refresh" secondary busy={loading} onPress={() => void refresh()} />
    </Screen>
  );
}

export function SaleFormScreen({
  client,
  customerId = null,
  onDone,
}: Props & { customerId?: string | null; onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const timezone = business?.timezone ?? 'UTC';
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [lines, setLines] = useState<SaleLineDraft[]>(() => [emptyLine('line-1')]);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(customerId);
  const [date, setDate] = useState(() => isoDateInTimezone(timezone));
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [paid, setPaid] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      const [customerRows, productRows] = await Promise.all([
        listCustomers(client, business.id, { limit: 200 }),
        listProducts(client, business.id, { limit: 200 }),
      ]);
      setCustomers(customerRows);
      setProducts(productRows);
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load customers and items for this sale.'));
    } finally {
      setLoading(false);
    }
  }, [business, client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!business)
    return (
      <Screen title="Sale" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const draft: SaleDraft = {
    businessId: business.id,
    customerId: selectedCustomer,
    date,
    method,
    paidAmount: paid,
    lines,
    scale,
    reference,
    note,
  };
  const preview = previewSale(draft);
  const updateLine = (key: string, patch: Partial<SaleLineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const addLine = () =>
    setLines((current) => [...current, emptyLine(`line-${current.length + 1}-${Date.now()}`)]);
  const removeLine = (key: string) =>
    setLines((current) =>
      current.length > 1 ? current.filter((line) => line.key !== key) : current,
    );
  const pickProduct = (key: string, product: ProductRow | null) => {
    if (!product) {
      updateLine(key, { productId: null, itemName: '', unitPrice: '', unitCost: '' });
      return;
    }
    updateLine(key, {
      productId: product.id,
      itemName: product.name,
      unit: product.unit,
      unitPrice: product.sale_price,
      unitCost: product.cost_price,
    });
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const sale = await createSale(client, draft);
      const balance = sale.customer_outstanding
        ? ` The customer now owes ${formatMoney(sale.customer_outstanding, sale.currency)}.`
        : '';
      onDone(
        `Sale saved: total ${formatMoney(sale.total, sale.currency)}, paid ${formatMoney(sale.paid_amount, sale.currency)}, due ${formatMoney(sale.due, sale.currency)}.${balance}`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (loading && lines.length === 1 && !lines[0]?.itemName)
    return <Loading label="Loading customers and items…" />;
  return (
    <Screen title="Record a sale" subtitle={`Amounts are exact ${currency} decimals`}>
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      {!!preview.problem && <Notice error>{preview.problem}</Notice>}
      <Card>
        <SectionTitle>Who is buying</SectionTitle>
        <Choice
          label="Counter sale (no khata)"
          hint="Must be paid in full now"
          selected={selectedCustomer === null}
          onPress={() => setSelectedCustomer(null)}
        />
        {customers.map((customer) => (
          <Choice
            key={customer.id}
            label={customer.name}
            hint={
              parseStoredAmount(customer.outstanding) === 0n
                ? 'Settled account'
                : `Currently owes ${formatMoney(customer.outstanding, currency)}`
            }
            selected={selectedCustomer === customer.id}
            onPress={() => setSelectedCustomer(customer.id)}
          />
        ))}
        {customers.length === 0 && (
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            No customers yet. Add one in the Khata tab to sell on credit.
          </Text>
        )}
      </Card>
      <Card>
        <Field
          label="Sale date (YYYY-MM-DD)"
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
          placeholder={isoDateInTimezone(timezone)}
        />
        <Field
          label="Reference (optional)"
          value={reference}
          onChangeText={setReference}
          placeholder="Slip or token number"
        />
        <Field label="Note (optional)" value={note} onChangeText={setNote} />
      </Card>
      {lines.map((line, index) => {
        const linePreview = preview.lines.find((item) => item.key === line.key);
        return (
          <Card key={line.key}>
            <SectionTitle>Line {index + 1}</SectionTitle>
            {products.map((product) => (
              <Choice
                key={product.id}
                label={product.name}
                hint={`Sells at ${formatMoney(product.sale_price, currency)} per ${product.unit}`}
                selected={line.productId === product.id}
                onPress={() => pickProduct(line.key, product)}
              />
            ))}
            <Button
              title="Custom item (not in the catalog)"
              secondary
              onPress={() => pickProduct(line.key, null)}
            />
            {line.productId === null && (
              <>
                <Field
                  label="Item name"
                  value={line.itemName}
                  onChangeText={(value) => updateLine(line.key, { itemName: value })}
                  placeholder="Loose sugar"
                />
                <Field
                  label="Unit"
                  value={line.unit}
                  onChangeText={(value) => updateLine(line.key, { unit: value })}
                  placeholder="kg"
                />
              </>
            )}
            <Field
              label="Quantity"
              value={line.quantity}
              onChangeText={(value) => updateLine(line.key, { quantity: value })}
              keyboardType="decimal-pad"
            />
            <Field
              label={`Unit price (${currency})`}
              value={line.unitPrice}
              onChangeText={(value) => updateLine(line.key, { unitPrice: value })}
              keyboardType="decimal-pad"
            />
            <Field
              label={`Line discount (${currency}, optional)`}
              value={line.discount}
              onChangeText={(value) => updateLine(line.key, { discount: value })}
              keyboardType="decimal-pad"
              placeholder="0"
            />
            <Field
              label={`Unit cost (${currency}, optional)`}
              value={line.unitCost}
              onChangeText={(value) => updateLine(line.key, { unitCost: value })}
              keyboardType="decimal-pad"
              placeholder="0"
            />
            {linePreview && (
              <AmountRow
                label={`Line total${linePreview.valid ? '' : ' (incomplete)'}`}
                amount={formatMoney(linePreview.total, currency)}
                emphasis
                tone={linePreview.valid ? undefined : 'bad'}
              />
            )}
            <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
              Each line is rounded to {scale} decimals before it is summed, exactly as the server
              does: round(quantity × price) − round(discount).
            </Text>
            {lines.length > 1 && (
              <Button
                title="Remove this line"
                secondary
                danger
                onPress={() => removeLine(line.key)}
              />
            )}
          </Card>
        );
      })}
      <Button title="Add another line" secondary onPress={addLine} />
      <Card>
        <SectionTitle>How they are paying</SectionTitle>
        {PAYMENT_METHODS.map((option) => (
          <Choice
            key={option}
            label={METHOD_LABELS[option]}
            hint={
              option === 'credit'
                ? 'Nothing is received now; the whole total goes to the khata'
                : undefined
            }
            selected={method === option}
            onPress={() => setMethod(option)}
          />
        ))}
        {method !== 'credit' && (
          <Field
            label={`Amount received now (${currency})`}
            value={paid}
            onChangeText={setPaid}
            keyboardType="decimal-pad"
            placeholder={preview.total}
          />
        )}
      </Card>
      <Card>
        <SectionTitle>Totals</SectionTitle>
        <AmountRow label="Subtotal" amount={formatMoney(preview.subtotal, currency)} />
        <AmountRow label="Discounts" amount={formatMoney(preview.discountTotal, currency)} />
        <AmountRow label="Total" amount={formatMoney(preview.total, currency)} emphasis />
        <AmountRow label="Cost of goods" amount={formatMoney(preview.cogs, currency)} />
        <AmountRow
          label="Gross profit on this sale"
          amount={formatMoney(
            toAmountText(
              subtractAmounts(parseStoredAmount(preview.total), parseStoredAmount(preview.cogs)),
              scale,
            ),
            currency,
          )}
        />
        <AmountRow label="Paid now" amount={formatMoney(preview.paid, currency)} />
        <AmountRow
          label={parseStoredAmount(preview.due) > 0n ? 'Due from customer' : 'Balance'}
          amount={formatMoney(preview.due, currency)}
          emphasis
          tone={parseStoredAmount(preview.due) > 0n ? 'bad' : 'good'}
        />
        <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
          These figures are calculated on the phone with exact decimal arithmetic that mirrors the
          server, then recomputed and stored by PostgreSQL. The saved document is the server&apos;s
          version.
        </Text>
      </Card>
      <Button
        title="Save sale"
        busy={busy}
        disabled={!!preview.problem || !!business.archived_at}
        onPress={() => void submit()}
      />
      {business.archived_at && (
        <Notice>An archived business cannot take new sales. Restore it in Settings first.</Notice>
      )}
    </Screen>
  );
}

export function SaleDetailScreen({
  client,
  saleId,
  onDone,
}: Props & { saleId: string; onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const [detail, setDetail] = useState<SaleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await saleDetail(client, saleId));
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load this sale.'));
    } finally {
      setLoading(false);
    }
  }, [client, saleId]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );
  if (loading && !detail) return <Loading label="Loading the sale…" />;
  if (!detail)
    return (
      <Screen title="Sale" subtitle="Not available">
        {!!error && <Notice error>{error}</Notice>}
      </Screen>
    );
  const { sale, items } = detail;
  const due = toAmountText(
    subtractAmounts(parseStoredAmount(sale.total), parseStoredAmount(sale.paid_amount)),
    scale,
  );
  const confirmVoid = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await voidSale(client, saleId, reason);
      setVoiding(false);
      setReason('');
      await refresh();
      onDone(
        `Sale voided. ${formatMoney(result.total, result.currency)} was reversed${result.customer_outstanding ? ` and the customer balance is now ${formatMoney(result.customer_outstanding, result.currency)}` : ''}.`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title={`Sale ${formatDayLabel(sale.sale_date)}`} subtitle={STATUS_LABELS[sale.status]}>
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      {sale.status === 'voided' && (
        <Notice error>
          This sale is voided. It stays in the history with the reason below and is excluded from
          every report.
        </Notice>
      )}
      <Card>
        <SectionTitle>Document</SectionTitle>
        <AmountRow label="Total" amount={formatMoney(sale.total, currency)} emphasis />
        <AmountRow label="Subtotal" amount={formatMoney(sale.subtotal, currency)} />
        <AmountRow label="Discounts" amount={formatMoney(sale.discount_total, currency)} />
        <AmountRow label="Cost of goods" amount={formatMoney(sale.cogs, currency)} />
        <AmountRow label="Paid at the counter" amount={formatMoney(sale.paid_amount, currency)} />
        <AmountRow
          label="Due"
          amount={formatMoney(due, currency)}
          tone={parseStoredAmount(due) > 0n ? 'bad' : 'good'}
        />
        <AmountRow label="Payment method" amount={METHOD_LABELS[sale.payment_method]} />
        <AmountRow label="Currency" amount={sale.currency} />
        {sale.reference ? <AmountRow label="Reference" amount={sale.reference} /> : null}
        {sale.note ? <AmountRow label="Note" amount={sale.note} /> : null}
        {sale.void_reason ? <AmountRow label="Void reason" amount={sale.void_reason} /> : null}
      </Card>
      <Card>
        <SectionTitle>Items as sold</SectionTitle>
        {items.map((item) => (
          <View key={item.id} style={{ paddingVertical: 8, gap: 3 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: colors.ink, fontWeight: '600', flexShrink: 1 }}>
                {item.item_name}
              </Text>
              <Text style={{ color: colors.ink, fontWeight: '700' }}>
                {formatMoney(item.line_total, currency)}
              </Text>
            </View>
            <Text style={{ color: colors.muted, fontSize: 12 }}>
              {item.quantity} {item.unit} × {formatMoney(item.unit_price)}
              {parseStoredAmount(item.discount) > 0n
                ? ` − ${formatMoney(item.discount)} discount`
                : ''}
              {parseStoredAmount(item.line_cogs) > 0n
                ? ` · cost ${formatMoney(item.line_cogs)}`
                : ' · no cost recorded'}
            </Text>
          </View>
        ))}
        <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
          Prices and costs are snapshots taken when the sale was recorded. Editing the catalog does
          not rewrite this document.
        </Text>
      </Card>
      {capabilities.canVoidDocuments && sale.status === 'posted' && !business?.archived_at && (
        <Card>
          {voiding ? (
            <>
              <Field
                label="Reason for voiding"
                value={reason}
                onChangeText={setReason}
                placeholder="Wrong quantity entered"
              />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  title="Confirm void"
                  danger
                  busy={busy}
                  onPress={() => void confirmVoid()}
                />
                <Button title="Cancel" secondary onPress={() => setVoiding(false)} />
              </View>
              <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
                Voiding writes reversing khata entries for any customer balance and a refund is
                handled separately as a payment. The sale is never deleted.
              </Text>
            </>
          ) : (
            <Button title="Void this sale" danger secondary onPress={() => setVoiding(true)} />
          )}
        </Card>
      )}
      <Button title="Refresh" secondary busy={loading} onPress={() => void refresh()} />
    </Screen>
  );
}

export function ExpenseFormScreen({
  client,
  onDone,
}: Props & { onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const timezone = business?.timezone ?? 'UTC';
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [date, setDate] = useState(() => isoDateInTimezone(timezone));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!business)
    return (
      <Screen title="Expense" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createExpense(client, {
        businessId: business.id,
        date,
        category,
        amount,
        method,
        reference,
        note,
        scale,
      });
      onDone(
        `Expense of ${formatMoney(result.amount, result.currency)} recorded under ${result.category}.`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Record an expense" subtitle={`Paid out of ${currency}`}>
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      <Card>
        <Field
          label="Category"
          value={category}
          onChangeText={setCategory}
          placeholder="Rent, fuel, wages…"
        />
        <Field
          label={`Amount (${currency})`}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <Field
          label="Date (YYYY-MM-DD)"
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
          placeholder={isoDateInTimezone(timezone)}
        />
        <Field
          label="Reference (optional)"
          value={reference}
          onChangeText={setReference}
          placeholder="Bill number"
        />
        <Field label="Note (optional)" value={note} onChangeText={setNote} />
      </Card>
      <Card>
        <SectionTitle>How it was paid</SectionTitle>
        {MONEY_METHODS.map((option) => (
          <Choice
            key={option}
            label={METHOD_LABELS[option]}
            selected={method === option}
            onPress={() => setMethod(option)}
          />
        ))}
      </Card>
      <Button
        title="Save expense"
        busy={busy}
        disabled={!!business.archived_at}
        onPress={() => void submit()}
      />
      {business.archived_at && <Notice>An archived business cannot take new expenses.</Notice>}
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        An expense reduces cash and net profit. It never touches a customer balance, so receivables
        and profit stay separate figures.
      </Text>
    </Screen>
  );
}
