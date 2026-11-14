export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type BusinessRole = 'owner' | 'co_owner' | 'manager' | 'accountant' | 'staff';
export type PaymentMethod = 'cash' | 'bank' | 'mobile_wallet' | 'cheque' | 'credit' | 'other';
export type PaymentDirection = 'received' | 'refunded';
export type DocumentStatus = 'posted' | 'voided';
export type LedgerEntryType =
  'opening_balance' | 'sale' | 'sale_void' | 'payment' | 'payment_void' | 'adjustment';

export type Profile = { id: string; display_name: string; created_at: string; updated_at: string };
export type Business = {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  co_owners_can_invite: boolean;
  created_by: string;
  archived_at: string | null;
  currency_locked_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Membership = {
  business_id: string;
  user_id: string;
  role: BusinessRole;
  display_name: string | null;
  invited_by: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Invitation = {
  id: string;
  role: BusinessRole;
  email: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  invited_by: string;
};
export type CreatedInvitation = { invitation_id: string; token: string; expires_at: string };
export type InvitationPreview = {
  business_id: string;
  business_name: string;
  role: BusinessRole;
  expires_at: string;
};
export type Currency = { code: string; name: string; minor_units: number };

/**
 * Every money value that crosses the API boundary is a decimal STRING.
 * The database emits `numeric::text` and the app parses it with `src/lib/decimal`,
 * so an amount is never a JavaScript double at any point.
 */
export type Amount = string;

export type Customer = {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  opening_balance: Amount;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type Product = {
  id: string;
  business_id: string;
  name: string;
  sku: string | null;
  unit: string;
  sale_price: Amount;
  cost_price: Amount;
  archived_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
export type Sale = {
  id: string;
  business_id: string;
  customer_id: string | null;
  sale_date: string;
  status: DocumentStatus;
  payment_method: PaymentMethod;
  currency: string;
  subtotal: Amount;
  discount_total: Amount;
  total: Amount;
  cogs: Amount;
  paid_amount: Amount;
  reference: string | null;
  note: string | null;
  created_by: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};
export type SaleItem = {
  id: string;
  sale_id: string;
  business_id: string;
  product_id: string | null;
  item_name: string;
  unit: string;
  position: number;
  quantity: Amount;
  unit_price: Amount;
  discount: Amount;
  unit_cost: Amount;
  line_total: Amount;
  line_cogs: Amount;
};
export type Payment = {
  id: string;
  business_id: string;
  customer_id: string;
  sale_id: string | null;
  direction: PaymentDirection;
  amount: Amount;
  payment_method: PaymentMethod;
  currency: string;
  payment_date: string;
  reference: string | null;
  note: string | null;
  status: DocumentStatus;
  created_by: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};
export type Expense = {
  id: string;
  business_id: string;
  expense_date: string;
  category: string;
  amount: Amount;
  payment_method: PaymentMethod;
  currency: string;
  reference: string | null;
  note: string | null;
  status: DocumentStatus;
  created_by: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
};
export type LedgerRow = {
  id: string;
  business_id: string;
  customer_id: string;
  entry_type: LedgerEntryType;
  amount: Amount;
  reference_type: 'customer' | 'sale' | 'payment' | 'adjustment';
  reference_id: string;
  entry_date: string;
  note: string | null;
  created_by: string;
  created_at: string;
};
export type ActivityLog = {
  id: string;
  business_id: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  amount: Amount | null;
  created_at: string;
};

/** Read-model rows: joined, paginated and with money already formatted as text. */
export type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  opening_balance: Amount;
  outstanding: Amount;
  archived_at: string | null;
  last_entry_at: string | null;
  entry_count: number;
  created_at: string;
};
export type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  sale_price: Amount;
  cost_price: Amount;
  archived_at: string | null;
  created_at: string;
};
export type SaleRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  sale_date: string;
  status: DocumentStatus;
  payment_method: PaymentMethod;
  currency: string;
  subtotal: Amount;
  discount_total: Amount;
  total: Amount;
  cogs: Amount;
  paid_amount: Amount;
  due: Amount;
  item_count: number;
  reference: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
};
export type PaymentRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  sale_id: string | null;
  direction: PaymentDirection;
  amount: Amount;
  currency: string;
  payment_method: PaymentMethod;
  payment_date: string;
  status: DocumentStatus;
  reference: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
};
export type ExpenseRow = {
  id: string;
  expense_date: string;
  category: string;
  amount: Amount;
  payment_method: PaymentMethod;
  currency: string;
  status: DocumentStatus;
  reference: string | null;
  note: string | null;
  created_at: string;
  created_by: string;
};
export type ActivityRow = {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  amount: Amount | null;
  created_at: string;
};
export type CategoryRow = { category: string; entries: number; total: Amount };
export type StatementEntry = {
  id: string;
  entry_type: LedgerEntryType;
  amount: Amount;
  entry_date: string;
  running_balance: Amount;
  reference_type: 'customer' | 'sale' | 'payment' | 'adjustment';
  reference_id: string;
  note: string | null;
  created_at: string;
  created_by: string;
};
export type StatementResult = {
  customer_id: string;
  business_id: string;
  customer_name: string;
  customer_archived_at: string | null;
  currency: string;
  scale: number;
  from: string | null;
  to: string | null;
  entry_count: number;
  truncated: boolean;
  opening_outstanding: Amount;
  closing_outstanding: Amount;
  debited_total: Amount;
  credited_total: Amount;
  entries: StatementEntry[];
};
export type CustomerBalanceResult = {
  customer_id: string;
  business_id: string;
  customer_name: string;
  customer_archived_at: string | null;
  currency: string;
  scale: number;
  outstanding: Amount;
};
export type CashMethodSummary = {
  method: PaymentMethod;
  received: Amount;
  paid: Amount;
  net: Amount;
};
export type PeriodSummaryResult = {
  business_id: string;
  currency: string;
  scale: number;
  from: string;
  to: string;
  sales_count: number;
  subtotal: Amount;
  discount_total: Amount;
  revenue: Amount;
  cogs: Amount;
  gross_profit: Amount;
  expense_count: number;
  expense_total: Amount;
  net_profit: Amount;
  counter_receipts_total: Amount;
  collections_count: number;
  collections_total: Amount;
  refunds_count: number;
  refunds_total: Amount;
  cash_received_total: Amount;
  cash_paid_total: Amount;
  cogs_coverage_percent: Amount;
};
export type BalanceSummaryResult = {
  business_id: string;
  currency: string;
  scale: number;
  currency_locked_at: string | null;
  financial_activity: boolean;
  as_of: string;
  customer_count: number;
  product_count: number;
  receivables_total: Amount;
  customers_owing_count: number;
  customer_credit_total: Amount;
  customers_in_credit_count: number;
  net_receivables: Amount;
  cash_methods: CashMethodSummary[];
  cash_received_total: Amount;
  cash_paid_total: Amount;
  cash_net_total: Amount;
};
export type CustomerResult = {
  customer_id: string;
  created: boolean;
  currency: string;
  scale: number;
  name: string;
  opening_balance: Amount;
  replayed: boolean;
};
export type ProductResult = {
  product_id: string;
  created: boolean;
  currency: string;
  scale: number;
  name: string;
  sale_price: Amount;
  cost_price: Amount;
  replayed: boolean;
};
export type SaleResult = {
  sale_id: string;
  currency: string;
  scale: number;
  sale_date: string;
  subtotal: Amount;
  discount_total: Amount;
  total: Amount;
  cogs: Amount;
  paid_amount: Amount;
  due: Amount;
  lines: number;
  customer_id: string | null;
  customer_outstanding: Amount | null;
  replayed: boolean;
};
export type SaleVoidResult = {
  sale_id: string;
  voided: boolean;
  currency: string;
  scale: number;
  total: Amount;
  customer_outstanding: Amount | null;
  replayed: boolean;
};
export type PaymentResult = {
  payment_id: string;
  customer_id: string;
  currency: string;
  scale: number;
  direction: PaymentDirection;
  amount: Amount;
  signed_amount: Amount;
  payment_method: PaymentMethod;
  payment_date: string;
  customer_outstanding: Amount;
  replayed: boolean;
};
export type PaymentVoidResult = {
  payment_id: string;
  voided: boolean;
  currency: string;
  scale: number;
  amount: Amount;
  customer_outstanding: Amount;
  replayed: boolean;
};
export type ExpenseResult = {
  expense_id: string;
  currency: string;
  scale: number;
  expense_date: string;
  category: string;
  amount: Amount;
  payment_method: PaymentMethod;
  replayed: boolean;
};
export type ExpenseVoidResult = {
  expense_id: string;
  voided: boolean;
  currency: string;
  scale: number;
  amount: Amount;
  replayed: boolean;
};
export type AdjustmentResult = {
  ledger_id: string;
  customer_id: string;
  currency: string;
  scale: number;
  amount: Amount;
  entry_date: string;
  customer_outstanding: Amount;
  replayed: boolean;
};
/** One line of a sale as submitted; the server computes and stores every total. */
export type SaleItemDraft = {
  product_id?: string | null;
  item_name?: string;
  unit?: string;
  quantity: string;
  unit_price: string;
  discount?: string;
  unit_cost?: string;
};

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};
/** Financial tables are read-only for clients: every write goes through an RPC. */
type ReadOnlyTable<Row> = Table<Row, never, never>;
export type Database = {
  public: {
    Tables: {
      profiles: Table<Profile, { id: string; display_name: string }, { display_name: string }>;
      businesses: Table<
        Business,
        Omit<
          Business,
          'id' | 'created_at' | 'updated_at' | 'archived_at' | 'currency_locked_at'
        > & {
          id?: string;
          archived_at?: string | null;
          currency_locked_at?: string | null;
        }
      >;
      business_members: Table<
        Membership,
        Omit<Membership, 'created_at' | 'updated_at'> & { removed_at?: string | null }
      >;
      invitations: Table<
        Invitation & { business_id: string; token_hash: string; accepted_by: string | null },
        never
      >;
      audit_logs: Table<
        {
          id: string;
          business_id: string;
          actor_id: string;
          action: string;
          entity_type: string;
          entity_id: string;
          details: Json;
          created_at: string;
        },
        never
      >;
      currencies: Table<Currency, never>;
      customers: ReadOnlyTable<Customer>;
      products: ReadOnlyTable<Product>;
      sales: ReadOnlyTable<Sale>;
      sale_items: ReadOnlyTable<SaleItem>;
      payments: ReadOnlyTable<Payment>;
      expenses: ReadOnlyTable<Expense>;
      customer_ledger: ReadOnlyTable<LedgerRow>;
      activity_logs: ReadOnlyTable<ActivityLog>;
      operation_receipts: ReadOnlyTable<never>;
    };
    Views: Record<string, never>;
    Functions: {
      ownerbook_health: {
        Args: Record<string, never>;
        Returns: { service: string; schema_version: number; database_time: string };
      };
      create_business: {
        Args: { p_name: string; p_currency: string; p_timezone: string };
        Returns: string;
      };
      update_business_settings: {
        Args: {
          p_business_id: string;
          p_name: string;
          p_currency: string;
          p_timezone: string;
          p_co_owners_can_invite: boolean;
        };
        Returns: undefined;
      };
      archive_business: {
        Args: { p_business_id: string; p_archived: boolean };
        Returns: undefined;
      };
      set_member_role: {
        Args: { p_business_id: string; p_user_id: string; p_role: BusinessRole };
        Returns: undefined;
      };
      remove_member: { Args: { p_business_id: string; p_user_id: string }; Returns: undefined };
      leave_business: { Args: { p_business_id: string }; Returns: undefined };
      set_member_display_name: {
        Args: { p_business_id: string; p_name: string | null };
        Returns: undefined;
      };
      create_invitation: {
        Args: {
          p_business_id: string;
          p_role: BusinessRole;
          p_email: string | null;
          p_expires_hours: number;
        };
        Returns: CreatedInvitation;
      };
      list_invitations: { Args: { p_business_id: string }; Returns: Invitation[] };
      revoke_invitation: { Args: { p_invitation_id: string }; Returns: undefined };
      preview_invitation: { Args: { p_token: string }; Returns: InvitationPreview };
      accept_invitation: { Args: { p_token: string }; Returns: string };
      list_customers: {
        Args: {
          p_business_id: string;
          p_search?: string | null;
          p_include_archived?: boolean;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: CustomerRow[];
      };
      list_products: {
        Args: {
          p_business_id: string;
          p_search?: string | null;
          p_include_archived?: boolean;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: ProductRow[];
      };
      list_sales: {
        Args: {
          p_business_id: string;
          p_customer_id?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_status?: DocumentStatus | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: SaleRow[];
      };
      list_payments: {
        Args: {
          p_business_id: string;
          p_customer_id?: string | null;
          p_from?: string | null;
          p_to?: string | null;
          p_status?: DocumentStatus | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: PaymentRow[];
      };
      list_expenses: {
        Args: {
          p_business_id: string;
          p_from?: string | null;
          p_to?: string | null;
          p_category?: string | null;
          p_status?: DocumentStatus | null;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: ExpenseRow[];
      };
      expense_categories: { Args: { p_business_id: string }; Returns: CategoryRow[] };
      list_activity: {
        Args: { p_business_id: string; p_limit?: number; p_before?: string | null };
        Returns: ActivityRow[];
      };
      customer_statement: {
        Args: {
          p_customer_id: string;
          p_from?: string | null;
          p_to?: string | null;
          p_limit?: number;
        };
        Returns: StatementResult;
      };
      customer_balance: { Args: { p_customer_id: string }; Returns: CustomerBalanceResult };
      period_summary: {
        Args: { p_business_id: string; p_from: string; p_to: string };
        Returns: PeriodSummaryResult;
      };
      balance_summary: { Args: { p_business_id: string }; Returns: BalanceSummaryResult };
      save_customer: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_customer_id: string | null;
          p_name: string;
          p_phone?: string | null;
          p_email?: string | null;
          p_address?: string | null;
          p_opening_balance?: string | null;
        };
        Returns: CustomerResult;
      };
      archive_customer: {
        Args: { p_customer_id: string; p_archived: boolean };
        Returns: undefined;
      };
      save_product: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_product_id: string | null;
          p_name: string;
          p_sku?: string | null;
          p_unit?: string | null;
          p_sale_price?: string | null;
          p_cost_price?: string | null;
        };
        Returns: ProductResult;
      };
      create_sale: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_customer_id: string | null;
          p_sale_date: string;
          p_payment_method: PaymentMethod;
          p_paid_amount: string;
          p_items: SaleItemDraft[];
          p_reference?: string | null;
          p_note?: string | null;
        };
        Returns: SaleResult;
      };
      void_sale: {
        Args: { p_operation_id: string; p_sale_id: string; p_reason: string };
        Returns: SaleVoidResult;
      };
      record_payment: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_customer_id: string;
          p_sale_id: string | null;
          p_direction: PaymentDirection;
          p_amount: string;
          p_payment_method: PaymentMethod;
          p_payment_date: string;
          p_reference?: string | null;
          p_note?: string | null;
        };
        Returns: PaymentResult;
      };
      void_payment: {
        Args: { p_operation_id: string; p_payment_id: string; p_reason: string };
        Returns: PaymentVoidResult;
      };
      create_expense: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_expense_date: string;
          p_category: string;
          p_amount: string;
          p_payment_method: PaymentMethod;
          p_reference?: string | null;
          p_note?: string | null;
        };
        Returns: ExpenseResult;
      };
      void_expense: {
        Args: { p_operation_id: string; p_expense_id: string; p_reason: string };
        Returns: ExpenseVoidResult;
      };
      record_customer_adjustment: {
        Args: {
          p_operation_id: string;
          p_business_id: string;
          p_customer_id: string;
          p_amount: string;
          p_reason: string;
          p_entry_date?: string | null;
          p_note?: string | null;
        };
        Returns: AdjustmentResult;
      };
    };
    Enums: {
      business_role: BusinessRole;
      payment_method: PaymentMethod;
      payment_direction: PaymentDirection;
      document_status: DocumentStatus;
      ledger_entry: LedgerEntryType;
    };
    CompositeTypes: Record<string, never>;
  };
};
