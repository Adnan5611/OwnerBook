import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { OwnerBookClient } from '../lib/supabase';
import { useWorkspace } from '../providers/workspace-provider';
import {
  AmountRow,
  Button,
  Card,
  EmptyState,
  KeyValue,
  Loading,
  Money,
  Notice,
  Screen,
  SectionTitle,
  colors,
} from '../components/ui';
import { OfflineBanner } from '../components/OfflineBanner';
import { balanceSummary, listActivity, periodSummary } from '../lib/summary-service';
import { capabilitiesFor } from '../lib/permissions';
import { safeErrorMessage } from '../lib/errors';
import { formatMoney, parseStoredAmount } from '../lib/decimal';
import {
  currentMonthRange,
  formatActivityTimestamp,
  formatDayLabel,
  isoDateInTimezone,
} from '../lib/business-time';
import { ACTIVITY_LABELS, ROLE_LABELS } from '../lib/validation';
import type { ActivityRow, BalanceSummaryResult, PeriodSummaryResult } from '../types/database';

export type HomeActions = {
  onNewSale: () => void;
  onCatalog: () => void;
  onKhata: () => void;
  onMembers: () => void;
  onBusinesses: () => void;
  onJoinBusiness: () => void;
  onOpenSale: (saleId: string) => void;
};

/**
 * The dashboard shows only figures the database calculated for this business.
 * There is no placeholder number, no sample chart and no estimate: when a role
 * is not allowed to read a summary, the card says so instead of showing zeros.
 */
export function HomeScreen({ client, actions }: { client: OwnerBookClient; actions: HomeActions }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const timezone = business?.timezone ?? 'UTC';
  const currency = business?.currency ?? '';
  const capabilities = capabilitiesFor(workspace.active?.membership.role);
  const range = useMemo(() => currentMonthRange(timezone), [timezone]);
  const [balance, setBalance] = useState<BalanceSummaryResult | null>(null);
  const [period, setPeriod] = useState<PeriodSummaryResult | null>(null);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      const financial = capabilities.canReadFinancialSummary;
      const [activityRows, position, result] = await Promise.all([
        listActivity(client, business.id, 12),
        financial ? balanceSummary(client, business.id) : Promise.resolve(null),
        financial
          ? periodSummary(client, business.id, range.from, range.to)
          : Promise.resolve(null),
      ]);
      setActivity(activityRows);
      setBalance(position);
      setPeriod(result);
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load your dashboard. Nothing was changed.'));
    } finally {
      setLoading(false);
    }
  }, [business, capabilities.canReadFinancialSummary, client, range.from, range.to]);
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
  const role = workspace.active ? workspace.active.membership.role : null;
  const today = isoDateInTimezone(timezone);
  return (
    <Screen
      title={business?.name ?? 'Your business'}
      subtitle={`${role ? ROLE_LABELS[role] : 'No role'} · ${formatDayLabel(today)} in ${timezone}`}
    >
      <OfflineBanner />
      {!!workspace.error && <Notice error>{workspace.error}</Notice>}
      {!!error && <Notice error>{error}</Notice>}
      {business?.archived_at && (
        <Notice>
          This business is archived. Every record stays readable and reports still work; new sales,
          payments and expenses are blocked until it is restored.
        </Notice>
      )}
      {!capabilities.canReadFinancialSummary && (
        <Notice>
          Your role cannot read financial summaries, expenses or the audit trail. PostgreSQL refuses
          those calls, so this screen does not guess figures for you. You can still add customers,
          record sales and take payments.
        </Notice>
      )}
      {loading && !balance && !period ? <Loading label="Loading your position…" /> : null}
      {balance && (
        <Card>
          <SectionTitle>Money owed to you</SectionTitle>
          <Money
            amount={formatMoney(balance.receivables_total, currency)}
            size="large"
            tone={parseStoredAmount(balance.receivables_total) > 0n ? 'bad' : 'good'}
          />
          <Text style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
            {balance.customers_owing_count} customer{balance.customers_owing_count === 1 ? '' : 's'}{' '}
            still owe you. You hold {formatMoney(balance.customer_credit_total, currency)} as
            advances from {balance.customers_in_credit_count} customer
            {balance.customers_in_credit_count === 1 ? '' : 's'}.
          </Text>
          <AmountRow
            label="Net receivables"
            amount={formatMoney(balance.net_receivables, currency)}
            emphasis
          />
          <AmountRow label="Customers" amount={String(balance.customer_count)} />
          <AmountRow label="Catalog items" amount={String(balance.product_count)} />
          {balance.financial_activity ? null : (
            <Text style={{ color: colors.muted, fontSize: 12 }}>
              No financial records yet, so every figure below is a real zero rather than a sample.
            </Text>
          )}
        </Card>
      )}
      {balance && (
        <Card>
          <SectionTitle>Cash and bank</SectionTitle>
          {balance.cash_methods.map((entry) => (
            <AmountRow
              key={entry.method}
              label={entry.method.replace('_', ' ')}
              amount={formatMoney(entry.net, currency)}
              tone={parseStoredAmount(entry.net) < 0n ? 'bad' : undefined}
            />
          ))}
          <AmountRow
            label="Total received"
            amount={formatMoney(balance.cash_received_total, currency)}
          />
          <AmountRow
            label="Total paid out"
            amount={formatMoney(balance.cash_paid_total, currency)}
          />
          <AmountRow
            label="Cash on hand"
            amount={formatMoney(balance.cash_net_total, currency)}
            emphasis
            tone={parseStoredAmount(balance.cash_net_total) < 0n ? 'bad' : 'good'}
          />
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
            Cash is counter receipts plus khata payments received, minus refunds and expenses. It is
            reported separately from profit: a credit sale is revenue today but cash only when the
            customer pays.
            {balance.currency_locked_at
              ? ' The currency is locked because financial records exist.'
              : ''}
          </Text>
        </Card>
      )}
      {period && (
        <Card>
          <SectionTitle>
            This month · {formatDayLabel(period.from)} to {formatDayLabel(period.to)}
          </SectionTitle>
          <AmountRow
            label={`Sales (${period.sales_count})`}
            amount={formatMoney(period.revenue, currency)}
          />
          <AmountRow
            label="Discounts given"
            amount={formatMoney(period.discount_total, currency)}
          />
          <AmountRow label="Cost of goods sold" amount={formatMoney(period.cogs, currency)} />
          <AmountRow
            label="Gross profit"
            amount={formatMoney(period.gross_profit, currency)}
            emphasis
          />
          <AmountRow
            label={`Expenses (${period.expense_count})`}
            amount={formatMoney(period.expense_total, currency)}
          />
          <AmountRow
            label="Net profit"
            amount={formatMoney(period.net_profit, currency)}
            emphasis
            tone={parseStoredAmount(period.net_profit) < 0n ? 'bad' : 'good'}
          />
          <AmountRow
            label={`Collected from customers (${period.collections_count})`}
            amount={formatMoney(period.collections_total, currency)}
          />
          <AmountRow
            label={`Refunded (${period.refunds_count})`}
            amount={formatMoney(period.refunds_total, currency)}
          />
          <AmountRow
            label="Cash in this month"
            amount={formatMoney(period.cash_received_total, currency)}
          />
          <AmountRow
            label="Cash out this month"
            amount={formatMoney(period.cash_paid_total, currency)}
          />
          <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
            Net profit = revenue − cost of goods sold − expenses. {period.cogs_coverage_percent}% of
            this month&apos;s revenue has a recorded cost; sales without a cost understate cost of
            goods sold, so treat gross profit as a floor until every item carries a cost.
          </Text>
        </Card>
      )}
      <Card>
        <SectionTitle>Quick actions</SectionTitle>
        {capabilities.canRecordSales && !business?.archived_at && (
          <Button title="Record a sale" onPress={actions.onNewSale} />
        )}
        <Button title="Open the khata" secondary onPress={actions.onKhata} />
        {capabilities.canManageCatalog && (
          <Button title="Items and prices" secondary onPress={actions.onCatalog} />
        )}
        <Button title="Manage your team" secondary onPress={actions.onMembers} />
        <Button title="Switch business" secondary onPress={actions.onBusinesses} />
        <Button title="Join a business" secondary onPress={actions.onJoinBusiness} />
        <KeyValue label="Currency" value={currency || '—'} />
        <KeyValue label="Timezone" value={timezone} />
      </Card>
      <Card>
        <SectionTitle>Recent activity</SectionTitle>
        {activity.length === 0 && !loading ? (
          <EmptyState
            title="Nothing recorded yet"
            message="Every sale, payment, expense, note and catalog change is written here automatically, linked to the record it came from."
          />
        ) : null}
        {activity.map((entry) => (
          <View key={entry.id} style={{ paddingVertical: 9, gap: 3 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: colors.ink, fontWeight: '600', flexShrink: 1 }}>
                {ACTIVITY_LABELS[entry.action] ?? entry.action}
              </Text>
              {entry.amount ? (
                <Text style={{ color: colors.ink, fontWeight: '700' }}>
                  {formatMoney(entry.amount, currency)}
                </Text>
              ) : null}
            </View>
            <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 17 }}>
              {entry.summary}
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ color: colors.muted, fontSize: 11 }}>
                {entry.actor_name} · {formatActivityTimestamp(entry.created_at, timezone)}
              </Text>
              {entry.entity_type === 'sale' ? (
                <Text
                  accessibilityRole="button"
                  onPress={() => actions.onOpenSale(entry.entity_id)}
                  style={{ color: colors.green, fontSize: 11, fontWeight: '700' }}
                >
                  Open the sale
                </Text>
              ) : (
                <Text style={{ color: colors.muted, fontSize: 11 }}>{entry.entity_type}</Text>
              )}
            </View>
          </View>
        ))}
      </Card>
      <Button title="Refresh dashboard" secondary busy={loading} onPress={() => void refresh()} />
      <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
        Figures are calculated by PostgreSQL from posted, non-voided records at the moment you
        refresh. The activity feed is append-only: it cannot be edited or deleted, and the separate
        audit log records who changed membership and settings.
      </Text>
    </Screen>
  );
}
