import { useCallback, useState } from 'react';
import { Alert, Text, View } from 'react-native';
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
  Money,
  Notice,
  Screen,
  SectionTitle,
  colors,
} from '../components/ui';
import { OfflineBanner } from '../components/OfflineBanner';
import {
  archiveCustomer,
  customerBalance,
  customerStatement,
  listCustomers,
  recordAdjustment,
  recordPayment,
  saveCustomer,
  type CustomerDraft,
} from '../lib/khata-service';
import { capabilitiesFor } from '../lib/permissions';
import { safeErrorMessage } from '../lib/errors';
import { formatMoney, isNegativeAmount, parseStoredAmount } from '../lib/decimal';
import { formatDayLabel, isoDateInTimezone } from '../lib/business-time';
import {
  DIRECTION_LABELS,
  LEDGER_LABELS,
  METHOD_LABELS,
  MONEY_METHODS,
  validCustomerName,
} from '../lib/validation';
import type {
  CustomerBalanceResult,
  CustomerRow,
  PaymentDirection,
  PaymentMethod,
  StatementResult,
} from '../types/database';

type Props = { client: OwnerBookClient };

function tone(amount: string): 'good' | 'bad' | undefined {
  const units = parseStoredAmount(amount);
  if (units === 0n) return undefined;
  return isNegativeAmount(units) ? 'good' : 'bad';
}

export function KhataTab({
  client,
  onOpenCustomer,
  onNewCustomer,
}: Props & { onOpenCustomer: (customerId: string) => void; onNewCustomer: () => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const timezone = business?.timezone ?? 'UTC';
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      setCustomers(
        await listCustomers(client, business.id, {
          search: query,
          includeArchived: showArchived,
          limit: 200,
        }),
      );
    } catch (cause) {
      setError(
        safeErrorMessage(cause, 'Could not load customers. Nothing on this device was changed.'),
      );
    } finally {
      setLoading(false);
    }
  }, [business, client, query, showArchived]);
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
  const owing = customers.filter((customer) => parseStoredAmount(customer.outstanding) > 0n);
  const inCredit = customers.filter((customer) => parseStoredAmount(customer.outstanding) < 0n);
  return (
    <Screen
      title="Khata"
      subtitle={business ? `Customer accounts for ${business.name}` : 'Select a business first'}
    >
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      {business?.archived_at && (
        <Notice>This business is archived. History is readable; new records are disabled.</Notice>
      )}
      <Card>
        <Field
          label="Search customers"
          value={search}
          onChangeText={setSearch}
          placeholder="Name or phone number"
          returnKeyType="search"
          onSubmitEditing={() => setQuery(search.trim())}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button title="Search" secondary onPress={() => setQuery(search.trim())} />
          <Button
            title={showArchived ? 'Hide archived' : 'Show archived'}
            secondary
            onPress={() => setShowArchived((value) => !value)}
          />
        </View>
      </Card>
      {capabilities.canManageCustomers && !business?.archived_at && (
        <Button title="Add customer" onPress={onNewCustomer} />
      )}
      {loading && customers.length === 0 ? <Loading label="Loading customer balances…" /> : null}
      {!loading && customers.length === 0 ? (
        <EmptyState
          title={query ? 'No customer matches that search' : 'No customers yet'}
          message={
            query
              ? 'Clear the search to see every customer khata in this business.'
              : 'Add a customer to open a khata. Balances are calculated from real sales, payments and notes — never estimated.'
          }
        />
      ) : null}
      {customers.length > 0 && (
        <Card>
          <SectionTitle>Loaded accounts</SectionTitle>
          <AmountRow label="Customers shown" amount={String(customers.length)} />
          <AmountRow label="Owing you" amount={String(owing.length)} />
          <AmountRow label="In credit" amount={String(inCredit.length)} />
          {customers.length >= 200 && (
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              The first 200 accounts are loaded. Search to narrow the list.
            </Text>
          )}
        </Card>
      )}
      {customers.map((customer) => (
        <ListItem
          key={customer.id}
          title={customer.name}
          subtitle={[
            customer.phone ?? 'No phone number',
            customer.archived_at ? 'Archived' : null,
            customer.last_entry_at
              ? `Last entry ${formatDayLabel(customer.last_entry_at.slice(0, 10))}`
              : 'No entries yet',
          ]
            .filter(Boolean)
            .join(' · ')}
          rightLabel={formatMoney(customer.outstanding, currency)}
          muted={!!customer.archived_at}
          onPress={() => onOpenCustomer(customer.id)}
        />
      ))}
      {!loading && customers.length > 0 && (
        <Button title="Refresh balances" secondary onPress={() => void refresh()} />
      )}
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        A positive balance means the customer owes you. A negative balance means you hold their
        advance. Every figure comes from the append-only khata ledger for{' '}
        {isoDateInTimezone(timezone)}.
      </Text>
    </Screen>
  );
}

export function CustomerDetailScreen({
  client,
  customerId,
  onEdit,
  onPayment,
  onAdjust,
}: Props & {
  customerId: string;
  onEdit: () => void;
  onPayment: () => void;
  onAdjust: () => void;
}) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const [statement, setStatement] = useState<StatementResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // One call: the statement carries the balance, the entries, the customer's
      // name and its archive state, so no customer list has to be paged through.
      setStatement(await customerStatement(client, customerId, { limit: 100 }));
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load this khata.'));
    } finally {
      setLoading(false);
    }
  }, [client, customerId]);
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
  const toggleArchive = () => {
    if (!statement || busy) return;
    const archiving = !statement.customer_archived_at;
    Alert.alert(
      archiving ? 'Archive this customer?' : 'Restore this customer?',
      archiving
        ? 'The khata history stays readable and any outstanding balance is kept. New credit sales are blocked until you restore it.'
        : 'The customer can take new credit sales again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: archiving ? 'Archive' : 'Restore',
          style: archiving ? 'destructive' : 'default',
          onPress: () => {
            setBusy(true);
            setError(null);
            void archiveCustomer(client, customerId, archiving)
              .then(() => {
                setMessage(archiving ? 'Customer archived.' : 'Customer restored.');
                return refresh();
              })
              .catch((cause: unknown) => setError(safeErrorMessage(cause)))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };
  if (loading && !statement) return <Loading label="Loading the khata…" />;
  const outstanding = statement?.closing_outstanding ?? '0';
  return (
    <Screen title={statement?.customer_name ?? 'Customer'} subtitle="Khata statement">
      <OfflineBanner />
      {!!error && <Notice error>{error}</Notice>}
      {!!message && <Notice>{message}</Notice>}
      {statement?.customer_archived_at && (
        <Notice>
          This customer is archived. The khata stays readable and any outstanding balance is kept,
          but new credit sales are blocked until it is restored.
        </Notice>
      )}
      <Card>
        <SectionTitle>Outstanding</SectionTitle>
        <Money amount={formatMoney(outstanding, currency)} size="large" tone={tone(outstanding)} />
        <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
          {parseStoredAmount(outstanding) > 0n
            ? 'This customer owes you this amount.'
            : parseStoredAmount(outstanding) < 0n
              ? 'You hold this amount as a customer advance.'
              : 'This account is settled.'}
        </Text>
        {statement && (
          <>
            <AmountRow label="Currency" amount={statement.currency} />
            <AmountRow label="Entries in view" amount={String(statement.entries.length)} />
            <AmountRow label="Charged" amount={formatMoney(statement.debited_total, currency)} />
            <AmountRow label="Received" amount={formatMoney(statement.credited_total, currency)} />
          </>
        )}
        {statement?.truncated && (
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            Showing the {statement.entries.length} most recent of {statement.entry_count} entries.
          </Text>
        )}
      </Card>
      {!business?.archived_at && (
        <View style={{ gap: 10 }}>
          {capabilities.canRecordPayments && (
            <Button title="Record a payment" onPress={onPayment} />
          )}
          {capabilities.canAdjustKhata && (
            <Button title="Credit or debit note" secondary onPress={onAdjust} />
          )}
          {capabilities.canManageCustomers && (
            <Button title="Edit details" secondary onPress={onEdit} />
          )}
          {capabilities.canArchiveCustomers && statement && (
            <Button
              title={statement.customer_archived_at ? 'Restore customer' : 'Archive customer'}
              danger={!statement.customer_archived_at}
              secondary={!!statement.customer_archived_at}
              busy={busy}
              onPress={toggleArchive}
            />
          )}
        </View>
      )}
      <Card>
        <SectionTitle>Statement</SectionTitle>
        {statement && statement.entries.length === 0 && (
          <Text style={{ color: colors.muted }}>
            No entries yet. Record a sale or an opening balance to start this khata.
          </Text>
        )}
        {statement?.entries.map((entry) => (
          <View key={entry.id} style={{ paddingVertical: 10, gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: colors.ink, fontWeight: '600', flexShrink: 1 }}>
                {LEDGER_LABELS[entry.entry_type]}
              </Text>
              <Text
                style={{
                  color: isNegativeAmount(parseStoredAmount(entry.amount))
                    ? colors.green
                    : colors.ink,
                  fontWeight: '700',
                }}
              >
                {formatMoney(entry.amount, statement.currency)}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: colors.muted, fontSize: 12, flexShrink: 1 }}>
                {formatDayLabel(entry.entry_date)}
                {entry.note ? ` · ${entry.note}` : ''}
              </Text>
              <Text style={{ color: colors.muted, fontSize: 12 }}>
                balance {formatMoney(entry.running_balance)}
              </Text>
            </View>
          </View>
        ))}
      </Card>
      <Button title="Refresh statement" secondary onPress={() => void refresh()} busy={loading} />
    </Screen>
  );
}

export function CustomerFormScreen({
  client,
  customerId,
  onDone,
}: Props & { customerId?: string | null; onDone: () => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const [existing, setExisting] = useState<CustomerRow | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [opening, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!customerId);
  const load = useCallback(async () => {
    if (!business || !customerId) return;
    setLoading(true);
    try {
      const rows = await listCustomers(client, business.id, { includeArchived: true, limit: 200 });
      const found = rows.find((row) => row.id === customerId) ?? null;
      setExisting(found);
      if (found) {
        setName(found.name);
        setPhone(found.phone ?? '');
        setEmail(found.email ?? '');
        setAddress(found.address ?? '');
      }
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load this customer.'));
    } finally {
      setLoading(false);
    }
  }, [business, client, customerId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!business)
    return (
      <Screen title="Customer" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const submit = async () => {
    if (busy) return;
    if (!validCustomerName(name)) {
      setError('Enter a customer name of 1–120 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const draft: CustomerDraft = {
      businessId: business.id,
      customerId: customerId ?? null,
      name,
      phone,
      email,
      address,
      // The opening balance can only be set once, when the khata is opened.
      openingBalance: customerId ? null : opening.trim() === '' ? '0' : opening.trim(),
      scale,
    };
    try {
      await saveCustomer(client, draft);
      onDone();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (loading) return <Loading label="Loading customer…" />;
  return (
    <Screen
      title={customerId ? 'Edit customer' : 'New customer'}
      subtitle={
        customerId ? 'Contact details only' : 'Contact details and an optional opening balance'
      }
    >
      {!!error && <Notice error>{error}</Notice>}
      <Card>
        <Field label="Name" value={name} onChangeText={setName} placeholder="Ali Khan" />
        <Field
          label="Phone (optional)"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="+923001234567"
        />
        <Field
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          placeholder="name@example.com"
        />
        <Field label="Address (optional)" value={address} onChangeText={setAddress} />
      </Card>
      {!customerId && (
        <Card>
          <SectionTitle>Opening balance</SectionTitle>
          <Field
            label={`Amount already owed (${currency})`}
            value={opening}
            onChangeText={setOpening}
            keyboardType="decimal-pad"
            placeholder="0"
          />
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
            Positive means the customer already owes you. Use a minus sign for an advance you
            already hold. This can only be set now: later corrections are recorded as a dated credit
            or debit note, so the history stays intact.
          </Text>
        </Card>
      )}
      {customerId && existing && (
        <Card>
          <AmountRow label="Current balance" amount={formatMoney(existing.outstanding, currency)} />
          <Text style={{ color: colors.muted, fontSize: 13 }}>
            The opening balance of {formatMoney(existing.opening_balance, currency)} cannot be
            edited. Use a credit or debit note to correct it.
          </Text>
        </Card>
      )}
      <Button
        title={customerId ? 'Save changes' : 'Create customer'}
        onPress={() => void submit()}
        busy={busy}
      />
      {customerId && <Button title="Cancel" secondary onPress={onDone} />}
    </Screen>
  );
}

export function PaymentFormScreen({
  client,
  customerId,
  saleId = null,
  onDone,
}: Props & { customerId: string; saleId?: string | null; onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const [account, setAccount] = useState<CustomerBalanceResult | null>(null);
  const [direction, setDirection] = useState<PaymentDirection>('received');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [date, setDate] = useState(isoDateInTimezone(business?.timezone ?? 'UTC'));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setAccount(await customerBalance(client, customerId));
    } catch (cause) {
      // The name and the current balance are context; the payment itself is
      // validated by the database, so a failed read must not block the form.
      setError(safeErrorMessage(cause, 'Could not load this customer\u2019s balance.'));
    }
  }, [client, customerId]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  if (!business)
    return (
      <Screen title="Payment" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await recordPayment(client, {
        businessId: business.id,
        customerId,
        saleId,
        direction,
        amount,
        method,
        date,
        reference,
        note,
        scale,
      });
      onDone(
        `${DIRECTION_LABELS[result.direction]} ${formatMoney(result.amount, result.currency)}. New balance ${formatMoney(result.customer_outstanding, result.currency)}.`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const customerName = account?.customer_name ?? 'this customer';
  return (
    <Screen title="Record payment" subtitle={customerName}>
      {!!error && <Notice error>{error}</Notice>}
      {account && (
        <Card>
          <SectionTitle>Before this payment</SectionTitle>
          <AmountRow
            label="Currently outstanding"
            amount={formatMoney(account.outstanding, account.currency)}
            emphasis
            tone={parseStoredAmount(account.outstanding) > 0n ? 'bad' : 'good'}
          />
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
            {parseStoredAmount(account.outstanding) > 0n
              ? 'A payment received reduces this balance.'
              : parseStoredAmount(account.outstanding) < 0n
                ? 'This customer is in advance. A refund returns money to them; a received payment reduces the advance.'
                : 'This account is settled.'}
            {account.customer_archived_at ? ' The customer is archived.' : ''}
          </Text>
        </Card>
      )}
      <Card>
        <SectionTitle>Direction</SectionTitle>
        <Choice
          label="Received from customer"
          hint="Reduces what they owe you"
          selected={direction === 'received'}
          onPress={() => setDirection('received')}
        />
        <Choice
          label="Refunded to customer"
          hint="Increases what they owe you, or returns an advance"
          selected={direction === 'refunded'}
          onPress={() => setDirection('refunded')}
        />
      </Card>
      <Card>
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
          placeholder={isoDateInTimezone(business.timezone)}
        />
        <Field
          label="Reference (optional)"
          value={reference}
          onChangeText={setReference}
          placeholder="Cheque or TID number"
        />
        <Field label="Note (optional)" value={note} onChangeText={setNote} />
      </Card>
      <Card>
        <SectionTitle>How the money moved</SectionTitle>
        {MONEY_METHODS.map((option) => (
          <Choice
            key={option}
            label={METHOD_LABELS[option]}
            selected={method === option}
            onPress={() => setMethod(option)}
          />
        ))}
      </Card>
      <Button title="Save payment" onPress={() => void submit()} busy={busy} />
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        The payment is written to the append-only khata ledger with a unique operation id, so a
        retry after a lost connection cannot record it twice.
      </Text>
    </Screen>
  );
}

export function AdjustmentFormScreen({
  client,
  customerId,
  onDone,
}: Props & { customerId: string; onDone: (message: string) => void }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const scale =
    workspace.currencies.find((item) => item.code === business?.currency)?.minor_units ?? 2;
  const currency = business?.currency ?? '';
  const [kind, setKind] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(isoDateInTimezone(business?.timezone ?? 'UTC'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!business)
    return (
      <Screen title="Note" subtitle="Select a business first">
        <Notice error>No business is selected. Choose one in Settings first.</Notice>
      </Screen>
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = amount.trim();
      const signed =
        kind === 'credit' && trimmed !== '' && !trimmed.startsWith('-') ? `-${trimmed}` : trimmed;
      const result = await recordAdjustment(client, {
        businessId: business.id,
        customerId,
        amount: signed,
        reason,
        note,
        date,
        scale,
      });
      onDone(
        `${kind === 'credit' ? 'Credit' : 'Debit'} note of ${formatMoney(result.amount, result.currency)} recorded. New balance ${formatMoney(result.customer_outstanding, result.currency)}.`,
      );
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Credit or debit note" subtitle="Correct a khata without editing history">
      {!!error && <Notice error>{error}</Notice>}
      <Card>
        <Choice
          label="Credit note"
          hint="Reduces what the customer owes: returned goods, a rounding correction, a write-off"
          selected={kind === 'credit'}
          onPress={() => setKind('credit')}
        />
        <Choice
          label="Debit note"
          hint="Increases what the customer owes: a charge that was missed"
          selected={kind === 'debit'}
          onPress={() => setKind('debit')}
        />
      </Card>
      <Card>
        <Field
          label={`Amount (${currency})`}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <Field
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Goods returned"
        />
        <Field
          label="Date (YYYY-MM-DD)"
          value={date}
          onChangeText={setDate}
          autoCapitalize="none"
        />
        <Field label="Note (optional)" value={note} onChangeText={setNote} />
      </Card>
      <Button title="Save note" onPress={() => void submit()} busy={busy} />
      <Notice>
        A note appends a dated, signed ledger entry with your reason. It never rewrites an earlier
        entry, and it is written to the audit trail with your user id.
      </Notice>
    </Screen>
  );
}
