-- OwnerBook Phase 3: customers, khata ledger, sales, payments and expenses.
-- Apply after the identity/business migration. No demo records are inserted.
--
-- MONEY RULES (enforced here, not in the app):
--   * Every amount is PostgreSQL numeric — never float/double/real.
--   * Every amount RPC parameter is TEXT and is parsed by private.parse_decimal(),
--     which accepts only a plain signed decimal literal. Scientific notation,
--     NaN, hex and exponent forms are rejected, so an IEEE-754 double produced by
--     a buggy client can never enter the money path.
--   * Every amount returned to a client is cast to TEXT (numeric -> text is exact),
--     so JavaScript never has to JSON.parse money into a double.
--   * Stored amounts are rounded half away from zero to the minor units of the
--     business currency (private.round_money), so JPY keeps 0, PKR/USD keep 2 and
--     KWD keeps 3 decimals.
--
-- ACCOUNTING METHOD (documented as required by the specification):
--   customer outstanding = sum(customer_ledger.amount) for that customer
--     positive  = the customer owes the business (debit to the customer account)
--     negative  = the business owes the customer (advance/credit)
--   The ledger is append-only. Corrections are posted as reversing entries
--   ('sale_void', 'payment_void') or as signed adjustments; rows are never
--   updated or deleted, so a khata statement always reconciles with its documents:
--     outstanding = opening_balance
--                 + sum(total of posted sales)
--                 - sum(paid_amount of posted sales)
--                 - sum(received payments posted)
--                 + sum(refunded payments posted)
--                 + sum(signed adjustments)
--   revenue   = sum(total of posted sales in the period), net of line discounts
--   cogs      = sum(cogs of posted sales in the period), from per-line unit_cost
--   expenses  = sum(amount of posted expenses in the period)
--   net profit = revenue - cogs - expenses
--   Cash is tracked separately from profit and is derived from documents, so no
--   money is counted twice: counter receipts live on sales.paid_amount and are
--   never duplicated into public.payments (which holds later collections and
--   refunds). Cash net = counter receipts + received payments - refunded payments
--   - posted expenses, grouped by payment method.
--   Financial documents are never deleted; they are voided. Voided documents are
--   excluded from every derived total and post reversing ledger entries.
begin;

create type public.payment_method as enum
  ('cash', 'bank', 'mobile_wallet', 'cheque', 'credit', 'other');
create type public.payment_direction as enum ('received', 'refunded');
create type public.document_status as enum ('posted', 'voided');
create type public.ledger_entry as enum
  ('opening_balance', 'sale', 'sale_void', 'payment', 'payment_void', 'adjustment');

-- Currency becomes immutable as soon as the business holds financial history.
alter table public.businesses add column if not exists currency_locked_at timestamptz;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  phone text check (phone is null or phone ~ '^\+?[0-9][0-9 \-()]{2,31}$'),
  email text check (email is null or (char_length(email) <= 254 and email = lower(email)
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  address text check (address is null or char_length(address) <= 240),
  -- Positive: the customer already owed the business when the khata was opened.
  opening_balance numeric(18,4) not null default 0 check (abs(opening_balance) < 100000000000000),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index customers_business_phone_key on public.customers(business_id, phone)
  where phone is not null;
create index customers_business_name_idx on public.customers(business_id, name);

-- Phase 3 catalog only: name, unit and price/cost defaults. Stock levels,
-- suppliers and stock movements are Phase 4 and will not change these columns.
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  sku text check (sku is null or (char_length(sku) between 1 and 40 and sku = btrim(sku))),
  unit text not null default 'pcs' check (char_length(unit) between 1 and 24),
  sale_price numeric(18,4) not null default 0 check (sale_price >= 0 and sale_price < 100000000000000),
  cost_price numeric(18,4) not null default 0 check (cost_price >= 0 and cost_price < 100000000000000),
  archived_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_business_sku_key on public.products(business_id, sku)
  where sku is not null;
create index products_business_name_idx on public.products(business_id, name);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  -- Null means a counter/cash sale with no khata account; such a sale must be
  -- settled immediately (paid_amount = total).
  customer_id uuid references public.customers(id) on delete restrict,
  sale_date date not null check (sale_date between date '2000-01-01' and date '2999-12-31'),
  status public.document_status not null default 'posted',
  payment_method public.payment_method not null default 'cash',
  -- Snapshot of the business currency at posting time; never restated.
  currency text not null references public.currencies(code),
  subtotal numeric(18,4) not null check (subtotal >= 0),
  discount_total numeric(18,4) not null default 0 check (discount_total >= 0),
  total numeric(18,4) not null check (total > 0),
  cogs numeric(18,4) not null default 0 check (cogs >= 0),
  paid_amount numeric(18,4) not null default 0 check (paid_amount >= 0 and paid_amount <= total),
  reference text check (reference is null or char_length(reference) <= 60),
  note text check (note is null or char_length(note) <= 500),
  created_by uuid not null references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete restrict,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (total = subtotal - discount_total),
  check (discount_total <= subtotal),
  check ((status = 'voided') = (voided_at is not null)),
  check ((payment_method = 'credit') = (paid_amount = 0)),
  check (customer_id is not null or paid_amount = total)
);
create index sales_business_date_idx on public.sales(business_id, sale_date desc, created_at desc);
create index sales_customer_idx on public.sales(customer_id, sale_date desc) where customer_id is not null;

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete restrict,
  product_id uuid references public.products(id) on delete restrict,
  -- Snapshot of the product name/unit at posting time; catalog edits and price
  -- changes never rewrite history.
  item_name text not null check (char_length(item_name) between 1 and 120),
  unit text not null default 'pcs' check (char_length(unit) between 1 and 24),
  position integer not null check (position between 0 and 999),
  quantity numeric(18,3) not null check (quantity > 0 and quantity < 1000000000),
  unit_price numeric(18,4) not null check (unit_price >= 0 and unit_price < 100000000000000),
  discount numeric(18,4) not null default 0 check (discount >= 0),
  -- Cost recorded for this line. Phase 3 stores the cost the user enters (or the
  -- product's default cost); Phase 4 replaces manual entry with the perpetual
  -- weighted-average cost taken from stock movements.
  unit_cost numeric(18,4) not null default 0 check (unit_cost >= 0 and unit_cost < 100000000000000),
  line_total numeric(18,4) not null check (line_total >= 0),
  line_cogs numeric(18,4) not null default 0 check (line_cogs >= 0),
  unique (sale_id, position)
);
create index sale_items_sale_idx on public.sale_items(sale_id, position);
create index sale_items_business_idx on public.sale_items(business_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  -- Optional context only: the khata balance is per customer, never per invoice.
  sale_id uuid references public.sales(id) on delete restrict,
  direction public.payment_direction not null default 'received',
  amount numeric(18,4) not null check (amount > 0 and amount < 100000000000000),
  -- Money always moves on a payment row, so 'credit' is not a valid method here.
  payment_method public.payment_method not null default 'cash' check (payment_method <> 'credit'),
  currency text not null references public.currencies(code),
  payment_date date not null check (payment_date between date '2000-01-01' and date '2999-12-31'),
  reference text check (reference is null or char_length(reference) <= 60),
  note text check (note is null or char_length(note) <= 500),
  status public.document_status not null default 'posted',
  created_by uuid not null references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete restrict,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'voided') = (voided_at is not null))
);
create index payments_business_date_idx on public.payments(business_id, payment_date desc, created_at desc);
create index payments_customer_idx on public.payments(customer_id, payment_date desc);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  expense_date date not null check (expense_date between date '2000-01-01' and date '2999-12-31'),
  category text not null check (char_length(category) between 1 and 60),
  amount numeric(18,4) not null check (amount > 0 and amount < 100000000000000),
  -- Phase 3 expenses are settled when posted. Credit purchases from suppliers and
  -- their part payments are Phase 4 (supplier_ledger), not a status on this table.
  payment_method public.payment_method not null default 'cash' check (payment_method <> 'credit'),
  currency text not null references public.currencies(code),
  reference text check (reference is null or char_length(reference) <= 60),
  note text check (note is null or char_length(note) <= 500),
  status public.document_status not null default 'posted',
  created_by uuid not null references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete restrict,
  void_reason text check (void_reason is null or char_length(btrim(void_reason)) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'voided') = (voided_at is not null))
);
create index expenses_business_date_idx on public.expenses(business_id, expense_date desc, created_at desc);
create index expenses_business_category_idx on public.expenses(business_id, category);

-- Append-only khata. This table, not a stored counter, is the source of truth for
-- customer outstanding, so concurrent postings cannot lose an update.
create table public.customer_ledger (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  entry_type public.ledger_entry not null,
  -- Signed: positive increases what the customer owes, negative decreases it.
  amount numeric(18,4) not null check (amount <> 0 and abs(amount) < 100000000000000),
  reference_type text not null check (reference_type in ('customer', 'sale', 'payment', 'adjustment')),
  reference_id uuid not null,
  entry_date date not null check (entry_date between date '2000-01-01' and date '2999-12-31'),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index customer_ledger_statement_idx
  on public.customer_ledger(customer_id, entry_date desc, created_at desc, id desc);
create index customer_ledger_business_idx
  on public.customer_ledger(business_id, entry_date desc, created_at desc);
-- A document can never post the same effect twice, even if the idempotency
-- receipt layer were bypassed or replayed incorrectly.
create unique index customer_ledger_source_key
  on public.customer_ledger(customer_id, entry_type, reference_id);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 60),
  entity_id uuid not null,
  -- Human-readable, tenant-scoped, and never contains money text: the client
  -- formats `amount` with the business currency so no locale lives in SQL.
  summary text not null check (char_length(btrim(summary)) between 1 and 240),
  amount numeric(18,4) check (amount is null or abs(amount) < 100000000000000),
  created_at timestamptz not null default now()
);
create index activity_logs_business_idx on public.activity_logs(business_id, created_at desc, id desc);

-- Idempotency receipts. A retried operation id returns the stored result instead
-- of writing a second financial document, which is what makes offline replay and
-- flaky networks safe for money. Clients cannot read this table.
create table public.operation_receipts (
  business_id uuid not null references public.businesses(id) on delete restrict,
  operation_id uuid not null,
  operation_type text not null check (char_length(operation_type) between 1 and 60),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (business_id, operation_id)
);
create index operation_receipts_created_idx on public.operation_receipts(business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Private helpers. DEFINER helpers exist only where RLS would otherwise recurse;
-- they pin an empty search path and are never granted to anon or public.
-- ---------------------------------------------------------------------------

-- Zero-argument STABLE helper: the planner folds it to a constant per query, so
-- RLS on high-volume tables costs one membership lookup instead of one per row.
create function private.active_business_ids()
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(business_id), '{}'::uuid[])
  from public.business_members where user_id = auth.uid() and removed_at is null;
$$;
create function private.role_business_ids(p_roles public.business_role[])
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(business_id), '{}'::uuid[])
  from public.business_members
  where user_id = auth.uid() and removed_at is null and role = any (p_roles);
$$;
revoke all on function private.active_business_ids() from public, anon;
revoke all on function private.role_business_ids(public.business_role[]) from public, anon;
grant execute on function private.active_business_ids() to authenticated;
grant execute on function private.role_business_ids(public.business_role[]) to authenticated;

create function private.parse_decimal(p_value text, p_label text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v_text text := btrim(coalesce(p_value, ''));
begin
  if v_text = '' then return null; end if;
  -- Plain signed decimal only. Rejects '1e3', 'NaN', 'Infinity', '0x10', ' 5 ',
  -- thousands separators and any other representation a double might produce.
  if v_text !~ '^-?[0-9]{1,13}(\.[0-9]{1,18})?$' then
    raise exception '% must be a plain decimal number', p_label using errcode = '22023';
  end if;
  return v_text::numeric;
end;
$$;
create function private.require_decimal(p_value text, p_label text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare v_value numeric := private.parse_decimal(p_value, p_label);
begin
  if v_value is null then
    raise exception '% is required', p_label using errcode = '22023';
  end if;
  return v_value;
end;
$$;
create function private.round_money(p_value numeric, p_scale integer)
returns numeric language sql immutable set search_path = '' as $$
  -- PostgreSQL rounds numeric half away from zero: deterministic and symmetric.
  -- abs() normalises a rounded negative zero so the app never renders "-0.00".
  select abs(round(p_value, p_scale)) * case when round(p_value, p_scale) < 0 then -1 else 1 end;
$$;
revoke all on function private.parse_decimal(text, text) from public, anon;
revoke all on function private.require_decimal(text, text) from public, anon;
revoke all on function private.round_money(numeric, integer) from public, anon;
-- round_money is a pure function and is called by SECURITY INVOKER read models,
-- so authenticated needs execute on it. parse_decimal/require_decimal stay private
-- to the definer write path.
grant execute on function private.round_money(numeric, integer) to authenticated;

-- Serialisation point for financial writes. One business row lock per write keeps
-- the currency lock and idempotency receipts race-free; the ledger itself stores
-- no counters, so nothing depends on this lock for arithmetic correctness.
create function private.lock_business(p_business_id uuid)
returns public.businesses language plpgsql security definer set search_path = '' as $$
declare v_business public.businesses;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select * into v_business from public.businesses where id = p_business_id for update;
  if not found then raise exception 'Business not found' using errcode = '42501'; end if;
  if not private.is_member(p_business_id) then raise exception 'Membership required' using errcode = '42501'; end if;
  if v_business.archived_at is not null then
    raise exception 'This business is archived; new records are disabled' using errcode = '42501';
  end if;
  return v_business;
end;
$$;
create function private.require_roles(p_business_id uuid, p_roles public.business_role[], p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_business_id, p_roles) then
    raise exception '%', p_message using errcode = '42501';
  end if;
end;
$$;
create function private.money_scale(p_currency text)
returns integer language sql stable security definer set search_path = '' as $$
  select minor_units from public.currencies where code = p_currency;
$$;
-- Records that the business now holds financial history, which permanently locks
-- its currency. Idempotent and safe under the business row lock.
create function private.lock_currency(p_business_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.businesses set currency_locked_at = now()
  where id = p_business_id and currency_locked_at is null;
$$;
create function private.has_financial_activity(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sales where business_id = p_business_id)
    or exists (select 1 from public.payments where business_id = p_business_id)
    or exists (select 1 from public.expenses where business_id = p_business_id)
    or exists (select 1 from public.customer_ledger where business_id = p_business_id);
$$;
revoke all on function private.lock_business(uuid) from public, anon, authenticated;
revoke all on function private.lock_currency(uuid) from public, anon, authenticated;
revoke all on function private.has_financial_activity(uuid) from public, anon, authenticated;
-- require_roles and money_scale only ever read the caller's own membership and the
-- public currency catalog, and SECURITY INVOKER read models call them, so RLS is
-- still applied around them. They are therefore executable by authenticated.
revoke all on function private.require_roles(uuid, public.business_role[], text) from public, anon;
revoke all on function private.money_scale(text) from public, anon;
grant execute on function private.require_roles(uuid, public.business_role[], text) to authenticated;
grant execute on function private.money_scale(text) to authenticated;

create function private.begin_operation(p_business_id uuid, p_operation_id uuid, p_operation_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_actor uuid; v_type text; v_rows integer;
begin
  if p_operation_id is null then
    raise exception 'An operation id is required to protect against duplicate posting'
      using errcode = '22023';
  end if;
  select actor_id, operation_type, result into v_actor, v_type, v_result
  from public.operation_receipts
  where business_id = p_business_id and operation_id = p_operation_id;
  if found then
    if v_actor is distinct from auth.uid() then
      raise exception 'This operation id belongs to another session' using errcode = '42501';
    end if;
    if v_type <> p_operation_type then
      raise exception 'This operation id was already used for a different action' using errcode = '22023';
    end if;
    return v_result;
  end if;
  insert into public.operation_receipts(business_id, operation_id, operation_type, actor_id, result)
  values (p_business_id, p_operation_id, p_operation_type, auth.uid(), '{"pending": true}'::jsonb)
  on conflict (business_id, operation_id) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- A committed writer won the reservation; replay its stored result.
    select result into v_result from public.operation_receipts
    where business_id = p_business_id and operation_id = p_operation_id;
    return v_result;
  end if;
  return null;
end;
$$;
create function private.finish_operation(p_business_id uuid, p_operation_id uuid, p_result jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.operation_receipts set result = p_result
  where business_id = p_business_id and operation_id = p_operation_id and actor_id = auth.uid();
  if not found then
    raise exception 'Operation receipt is missing' using errcode = '42501';
  end if;
end;
$$;
revoke all on function private.begin_operation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.finish_operation(uuid, uuid, jsonb) from public, anon, authenticated;

create function private.add_activity(p_business_id uuid, p_action text, p_entity_type text,
  p_entity_id uuid, p_summary text, p_amount numeric)
returns void language sql security definer set search_path = '' as $$
  insert into public.activity_logs(business_id, actor_id, action, entity_type, entity_id, summary, amount)
  values (p_business_id, auth.uid(), p_action, p_entity_type, p_entity_id, left(btrim(p_summary), 240), p_amount);
$$;
revoke all on function private.add_activity(uuid, text, text, uuid, text, numeric) from public, anon, authenticated;

create function private.prevent_row_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'This record is immutable; post a reversing entry instead' using errcode = '42501';
end;
$$;
create function private.prevent_row_deletion()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'This record cannot be deleted; archive or void it instead' using errcode = '42501';
end;
$$;
revoke all on function private.prevent_row_mutation() from public, anon, authenticated;
revoke all on function private.prevent_row_deletion() from public, anon, authenticated;

create trigger customer_ledger_immutable before update or delete on public.customer_ledger
for each row execute function private.prevent_row_mutation();
create trigger activity_logs_immutable before update or delete on public.activity_logs
for each row execute function private.prevent_row_mutation();
create trigger sale_items_immutable before update or delete on public.sale_items
for each row execute function private.prevent_row_mutation();
-- A receipt's result is finalised once by private.finish_operation() in the same
-- transaction, but a receipt can never be removed: it is the duplicate-write proof.
create trigger operation_receipts_no_delete before delete on public.operation_receipts
for each row execute function private.prevent_row_deletion();
create trigger sales_no_delete before delete on public.sales
for each row execute function private.prevent_row_deletion();
create trigger payments_no_delete before delete on public.payments
for each row execute function private.prevent_row_deletion();
create trigger expenses_no_delete before delete on public.expenses
for each row execute function private.prevent_row_deletion();
create trigger customers_no_delete before delete on public.customers
for each row execute function private.prevent_row_deletion();
create trigger products_no_delete before delete on public.products
for each row execute function private.prevent_row_deletion();

create trigger customers_touch before update on public.customers for each row execute function private.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function private.touch_updated_at();
create trigger sales_touch before update on public.sales for each row execute function private.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function private.touch_updated_at();
create trigger expenses_touch before update on public.expenses for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security. Clients may READ their own tenant's records and may never
-- write financial tables directly: every mutation goes through an RPC that
-- re-checks membership, role, tenant and business state.
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.payments enable row level security;
alter table public.expenses enable row level security;
alter table public.customer_ledger enable row level security;
alter table public.activity_logs enable row level security;
alter table public.operation_receipts enable row level security;

create policy customers_read on public.customers for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy products_read on public.products for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy sales_read on public.sales for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy sale_items_read on public.sale_items for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy payments_read on public.payments for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy customer_ledger_read on public.customer_ledger for select to authenticated
  using (business_id = any (private.active_business_ids()));
create policy activity_logs_read on public.activity_logs for select to authenticated
  using (business_id = any (private.active_business_ids()));
-- Expenses are the profit side of the books: staff cannot read them.
create policy expenses_read on public.expenses for select to authenticated
  using (business_id = any (private.role_business_ids(
    array['owner','co_owner','manager','accountant']::public.business_role[])));
-- operation_receipts intentionally has RLS enabled and NO policy: no client role
-- can read idempotency receipts or the results they contain.

revoke all on public.customers, public.products, public.sales, public.sale_items,
  public.payments, public.expenses, public.customer_ledger, public.activity_logs,
  public.operation_receipts from anon, authenticated;
grant select on public.customers, public.products, public.sales, public.sale_items,
  public.payments, public.customer_ledger, public.activity_logs to authenticated;
grant select on public.expenses to authenticated;

-- ---------------------------------------------------------------------------
-- Read models. SECURITY INVOKER on purpose: RLS is applied a second time inside
-- these functions, so a missing membership check could still not leak a tenant.
-- All money leaves as TEXT.
-- ---------------------------------------------------------------------------
create function public.list_customers(p_business_id uuid, p_search text default null,
  p_include_archived boolean default false, p_limit integer default 50, p_offset integer default 0)
returns table(id uuid, name text, phone text, email text, address text,
  opening_balance text, outstanding text, archived_at timestamptz,
  last_entry_at timestamptz, entry_count bigint, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not private.is_member(p_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
    select c.id, c.name, c.phone, c.email, c.address,
      private.round_money(c.opening_balance, cur.minor_units)::text,
      private.round_money(coalesce(agg.outstanding, 0), cur.minor_units)::text,
      c.archived_at, agg.last_entry_at, coalesce(agg.entry_count, 0), c.created_at
    from public.customers c
    join public.businesses b on b.id = c.business_id
    join public.currencies cur on cur.code = b.currency
    left join lateral (
      select sum(l.amount) as outstanding, max(l.created_at) as last_entry_at, count(*) as entry_count
      from public.customer_ledger l where l.customer_id = c.id
    ) agg on true
    where c.business_id = p_business_id
      and (coalesce(p_include_archived, false) or c.archived_at is null)
      and (v_search is null or position(lower(v_search) in lower(c.name)) > 0
        or position(v_search in coalesce(c.phone, '')) > 0)
    order by c.name asc, c.id asc
    limit v_limit offset v_offset;
end;
$$;

create function public.list_products(p_business_id uuid, p_search text default null,
  p_include_archived boolean default false, p_limit integer default 50, p_offset integer default 0)
returns table(id uuid, name text, sku text, unit text, sale_price text, cost_price text,
  archived_at timestamptz, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not private.is_member(p_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
    select p.id, p.name, p.sku, p.unit, trim_scale(p.sale_price)::text,
      trim_scale(p.cost_price)::text, p.archived_at, p.created_at
    from public.products p
    where p.business_id = p_business_id
      and (coalesce(p_include_archived, false) or p.archived_at is null)
      and (v_search is null or position(lower(v_search) in lower(p.name)) > 0
        or position(lower(v_search) in lower(coalesce(p.sku, ''))) > 0)
    order by p.name asc, p.id asc
    limit v_limit offset v_offset;
end;
$$;

create function public.list_sales(p_business_id uuid, p_customer_id uuid default null,
  p_from date default null, p_to date default null, p_status public.document_status default null,
  p_limit integer default 30, p_offset integer default 0)
returns table(id uuid, customer_id uuid, customer_name text, sale_date date,
  status public.document_status, payment_method public.payment_method, currency text,
  subtotal text, discount_total text, total text, cogs text, paid_amount text, due text,
  item_count bigint, reference text, note text, created_at timestamptz, created_by uuid)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not private.is_member(p_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
    select s.id, s.customer_id, c.name, s.sale_date, s.status, s.payment_method, s.currency,
      private.round_money(s.subtotal, cur.minor_units)::text,
      private.round_money(s.discount_total, cur.minor_units)::text,
      private.round_money(s.total, cur.minor_units)::text,
      private.round_money(s.cogs, cur.minor_units)::text,
      private.round_money(s.paid_amount, cur.minor_units)::text,
      private.round_money(s.total - s.paid_amount, cur.minor_units)::text,
      coalesce(n.item_count, 0), s.reference, s.note, s.created_at, s.created_by
    from public.sales s
    join public.currencies cur on cur.code = s.currency
    left join public.customers c on c.id = s.customer_id
    left join lateral (
      select count(*) as item_count from public.sale_items i where i.sale_id = s.id
    ) n on true
    where s.business_id = p_business_id
      and (p_customer_id is null or s.customer_id = p_customer_id)
      and (p_from is null or s.sale_date >= p_from)
      and (p_to is null or s.sale_date <= p_to)
      and (p_status is null or s.status = p_status)
    order by s.sale_date desc, s.created_at desc, s.id desc
    limit v_limit offset v_offset;
end;
$$;

create function public.list_payments(p_business_id uuid, p_customer_id uuid default null,
  p_from date default null, p_to date default null, p_status public.document_status default null,
  p_limit integer default 30, p_offset integer default 0)
returns table(id uuid, customer_id uuid, customer_name text, sale_id uuid,
  direction public.payment_direction, amount text, currency text,
  payment_method public.payment_method,
  payment_date date, status public.document_status, reference text, note text,
  created_at timestamptz, created_by uuid)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not private.is_member(p_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
    select p.id, p.customer_id, c.name, p.sale_id, p.direction,
      private.round_money(p.amount, cur.minor_units)::text, p.currency,
      p.payment_method, p.payment_date, p.status, p.reference, p.note, p.created_at, p.created_by
    from public.payments p
    join public.currencies cur on cur.code = p.currency
    join public.customers c on c.id = p.customer_id
    where p.business_id = p_business_id
      and (p_customer_id is null or p.customer_id = p_customer_id)
      and (p_from is null or p.payment_date >= p_from)
      and (p_to is null or p.payment_date <= p_to)
      and (p_status is null or p.status = p_status)
    order by p.payment_date desc, p.created_at desc, p.id desc
    limit v_limit offset v_offset;
end;
$$;

create function public.list_expenses(p_business_id uuid, p_from date default null, p_to date default null,
  p_category text default null, p_status public.document_status default null,
  p_limit integer default 30, p_offset integer default 0)
returns table(id uuid, expense_date date, category text, amount text,
  payment_method public.payment_method, currency text, status public.document_status,
  reference text, note text, created_at timestamptz, created_by uuid)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
begin
  -- Staff cannot read expenses; the RLS policy enforces the same rule again.
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Expenses are visible to owners, managers and accountants');
  return query
    select e.id, e.expense_date, e.category, private.round_money(e.amount, cur.minor_units)::text,
      e.payment_method, e.currency, e.status, e.reference, e.note, e.created_at, e.created_by
    from public.expenses e
    join public.currencies cur on cur.code = e.currency
    where e.business_id = p_business_id
      and (p_from is null or e.expense_date >= p_from)
      and (p_to is null or e.expense_date <= p_to)
      and (v_category is null or e.category = v_category)
      and (p_status is null or e.status = p_status)
    order by e.expense_date desc, e.created_at desc, e.id desc
    limit v_limit offset v_offset;
end;
$$;

create function public.expense_categories(p_business_id uuid)
returns table(category text, entries bigint, total text)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
begin
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Expenses are visible to owners, managers and accountants');
  return query
    select e.category, count(*) as entries,
      private.round_money(sum(e.amount), cur.minor_units)::text as total
    from public.expenses e
    join public.businesses b on b.id = e.business_id
    join public.currencies cur on cur.code = b.currency
    where e.business_id = p_business_id and e.status = 'posted'
    group by e.category, cur.minor_units order by e.category asc limit 200;
end;
$$;

create function public.list_activity(p_business_id uuid, p_limit integer default 30,
  p_before timestamptz default null)
returns table(id uuid, actor_id uuid, actor_name text, action text, entity_type text,
  entity_id uuid, summary text, amount text, created_at timestamptz)
language plpgsql stable security invoker set search_path = '' as $$
#variable_conflict use_column
declare v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if not private.is_member(p_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
    select a.id, a.actor_id, coalesce(m.display_name, pr.display_name, 'Member') as actor_name,
      a.action, a.entity_type, a.entity_id, a.summary,
      case when a.amount is null then null
        else private.round_money(a.amount, cur.minor_units)::text end as amount,
      a.created_at
    from public.activity_logs a
    join public.businesses b on b.id = a.business_id
    join public.currencies cur on cur.code = b.currency
    left join public.profiles pr on pr.id = a.actor_id
    left join public.business_members m on m.business_id = a.business_id and m.user_id = a.actor_id
    where a.business_id = p_business_id
      and (p_before is null or a.created_at < p_before)
    order by a.created_at desc, a.id desc
    limit v_limit;
end;
$$;

-- Khata statement. Ordered by business date, then by the order the business
-- recorded the rows, so a reversal posted today against last month's sale is shown
-- beside that sale and the running balance is restated consistently.
create function public.customer_statement(p_customer_id uuid, p_from date default null,
  p_to date default null, p_limit integer default 100)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_business_id uuid; v_result jsonb; v_total bigint; v_scale integer;
begin
  select c.business_id, private.money_scale(b.currency) into v_business_id, v_scale
  from public.customers c join public.businesses b on b.id = c.business_id
  where c.id = p_customer_id;
  if not found then raise exception 'Customer not found' using errcode = '42501'; end if;
  if not private.is_member(v_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The start date must not be after the end date' using errcode = '22023';
  end if;
  select count(*) into v_total from public.customer_ledger l
  where l.customer_id = p_customer_id
    and (p_from is null or l.entry_date >= p_from) and (p_to is null or l.entry_date <= p_to);
  with windowed as (
    select l.id, l.entry_type, l.amount, l.entry_date, l.reference_type, l.reference_id,
      l.note, l.created_at, l.created_by,
      sum(l.amount) over (order by l.entry_date, l.created_at, l.id) as running
    from public.customer_ledger l where l.customer_id = p_customer_id
  ), page as (
    select * from windowed w
    where (p_from is null or w.entry_date >= p_from) and (p_to is null or w.entry_date <= p_to)
    order by w.entry_date desc, w.created_at desc, w.id desc
    limit v_limit
  )
  select jsonb_build_object(
    'customer_id', p_customer_id,
    'business_id', v_business_id,
    -- Carried here so a khata screen never has to page through the customer list
    -- to name the account it is showing.
    'customer_name', c.name,
    'customer_archived_at', c.archived_at,
    'currency', b.currency,
    'scale', private.money_scale(b.currency),
    'from', p_from, 'to', p_to,
    'entry_count', coalesce(v_total, 0),
    'truncated', coalesce(v_total, 0) > v_limit,
    -- Balance immediately before the first row on this page.
    'opening_outstanding', private.round_money(coalesce(
      (select p.running - p.amount from page p
       order by p.entry_date, p.created_at, p.id limit 1),
      (select sum(l.amount) from public.customer_ledger l
       where l.customer_id = p_customer_id and (p_from is null or l.entry_date < p_from)),
      0), v_scale)::text,
    'closing_outstanding', private.round_money(coalesce(
      (select p.running from page p
       order by p.entry_date desc, p.created_at desc, p.id desc limit 1),
      (select sum(l.amount) from public.customer_ledger l
       where l.customer_id = p_customer_id and (p_from is null or l.entry_date < p_from)),
      0), v_scale)::text,
    'debited_total', private.round_money(coalesce(
      (select sum(p.amount) from page p where p.amount > 0), 0), v_scale)::text,
    'credited_total', private.round_money(coalesce(
      (select sum(-p.amount) from page p where p.amount < 0), 0), v_scale)::text,
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'entry_type', p.entry_type,
        'amount', private.round_money(p.amount, v_scale)::text,
        'entry_date', p.entry_date,
        'running_balance', private.round_money(p.running, v_scale)::text,
        'reference_type', p.reference_type, 'reference_id', p.reference_id,
        'note', p.note, 'created_at', p.created_at, 'created_by', p.created_by)
        order by p.entry_date, p.created_at, p.id)
      from page p), '[]'::jsonb)
  ) into v_result
  from public.customers c join public.businesses b on b.id = c.business_id
  where c.id = p_customer_id;
  return v_result;
end;
$$;

-- Range performance: revenue, COGS, expenses and net profit for a period.
create function public.period_summary(p_business_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_business public.businesses; v_scale integer; v_result jsonb;
begin
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Financial summaries are visible to owners, managers and accountants');
  select * into v_business from public.businesses where id = p_business_id;
  if not found then raise exception 'Business not found' using errcode = '42501'; end if;
  if p_from is null or p_to is null then
    raise exception 'A start and end date are required' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'The start date must not be after the end date' using errcode = '22023';
  end if;
  v_scale := private.money_scale(v_business.currency);
  with s as (
    select count(*) as cnt, coalesce(sum(x.subtotal), 0) as subtotal,
      coalesce(sum(x.discount_total), 0) as discount_total, coalesce(sum(x.total), 0) as revenue,
      coalesce(sum(x.cogs), 0) as cogs, coalesce(sum(x.paid_amount), 0) as counter_receipts,
      coalesce(sum(case when x.cogs > 0 then x.total else 0 end), 0) as cogs_recorded
    from public.sales x
    where x.business_id = p_business_id and x.status = 'posted'
      and x.sale_date between p_from and p_to
  ), e as (
    select count(*) as cnt, coalesce(sum(x.amount), 0) as total
    from public.expenses x
    where x.business_id = p_business_id and x.status = 'posted'
      and x.expense_date between p_from and p_to
  ), p as (
    select count(*) filter (where x.direction = 'received') as received_cnt,
      coalesce(sum(x.amount) filter (where x.direction = 'received'), 0) as received_total,
      count(*) filter (where x.direction = 'refunded') as refunded_cnt,
      coalesce(sum(x.amount) filter (where x.direction = 'refunded'), 0) as refunded_total
    from public.payments x
    where x.business_id = p_business_id and x.status = 'posted'
      and x.payment_date between p_from and p_to
  )
  select jsonb_build_object(
    'business_id', p_business_id, 'currency', v_business.currency, 'scale', v_scale,
    'from', p_from, 'to', p_to,
    'sales_count', s.cnt,
    'subtotal', private.round_money(s.subtotal, v_scale)::text,
    'discount_total', private.round_money(s.discount_total, v_scale)::text,
    'revenue', private.round_money(s.revenue, v_scale)::text,
    'cogs', private.round_money(s.cogs, v_scale)::text,
    'gross_profit', private.round_money(s.revenue - s.cogs, v_scale)::text,
    'expense_count', e.cnt,
    'expense_total', private.round_money(e.total, v_scale)::text,
    'net_profit', private.round_money(s.revenue - s.cogs - e.total, v_scale)::text,
    'counter_receipts_total', private.round_money(s.counter_receipts, v_scale)::text,
    'collections_count', p.received_cnt,
    'collections_total', private.round_money(p.received_total, v_scale)::text,
    'refunds_count', p.refunded_cnt,
    'refunds_total', private.round_money(p.refunded_total, v_scale)::text,
    'cash_received_total', private.round_money(s.counter_receipts + p.received_total, v_scale)::text,
    'cash_paid_total', private.round_money(e.total + p.refunded_total, v_scale)::text,
    -- Share of revenue whose cost was actually recorded. Profit is overstated when
    -- this is below 100%, and the app says so instead of hiding it.
    'cogs_coverage_percent', coalesce(
      private.round_money(100 * s.cogs_recorded / nullif(s.revenue, 0), 1), 0)::text
  ) into v_result
  from s, e, p;
  return v_result;
end;
$$;

-- Point-in-time position: what is owed to the business and how much cash it holds.
create function public.balance_summary(p_business_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_business public.businesses; v_scale integer; v_result jsonb;
begin
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Financial summaries are visible to owners, managers and accountants');
  select * into v_business from public.businesses where id = p_business_id;
  if not found then raise exception 'Business not found' using errcode = '42501'; end if;
  v_scale := private.money_scale(v_business.currency);
  with balances as (
    select l.customer_id, sum(l.amount) as outstanding
    from public.customer_ledger l where l.business_id = p_business_id
    group by l.customer_id
  ), cash as (
    select f.method, sum(f.received) as received, sum(f.paid) as paid
    from (
      select s.payment_method as method, s.paid_amount as received, 0::numeric as paid
      from public.sales s
      where s.business_id = p_business_id and s.status = 'posted' and s.paid_amount > 0
      union all
      select p.payment_method,
        case when p.direction = 'received' then p.amount else 0::numeric end,
        case when p.direction = 'refunded' then p.amount else 0::numeric end
      from public.payments p where p.business_id = p_business_id and p.status = 'posted'
      union all
      select e.payment_method, 0::numeric, e.amount
      from public.expenses e where e.business_id = p_business_id and e.status = 'posted'
    ) f group by f.method
  )
  select jsonb_build_object(
    'business_id', p_business_id, 'currency', v_business.currency, 'scale', v_scale,
    'currency_locked_at', v_business.currency_locked_at,
    -- Inlined instead of private.has_financial_activity() so this SECURITY INVOKER
    -- read model stays inside RLS and cannot be used to probe another tenant.
    'financial_activity', v_business.currency_locked_at is not null
      or exists (select 1 from public.sales s where s.business_id = p_business_id)
      or exists (select 1 from public.payments p2 where p2.business_id = p_business_id)
      or exists (select 1 from public.expenses e2 where e2.business_id = p_business_id)
      or exists (select 1 from public.customer_ledger l2 where l2.business_id = p_business_id),
    'as_of', statement_timestamp(),
    'customer_count', (select count(*) from public.customers c
      where c.business_id = p_business_id and c.archived_at is null),
    'product_count', (select count(*) from public.products p
      where p.business_id = p_business_id and p.archived_at is null),
    'receivables_total', private.round_money(coalesce(
      (select sum(b.outstanding) from balances b where b.outstanding > 0), 0), v_scale)::text,
    'customers_owing_count', coalesce((select count(*) from balances b where b.outstanding > 0), 0),
    'customer_credit_total', private.round_money(coalesce(
      (select -sum(b.outstanding) from balances b where b.outstanding < 0), 0), v_scale)::text,
    'customers_in_credit_count', coalesce((select count(*) from balances b where b.outstanding < 0), 0),
    'net_receivables', private.round_money(coalesce((select sum(b.outstanding) from balances b), 0), v_scale)::text,
    'cash_methods', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', c.method,
        'received', private.round_money(c.received, v_scale)::text,
        'paid', private.round_money(c.paid, v_scale)::text,
        'net', private.round_money(c.received - c.paid, v_scale)::text)
        order by c.method)
      from cash c), '[]'::jsonb),
    'cash_received_total', private.round_money(coalesce((select sum(c.received) from cash c), 0), v_scale)::text,
    'cash_paid_total', private.round_money(coalesce((select sum(c.paid) from cash c), 0), v_scale)::text,
    'cash_net_total', private.round_money(coalesce(
      (select sum(c.received - c.paid) from cash c), 0), v_scale)::text
  ) into v_result;
  return v_result;
end;
$$;

-- Single-customer balance for any member, including staff at the counter.
create function public.customer_balance(p_customer_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_business_id uuid; v_currency text; v_name text; v_archived timestamptz;
begin
  select c.business_id, b.currency, c.name, c.archived_at
    into v_business_id, v_currency, v_name, v_archived
  from public.customers c join public.businesses b on b.id = c.business_id
  where c.id = p_customer_id;
  if not found then raise exception 'Customer not found' using errcode = '42501'; end if;
  if not private.is_member(v_business_id) then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'customer_id', p_customer_id, 'business_id', v_business_id, 'currency', v_currency,
    -- Carried here so a payment form can name the account and show what it
    -- currently owes without paging through the customer list.
    'customer_name', v_name, 'customer_archived_at', v_archived,
    'scale', private.money_scale(v_currency),
    'outstanding', private.round_money(coalesce(
      (select sum(l.amount) from public.customer_ledger l where l.customer_id = p_customer_id),
      0), private.money_scale(v_currency))::text
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Write RPCs. SECURITY DEFINER (clients hold no write grants), empty search path,
-- explicit membership/role/tenant checks, one business row lock, one idempotency
-- receipt, and audit + activity history for every financial change.
-- ---------------------------------------------------------------------------
create function public.save_customer(p_operation_id uuid, p_business_id uuid, p_customer_id uuid,
  p_name text, p_phone text default null, p_email text default null, p_address text default null,
  p_opening_balance text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_name text := btrim(coalesce(p_name, ''));
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_opening numeric; v_scale integer; v_id uuid; v_existing public.customers; v_replay jsonb; v_created boolean;
begin
  v_business := private.lock_business(p_business_id);
  v_scale := private.money_scale(v_business.currency);
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'customer.save');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Customer name must be 1–120 characters' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 \-()]{2,31}$' then
    raise exception 'Enter a valid phone number' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 254
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;
  if v_address is not null and char_length(v_address) > 240 then
    raise exception 'Address must be at most 240 characters' using errcode = '22023';
  end if;
  v_opening := private.round_money(coalesce(private.parse_decimal(p_opening_balance, 'Opening balance'), 0), v_scale);
  if abs(v_opening) >= 100000000000000 then
    raise exception 'Opening balance is too large' using errcode = '22023';
  end if;
  if p_customer_id is null then
    insert into public.customers(business_id, name, phone, email, address, opening_balance, created_by)
    values (p_business_id, v_name, v_phone, v_email, v_address, v_opening, v_actor)
    returning id into v_id;
    v_created := true;
    if v_opening <> 0 then
      insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
        reference_type, reference_id, entry_date, note, created_by)
      values (p_business_id, v_id, 'opening_balance', v_opening, 'customer', v_id,
        (now() at time zone v_business.timezone)::date, 'Opening balance', v_actor);
    end if;
  else
    select * into v_existing from public.customers
    where id = p_customer_id and business_id = p_business_id for update;
    if not found then
      -- A foreign or missing customer id must not create or move a record.
      raise exception 'Customer not found in this business' using errcode = '42501';
    end if;
    if private.parse_decimal(p_opening_balance, 'Opening balance') is not null
      and private.round_money(private.parse_decimal(p_opening_balance, 'Opening balance'), v_scale)
        <> v_existing.opening_balance then
      raise exception 'An opening balance cannot be changed after the khata is opened. Record an adjustment instead.'
        using errcode = '22023';
    end if;
    update public.customers set name = v_name, phone = v_phone, email = v_email, address = v_address
    where id = v_existing.id;
    v_id := v_existing.id;
    v_created := false;
  end if;
  -- An opening balance is money on the khata, so it locks the currency like any
  -- other financial record. Contact-only edits do not.
  if v_created and v_opening <> 0 then perform private.lock_currency(p_business_id); end if;
  perform private.add_audit(p_business_id,
    case when v_created then 'customer.created' else 'customer.updated' end,
    'customer', v_id, jsonb_build_object('name', v_name, 'opening_balance', v_opening::text));
  perform private.add_activity(p_business_id,
    case when v_created then 'customer.created' else 'customer.updated' end,
    'customer', v_id, case when v_created then 'Added customer ' else 'Updated customer ' end || v_name, null);
  v_replay := jsonb_build_object('customer_id', v_id, 'created', v_created, 'currency', v_business.currency,
    'scale', v_scale, 'name', v_name, 'opening_balance', v_opening::text, 'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.archive_customer(p_customer_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid;
begin
  if p_archived is null then raise exception 'Invalid archive setting' using errcode = '22023'; end if;
  select business_id into v_business_id from public.customers where id = p_customer_id for update;
  if not found then raise exception 'Customer not found' using errcode = '42501'; end if;
  perform private.require_roles(v_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can archive a customer');
  update public.customers set archived_at = case when p_archived then coalesce(archived_at, now()) else null end
  where id = p_customer_id;
  perform private.add_audit(v_business_id,
    case when p_archived then 'customer.archived' else 'customer.restored' end,
    'customer', p_customer_id, '{}'::jsonb);
  perform private.add_activity(v_business_id,
    case when p_archived then 'customer.archived' else 'customer.restored' end,
    'customer', p_customer_id,
    case when p_archived then 'Archived a customer' else 'Restored a customer' end, null);
end;
$$;

create function public.save_product(p_operation_id uuid, p_business_id uuid, p_product_id uuid,
  p_name text, p_sku text default null, p_unit text default null,
  p_sale_price text default null, p_cost_price text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_scale integer;
  v_name text := btrim(coalesce(p_name, '')); v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_unit text := nullif(btrim(coalesce(p_unit, '')), 'pcs');
  v_sale numeric; v_cost numeric; v_id uuid; v_existing public.products; v_replay jsonb; v_created boolean;
begin
  v_business := private.lock_business(p_business_id);
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can change the catalog');
  v_scale := private.money_scale(v_business.currency);
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'product.save');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_name) not between 1 and 120 then
    raise exception 'Product name must be 1–120 characters' using errcode = '22023';
  end if;
  v_unit := coalesce(nullif(btrim(coalesce(p_unit, '')), ''), 'pcs');
  if char_length(v_unit) > 24 then raise exception 'Unit must be at most 24 characters' using errcode = '22023'; end if;
  if v_sku is not null and char_length(v_sku) > 40 then
    raise exception 'SKU must be at most 40 characters' using errcode = '22023';
  end if;
  v_sale := private.round_money(coalesce(private.parse_decimal(p_sale_price, 'Sale price'), 0), v_scale);
  v_cost := private.round_money(coalesce(private.parse_decimal(p_cost_price, 'Cost price'), 0), v_scale);
  if v_sale < 0 or v_cost < 0 then raise exception 'Prices cannot be negative' using errcode = '22023'; end if;
  if p_product_id is null then
    insert into public.products(business_id, name, sku, unit, sale_price, cost_price, created_by)
    values (p_business_id, v_name, v_sku, v_unit, v_sale, v_cost, v_actor) returning id into v_id;
    v_created := true;
  else
    select * into v_existing from public.products
    where id = p_product_id and business_id = p_business_id for update;
    if not found then raise exception 'Product not found in this business' using errcode = '42501'; end if;
    update public.products set name = v_name, sku = v_sku, unit = v_unit,
      sale_price = v_sale, cost_price = v_cost
    where id = v_existing.id;
    v_id := v_existing.id;
    v_created := false;
  end if;
  perform private.add_audit(p_business_id,
    case when v_created then 'product.created' else 'product.updated' end, 'product', v_id,
    jsonb_build_object('name', v_name, 'sale_price', v_sale::text, 'cost_price', v_cost::text));
  perform private.add_activity(p_business_id,
    case when v_created then 'product.created' else 'product.updated' end, 'product', v_id,
    case when v_created then 'Added item ' else 'Updated item ' end || v_name, null);
  v_replay := jsonb_build_object('product_id', v_id, 'created', v_created, 'currency', v_business.currency,
    'scale', v_scale, 'name', v_name, 'sale_price', v_sale::text, 'cost_price', v_cost::text, 'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.create_sale(p_operation_id uuid, p_business_id uuid, p_customer_id uuid,
  p_sale_date date, p_payment_method public.payment_method, p_paid_amount text,
  p_items jsonb, p_reference text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_scale integer; v_today date;
  v_customer public.customers; v_product public.products; v_item jsonb; v_ordinality integer;
  v_method public.payment_method := coalesce(p_payment_method, 'cash');
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_quantity numeric; v_price numeric; v_discount numeric; v_cost numeric; v_gross numeric; v_line numeric;
  v_name text; v_unit text; v_product_id uuid; v_paid numeric;
  v_subtotal numeric := 0; v_discount_total numeric := 0; v_cogs numeric := 0;
  v_sale_id uuid; v_replay jsonb; v_line_count integer := 0; v_due numeric; v_outstanding numeric;
  v_ids uuid[] := '{}'; v_names text[] := '{}'; v_units text[] := '{}'; v_positions integer[] := '{}';
  v_quantities numeric[] := '{}'; v_prices numeric[] := '{}'; v_discounts numeric[] := '{}';
  v_costs numeric[] := '{}'; v_totals numeric[] := '{}'; v_line_cogs numeric[] := '{}';
begin
  v_business := private.lock_business(p_business_id);
  v_scale := private.money_scale(v_business.currency);
  v_today := (now() at time zone v_business.timezone)::date;
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'sale.create');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if p_sale_date is null then raise exception 'A sale date is required' using errcode = '22023'; end if;
  if p_sale_date > v_today + 1 then
    raise exception 'A sale cannot be dated in the future' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one line to the sale' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'A sale can hold at most 100 lines' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 60 then
    raise exception 'Reference must be at most 60 characters' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Note must be at most 500 characters' using errcode = '22023';
  end if;
  if p_customer_id is not null then
    select * into v_customer from public.customers
    where id = p_customer_id and business_id = p_business_id for update;
    if not found then raise exception 'Customer not found in this business' using errcode = '42501'; end if;
    if v_customer.archived_at is not null then
      raise exception 'This customer is archived; restore it before selling on credit' using errcode = '22023';
    end if;
  end if;
  v_paid := private.round_money(coalesce(private.parse_decimal(p_paid_amount, 'Amount received'), 0), v_scale);
  if v_paid < 0 then raise exception 'Amount received cannot be negative' using errcode = '22023'; end if;
  if v_method = 'credit' and v_paid <> 0 then
    raise exception 'A credit sale records no money received' using errcode = '22023';
  end if;
  if v_method <> 'credit' and v_paid = 0 then
    raise exception 'Choose the credit method when nothing is received now' using errcode = '22023';
  end if;
  for v_item, v_ordinality in
    select t.value, (t.ordinality - 1)::integer
    from jsonb_array_elements(p_items) with ordinality as t(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each line must be an object' using errcode = '22023';
    end if;
    v_name := btrim(coalesce(v_item ->> 'item_name', ''));
    v_unit := nullif(btrim(coalesce(v_item ->> 'unit', '')), '');
    -- Validate before casting: a malformed id must be a clean validation error,
    -- and an id from another tenant must never be snapshot into this sale.
    if coalesce(v_item ->> 'product_id', '') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_product_id := (v_item ->> 'product_id')::uuid;
    elsif coalesce(btrim(v_item ->> 'product_id'), '') <> '' then
      raise exception 'Item reference is not valid' using errcode = '22023';
    else
      v_product_id := null;
    end if;
    if v_product_id is not null then
      select * into v_product from public.products
      where id = v_product_id and business_id = p_business_id;
      if not found then
        -- Rejects a product id from another tenant instead of quietly snapshotting it.
        raise exception 'Item not found in this business' using errcode = '42501';
      end if;
      if v_product.archived_at is not null then
        raise exception 'Item % is archived', v_product.name using errcode = '22023';
      end if;
      if v_name = '' then v_name := v_product.name; end if;
      if v_unit is null then v_unit := v_product.unit; end if;
      if v_item ->> 'unit_price' is null then v_price := v_product.sale_price;
      else v_price := private.require_decimal(v_item ->> 'unit_price', 'Unit price'); end if;
      if v_item ->> 'unit_cost' is null then v_cost := v_product.cost_price;
      else v_cost := coalesce(private.parse_decimal(v_item ->> 'unit_cost', 'Unit cost'), 0); end if;
    else
      v_price := private.require_decimal(v_item ->> 'unit_price', 'Unit price');
      v_cost := coalesce(private.parse_decimal(v_item ->> 'unit_cost', 'Unit cost'), 0);
    end if;
    if char_length(v_name) not between 1 and 120 then
      raise exception 'Each line needs a name of 1–120 characters' using errcode = '22023';
    end if;
    v_unit := coalesce(v_unit, 'pcs');
    v_quantity := round(private.require_decimal(v_item ->> 'quantity', 'Quantity'), 3);
    v_discount := private.round_money(coalesce(private.parse_decimal(v_item ->> 'discount', 'Discount'), 0), v_scale);
    if v_quantity <= 0 then raise exception 'Quantity must be greater than zero' using errcode = '22023'; end if;
    if v_quantity >= 1000000000 then raise exception 'Quantity is too large' using errcode = '22023'; end if;
    if v_price < 0 then raise exception 'Unit price cannot be negative' using errcode = '22023'; end if;
    if v_cost < 0 then raise exception 'Unit cost cannot be negative' using errcode = '22023'; end if;
    if v_discount < 0 then raise exception 'Discount cannot be negative' using errcode = '22023'; end if;
    v_gross := private.round_money(v_quantity * v_price, v_scale);
    if v_discount > v_gross then
      raise exception 'A line discount cannot exceed the line total' using errcode = '22023';
    end if;
    v_line := v_gross - v_discount;
    v_subtotal := v_subtotal + v_gross;
    v_discount_total := v_discount_total + v_discount;
    v_cogs := v_cogs + private.round_money(v_quantity * v_cost, v_scale);
    v_ids := array_append(v_ids, v_product_id);
    v_names := array_append(v_names, left(v_name, 120));
    v_units := array_append(v_units, left(v_unit, 24));
    v_positions := array_append(v_positions, v_ordinality);
    v_quantities := array_append(v_quantities, v_quantity);
    v_prices := array_append(v_prices, private.round_money(v_price, 4));
    v_discounts := array_append(v_discounts, v_discount);
    v_costs := array_append(v_costs, private.round_money(v_cost, 4));
    v_totals := array_append(v_totals, v_line);
    v_line_cogs := array_append(v_line_cogs, private.round_money(v_quantity * v_cost, v_scale));
    v_line_count := v_line_count + 1;
  end loop;
  if v_subtotal - v_discount_total <= 0 then
    raise exception 'A sale total must be greater than zero' using errcode = '22023';
  end if;
  if v_subtotal >= 100000000000000 then
    raise exception 'This sale is too large to record' using errcode = '22023';
  end if;
  if v_paid > v_subtotal - v_discount_total then
    raise exception 'Amount received cannot exceed the sale total' using errcode = '22023';
  end if;
  if p_customer_id is null and v_paid <> v_subtotal - v_discount_total then
    raise exception 'A sale without a customer must be settled in full' using errcode = '22023';
  end if;
  insert into public.sales(business_id, customer_id, sale_date, payment_method, currency,
    subtotal, discount_total, total, cogs, paid_amount, reference, note, created_by)
  values (p_business_id, p_customer_id, p_sale_date, v_method, v_business.currency,
    v_subtotal, v_discount_total, v_subtotal - v_discount_total, v_cogs, v_paid,
    v_reference, v_note, v_actor)
  returning id into v_sale_id;
  insert into public.sale_items(sale_id, business_id, product_id, item_name, unit, position,
    quantity, unit_price, discount, unit_cost, line_total, line_cogs)
  select v_sale_id, p_business_id, unnest(v_ids), unnest(v_names), unnest(v_units), unnest(v_positions),
    unnest(v_quantities), unnest(v_prices), unnest(v_discounts), unnest(v_costs),
    unnest(v_totals), unnest(v_line_cogs);
  if p_customer_id is not null then
    insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
      reference_type, reference_id, entry_date, note, created_by)
    values (p_business_id, p_customer_id, 'sale', v_subtotal - v_discount_total,
      'sale', v_sale_id, p_sale_date, v_reference, v_actor);
    if v_paid > 0 then
      insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
        reference_type, reference_id, entry_date, note, created_by)
      values (p_business_id, p_customer_id, 'payment', -v_paid,
        'sale', v_sale_id, p_sale_date, 'Received with sale', v_actor);
    end if;
  end if;
  perform private.lock_currency(p_business_id);
  perform private.add_audit(p_business_id, 'sale.created', 'sale', v_sale_id, jsonb_build_object(
    'customer_id', p_customer_id, 'sale_date', p_sale_date, 'total', (v_subtotal - v_discount_total)::text,
    'paid_amount', v_paid::text, 'cogs', v_cogs::text, 'currency', v_business.currency,
    'lines', v_line_count, 'operation_id', p_operation_id));
  perform private.add_activity(p_business_id, 'sale.created', 'sale', v_sale_id,
    'Recorded a sale of ' || v_line_count || ' line(s)'
      || coalesce(' for ' || v_customer.name, ' at the counter'),
    v_subtotal - v_discount_total);
  v_due := v_subtotal - v_discount_total - v_paid;
  if p_customer_id is not null then
    select coalesce(sum(l.amount), 0) into v_outstanding
    from public.customer_ledger l where l.customer_id = p_customer_id;
  end if;
  v_replay := jsonb_build_object('sale_id', v_sale_id, 'currency', v_business.currency, 'scale', v_scale,
    'sale_date', p_sale_date, 'subtotal', v_subtotal::text, 'discount_total', v_discount_total::text,
    'total', (v_subtotal - v_discount_total)::text, 'cogs', v_cogs::text, 'paid_amount', v_paid::text,
    'due', private.round_money(v_due, v_scale)::text, 'lines', v_line_count,
    'customer_id', p_customer_id,
    'customer_outstanding', case when p_customer_id is null then null
      else private.round_money(v_outstanding, v_scale)::text end,
    'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.void_sale(p_operation_id uuid, p_sale_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_sale public.sales; v_scale integer;
  v_reason text := btrim(coalesce(p_reason, '')); v_replay jsonb; v_outstanding numeric;
begin
  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Sale not found' using errcode = '42501'; end if;
  perform private.lock_business(v_sale.business_id);
  perform private.require_roles(v_sale.business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can void a sale');
  v_scale := private.money_scale(v_sale.currency);
  v_replay := private.begin_operation(v_sale.business_id, p_operation_id, 'sale.void');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'A reason of 1–200 characters is required to void a sale' using errcode = '22023';
  end if;
  if v_sale.status <> 'posted' then
    raise exception 'This sale is already voided' using errcode = '22023';
  end if;
  if v_sale.customer_id is not null then
    insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
      reference_type, reference_id, entry_date, note, created_by)
    values (v_sale.business_id, v_sale.customer_id, 'sale_void', -v_sale.total,
      'sale', v_sale.id, v_sale.sale_date, 'Voided: ' || left(v_reason, 180), v_actor);
    if v_sale.paid_amount > 0 then
      insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
        reference_type, reference_id, entry_date, note, created_by)
      values (v_sale.business_id, v_sale.customer_id, 'payment_void', v_sale.paid_amount,
        'sale', v_sale.id, v_sale.sale_date, 'Sale voided: counter receipt reversed', v_actor);
    end if;
    select coalesce(sum(l.amount), 0) into v_outstanding
    from public.customer_ledger l where l.customer_id = v_sale.customer_id;
  end if;
  update public.sales set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = v_reason
  where id = v_sale.id;
  perform private.add_audit(v_sale.business_id, 'sale.voided', 'sale', v_sale.id, jsonb_build_object(
    'reason', v_reason, 'total', v_sale.total::text, 'paid_amount', v_sale.paid_amount::text,
    'operation_id', p_operation_id));
  perform private.add_activity(v_sale.business_id, 'sale.voided', 'sale', v_sale.id,
    'Voided a sale', -v_sale.total);
  v_replay := jsonb_build_object('sale_id', v_sale.id, 'voided', true, 'currency', v_sale.currency,
    'scale', v_scale, 'total', private.round_money(v_sale.total, v_scale)::text,
    'customer_outstanding', case when v_sale.customer_id is null then null
      else private.round_money(v_outstanding, v_scale)::text end,
    'replayed', false);
  perform private.finish_operation(v_sale.business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.record_payment(p_operation_id uuid, p_business_id uuid, p_customer_id uuid,
  p_sale_id uuid, p_direction public.payment_direction, p_amount text,
  p_payment_method public.payment_method, p_payment_date date,
  p_reference text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_scale integer; v_today date;
  v_customer public.customers; v_sale public.sales; v_amount numeric; v_payment_id uuid;
  v_direction public.payment_direction := coalesce(p_direction, 'received');
  v_method public.payment_method := coalesce(p_payment_method, 'cash');
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_signed numeric; v_outstanding numeric; v_replay jsonb;
begin
  v_business := private.lock_business(p_business_id);
  v_scale := private.money_scale(v_business.currency);
  v_today := (now() at time zone v_business.timezone)::date;
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'payment.create');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if v_method = 'credit' then
    raise exception 'Choose how the money actually moved' using errcode = '22023';
  end if;
  v_amount := private.round_money(private.require_decimal(p_amount, 'Amount'), v_scale);
  if v_amount <= 0 then raise exception 'Amount must be greater than zero' using errcode = '22023'; end if;
  if v_amount >= 100000000000000 then raise exception 'Amount is too large' using errcode = '22023'; end if;
  if p_payment_date is null then raise exception 'A payment date is required' using errcode = '22023'; end if;
  if p_payment_date > v_today + 1 then
    raise exception 'A payment cannot be dated in the future' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 60 then
    raise exception 'Reference must be at most 60 characters' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Note must be at most 500 characters' using errcode = '22023';
  end if;
  select * into v_customer from public.customers
  where id = p_customer_id and business_id = p_business_id for update;
  if not found then raise exception 'Customer not found in this business' using errcode = '42501'; end if;
  if p_sale_id is not null then
    select * into v_sale from public.sales
    where id = p_sale_id and business_id = p_business_id and customer_id = p_customer_id;
    if not found then
      raise exception 'That sale belongs to a different customer or business' using errcode = '42501';
    end if;
  end if;
  insert into public.payments(business_id, customer_id, sale_id, direction, amount,
    payment_method, currency, payment_date, reference, note, created_by)
  values (p_business_id, p_customer_id, p_sale_id, v_direction, v_amount, v_method,
    v_business.currency, p_payment_date, v_reference, v_note, v_actor)
  returning id into v_payment_id;
  -- Received reduces what the customer owes; a refund increases it.
  v_signed := case when v_direction = 'received' then -v_amount else v_amount end;
  insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
    reference_type, reference_id, entry_date, note, created_by)
  values (p_business_id, p_customer_id, 'payment', v_signed, 'payment', v_payment_id,
    p_payment_date, coalesce(v_note, v_reference), v_actor);
  perform private.lock_currency(p_business_id);
  select coalesce(sum(l.amount), 0) into v_outstanding
  from public.customer_ledger l where l.customer_id = p_customer_id;
  perform private.add_audit(p_business_id,
    case when v_direction = 'received' then 'payment.received' else 'payment.refunded' end,
    'payment', v_payment_id, jsonb_build_object('customer_id', p_customer_id, 'sale_id', p_sale_id,
      'amount', v_amount::text, 'method', v_method, 'payment_date', p_payment_date,
      'operation_id', p_operation_id));
  perform private.add_activity(p_business_id,
    case when v_direction = 'received' then 'payment.received' else 'payment.refunded' end,
    'payment', v_payment_id,
    case when v_direction = 'received' then 'Received a payment from ' else 'Refunded a payment to ' end
      || v_customer.name, v_signed);
  v_replay := jsonb_build_object('payment_id', v_payment_id, 'customer_id', p_customer_id,
    'currency', v_business.currency, 'scale', v_scale, 'direction', v_direction,
    'amount', v_amount::text, 'signed_amount', v_signed::text, 'payment_method', v_method,
    'payment_date', p_payment_date, 'customer_outstanding', private.round_money(v_outstanding, v_scale)::text,
    'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.void_payment(p_operation_id uuid, p_payment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_payment public.payments; v_scale integer;
  v_reason text := btrim(coalesce(p_reason, '')); v_signed numeric; v_outstanding numeric; v_replay jsonb;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found' using errcode = '42501'; end if;
  perform private.lock_business(v_payment.business_id);
  perform private.require_roles(v_payment.business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can void a payment');
  v_scale := private.money_scale(v_payment.currency);
  v_replay := private.begin_operation(v_payment.business_id, p_operation_id, 'payment.void');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'A reason of 1–200 characters is required to void a payment' using errcode = '22023';
  end if;
  if v_payment.status <> 'posted' then
    raise exception 'This payment is already voided' using errcode = '22023';
  end if;
  v_signed := case when v_payment.direction = 'received' then v_payment.amount else -v_payment.amount end;
  insert into public.customer_ledger(business_id, customer_id, entry_type, amount,
    reference_type, reference_id, entry_date, note, created_by)
  values (v_payment.business_id, v_payment.customer_id, 'payment_void', v_signed,
    'payment', v_payment.id, v_payment.payment_date, 'Voided: ' || left(v_reason, 180), v_actor);
  update public.payments set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = v_reason
  where id = v_payment.id;
  select coalesce(sum(l.amount), 0) into v_outstanding
  from public.customer_ledger l where l.customer_id = v_payment.customer_id;
  perform private.add_audit(v_payment.business_id, 'payment.voided', 'payment', v_payment.id,
    jsonb_build_object('reason', v_reason, 'amount', v_payment.amount::text,
      'direction', v_payment.direction, 'operation_id', p_operation_id));
  perform private.add_activity(v_payment.business_id, 'payment.voided', 'payment', v_payment.id,
    'Voided a payment', v_signed);
  v_replay := jsonb_build_object('payment_id', v_payment.id, 'voided', true,
    'currency', v_payment.currency, 'scale', v_scale,
    'amount', private.round_money(v_payment.amount, v_scale)::text,
    'customer_outstanding', private.round_money(v_outstanding, v_scale)::text, 'replayed', false);
  perform private.finish_operation(v_payment.business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.create_expense(p_operation_id uuid, p_business_id uuid, p_expense_date date,
  p_category text, p_amount text, p_payment_method public.payment_method,
  p_reference text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_scale integer; v_today date;
  v_category text := btrim(coalesce(p_category, '')); v_amount numeric; v_expense_id uuid;
  v_method public.payment_method := coalesce(p_payment_method, 'cash');
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_replay jsonb;
begin
  v_business := private.lock_business(p_business_id);
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can record expenses');
  v_scale := private.money_scale(v_business.currency);
  v_today := (now() at time zone v_business.timezone)::date;
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'expense.create');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_category) not between 1 and 60 then
    raise exception 'Category must be 1–60 characters' using errcode = '22023';
  end if;
  if v_method = 'credit' then
    raise exception 'Choose how the expense was paid. Credit purchases arrive with suppliers.'
      using errcode = '22023';
  end if;
  v_amount := private.round_money(private.require_decimal(p_amount, 'Amount'), v_scale);
  if v_amount <= 0 then raise exception 'Amount must be greater than zero' using errcode = '22023'; end if;
  if v_amount >= 100000000000000 then raise exception 'Amount is too large' using errcode = '22023'; end if;
  if p_expense_date is null then raise exception 'An expense date is required' using errcode = '22023'; end if;
  if p_expense_date > v_today + 1 then
    raise exception 'An expense cannot be dated in the future' using errcode = '22023';
  end if;
  if v_reference is not null and char_length(v_reference) > 60 then
    raise exception 'Reference must be at most 60 characters' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'Note must be at most 500 characters' using errcode = '22023';
  end if;
  insert into public.expenses(business_id, expense_date, category, amount, payment_method,
    currency, reference, note, created_by)
  values (p_business_id, p_expense_date, left(v_category, 60), v_amount, v_method,
    v_business.currency, v_reference, v_note, v_actor)
  returning id into v_expense_id;
  perform private.lock_currency(p_business_id);
  perform private.add_audit(p_business_id, 'expense.created', 'expense', v_expense_id,
    jsonb_build_object('expense_date', p_expense_date, 'category', v_category, 'amount', v_amount::text,
      'method', v_method, 'currency', v_business.currency, 'operation_id', p_operation_id));
  perform private.add_activity(p_business_id, 'expense.created', 'expense', v_expense_id,
    'Recorded an expense in ' || left(v_category, 60), -v_amount);
  v_replay := jsonb_build_object('expense_id', v_expense_id, 'currency', v_business.currency,
    'scale', v_scale, 'expense_date', p_expense_date, 'category', left(v_category, 60),
    'amount', v_amount::text, 'payment_method', v_method, 'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

create function public.void_expense(p_operation_id uuid, p_expense_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_expense public.expenses; v_reason text := btrim(coalesce(p_reason, ''));
  v_scale integer; v_replay jsonb;
begin
  select * into v_expense from public.expenses where id = p_expense_id for update;
  if not found then raise exception 'Expense not found' using errcode = '42501'; end if;
  perform private.lock_business(v_expense.business_id);
  perform private.require_roles(v_expense.business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can void an expense');
  v_scale := private.money_scale(v_expense.currency);
  v_replay := private.begin_operation(v_expense.business_id, p_operation_id, 'expense.void');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'A reason of 1–200 characters is required to void an expense' using errcode = '22023';
  end if;
  if v_expense.status <> 'posted' then
    raise exception 'This expense is already voided' using errcode = '22023';
  end if;
  update public.expenses set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = v_reason
  where id = v_expense.id;
  perform private.add_audit(v_expense.business_id, 'expense.voided', 'expense', v_expense.id,
    jsonb_build_object('reason', v_reason, 'amount', v_expense.amount::text,
      'operation_id', p_operation_id));
  perform private.add_activity(v_expense.business_id, 'expense.voided', 'expense', v_expense.id,
    'Voided an expense', v_expense.amount);
  v_replay := jsonb_build_object('expense_id', v_expense.id, 'voided', true,
    'currency', v_expense.currency, 'scale', v_scale,
    'amount', private.round_money(v_expense.amount, v_scale)::text, 'replayed', false);
  perform private.finish_operation(v_expense.business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

-- Credit/debit note on a khata account: goods returned without a stock effect,
-- rounding corrections, or a bad-debt write-off. A reason is mandatory so the
-- adjustment is explainable in the statement and the audit log.
create function public.record_customer_adjustment(p_operation_id uuid, p_business_id uuid,
  p_customer_id uuid, p_amount text, p_reason text, p_entry_date date default null,
  p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_business public.businesses; v_scale integer; v_today date;
  v_amount numeric; v_reason text := btrim(coalesce(p_reason, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_entry_id uuid := gen_random_uuid(); v_outstanding numeric; v_replay jsonb; v_date date;
begin
  v_business := private.lock_business(p_business_id);
  perform private.require_roles(p_business_id,
    array['owner','co_owner','manager','accountant']::public.business_role[],
    'Only owners, managers and accountants can adjust a khata balance');
  v_scale := private.money_scale(v_business.currency);
  v_today := (now() at time zone v_business.timezone)::date;
  v_replay := private.begin_operation(p_business_id, p_operation_id, 'customer.adjust');
  if v_replay is not null then return v_replay || '{"replayed": true}'::jsonb; end if;
  v_amount := private.round_money(private.require_decimal(p_amount, 'Amount'), v_scale);
  if v_amount = 0 then raise exception 'Amount must not be zero' using errcode = '22023'; end if;
  if abs(v_amount) >= 100000000000000 then raise exception 'Amount is too large' using errcode = '22023'; end if;
  if char_length(v_reason) not between 1 and 200 then
    raise exception 'A reason of 1–200 characters is required' using errcode = '22023';
  end if;
  v_date := coalesce(p_entry_date, v_today);
  if v_date > v_today + 1 then raise exception 'The date cannot be in the future' using errcode = '22023'; end if;
  perform id from public.customers where id = p_customer_id and business_id = p_business_id for update;
  if not found then raise exception 'Customer not found in this business' using errcode = '42501'; end if;
  insert into public.customer_ledger(id, business_id, customer_id, entry_type, amount,
    reference_type, reference_id, entry_date, note, created_by)
  values (v_entry_id, p_business_id, p_customer_id, 'adjustment', v_amount,
    'adjustment', v_entry_id, v_date, left(v_reason || coalesce(' · ' || v_note, ''), 300), v_actor);
  perform private.lock_currency(p_business_id);
  select coalesce(sum(l.amount), 0) into v_outstanding
  from public.customer_ledger l where l.customer_id = p_customer_id;
  perform private.add_audit(p_business_id,
    case when v_amount > 0 then 'customer.debit_note' else 'customer.credit_note' end,
    'customer', p_customer_id, jsonb_build_object('amount', v_amount::text, 'reason', v_reason,
      'entry_date', v_date, 'ledger_id', v_entry_id, 'operation_id', p_operation_id));
  perform private.add_activity(p_business_id,
    case when v_amount > 0 then 'customer.debit_note' else 'customer.credit_note' end,
    'customer', p_customer_id, left('Adjusted the khata: ' || v_reason, 240), v_amount);
  v_replay := jsonb_build_object('ledger_id', v_entry_id, 'customer_id', p_customer_id,
    'currency', v_business.currency, 'scale', v_scale, 'amount', v_amount::text,
    'entry_date', v_date, 'customer_outstanding', private.round_money(v_outstanding, v_scale)::text,
    'replayed', false);
  perform private.finish_operation(p_business_id, p_operation_id, v_replay);
  return v_replay;
end;
$$;

-- ---------------------------------------------------------------------------
-- Currency lock. Phase 2 left this guard as a documented TODO; it is enforced now
-- that financial history exists.
-- ---------------------------------------------------------------------------
create or replace function public.update_business_settings(p_business_id uuid, p_name text,
  p_currency text, p_timezone text, p_co_owners_can_invite boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_name text := btrim(p_name); v_before jsonb; v_current text;
begin
  perform id from public.businesses where id = p_business_id for update;
  if not found or not private.has_role(p_business_id, array['owner']::public.business_role[]) then
    raise exception 'Owner permission required' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 120 then
    raise exception 'Business name must be 1–120 characters' using errcode = '22023';
  end if;
  if not private.validate_timezone(p_timezone) or not exists (select 1 from public.currencies where code = p_currency) then
    raise exception 'Invalid timezone or currency' using errcode = '22023';
  end if;
  if p_co_owners_can_invite is null then raise exception 'Invalid invitation setting' using errcode = '22023'; end if;
  select currency into v_current from public.businesses where id = p_business_id;
  if v_current <> p_currency then
    -- Mixing currencies inside one set of books would make every total meaningless.
    if exists (select 1 from public.businesses where id = p_business_id and currency_locked_at is not null)
      or private.has_financial_activity(p_business_id) then
      raise exception 'The currency is locked because this business already has financial records. Create a new business for a different currency.'
        using errcode = '22023';
    end if;
  end if;
  select to_jsonb(b) - 'updated_at' into v_before from public.businesses b where id = p_business_id;
  update public.businesses set name = v_name, currency = p_currency, timezone = p_timezone,
    co_owners_can_invite = p_co_owners_can_invite where id = p_business_id;
  perform private.add_audit(p_business_id, 'business.settings_changed', 'business', p_business_id,
    jsonb_build_object('before', v_before, 'after', jsonb_build_object('name', v_name, 'currency', p_currency,
      'timezone', p_timezone, 'co_owners_can_invite', p_co_owners_can_invite), 'actor', v_actor));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Explicit, authenticated-only, and revoked from public/anon first.
-- ---------------------------------------------------------------------------
revoke all on function public.list_customers(uuid, text, boolean, integer, integer) from public, anon;
revoke all on function public.list_products(uuid, text, boolean, integer, integer) from public, anon;
revoke all on function public.list_sales(uuid, uuid, date, date, public.document_status, integer, integer) from public, anon;
revoke all on function public.list_payments(uuid, uuid, date, date, public.document_status, integer, integer) from public, anon;
revoke all on function public.list_expenses(uuid, date, date, text, public.document_status, integer, integer) from public, anon;
revoke all on function public.expense_categories(uuid) from public, anon;
revoke all on function public.list_activity(uuid, integer, timestamptz) from public, anon;
revoke all on function public.customer_statement(uuid, date, date, integer) from public, anon;
revoke all on function public.customer_balance(uuid) from public, anon;
revoke all on function public.period_summary(uuid, date, date) from public, anon;
revoke all on function public.balance_summary(uuid) from public, anon;
revoke all on function public.save_customer(uuid, uuid, uuid, text, text, text, text, text) from public, anon;
revoke all on function public.archive_customer(uuid, boolean) from public, anon;
revoke all on function public.save_product(uuid, uuid, uuid, text, text, text, text, text) from public, anon;
revoke all on function public.create_sale(uuid, uuid, uuid, date, public.payment_method, text, jsonb, text, text) from public, anon;
revoke all on function public.void_sale(uuid, uuid, text) from public, anon;
revoke all on function public.record_payment(uuid, uuid, uuid, uuid, public.payment_direction, text, public.payment_method, date, text, text) from public, anon;
revoke all on function public.void_payment(uuid, uuid, text) from public, anon;
revoke all on function public.create_expense(uuid, uuid, date, text, text, public.payment_method, text, text) from public, anon;
revoke all on function public.void_expense(uuid, uuid, text) from public, anon;
revoke all on function public.record_customer_adjustment(uuid, uuid, uuid, text, text, date, text) from public, anon;

grant execute on function public.list_customers(uuid, text, boolean, integer, integer) to authenticated;
grant execute on function public.list_products(uuid, text, boolean, integer, integer) to authenticated;
grant execute on function public.list_sales(uuid, uuid, date, date, public.document_status, integer, integer) to authenticated;
grant execute on function public.list_payments(uuid, uuid, date, date, public.document_status, integer, integer) to authenticated;
grant execute on function public.list_expenses(uuid, date, date, text, public.document_status, integer, integer) to authenticated;
grant execute on function public.expense_categories(uuid) to authenticated;
grant execute on function public.list_activity(uuid, integer, timestamptz) to authenticated;
grant execute on function public.customer_statement(uuid, date, date, integer) to authenticated;
grant execute on function public.customer_balance(uuid) to authenticated;
grant execute on function public.period_summary(uuid, date, date) to authenticated;
grant execute on function public.balance_summary(uuid) to authenticated;
grant execute on function public.save_customer(uuid, uuid, uuid, text, text, text, text, text) to authenticated;
grant execute on function public.archive_customer(uuid, boolean) to authenticated;
grant execute on function public.save_product(uuid, uuid, uuid, text, text, text, text, text) to authenticated;
grant execute on function public.create_sale(uuid, uuid, uuid, date, public.payment_method, text, jsonb, text, text) to authenticated;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;
grant execute on function public.record_payment(uuid, uuid, uuid, uuid, public.payment_direction, text, public.payment_method, date, text, text) to authenticated;
grant execute on function public.void_payment(uuid, uuid, text) to authenticated;
grant execute on function public.create_expense(uuid, uuid, date, text, text, public.payment_method, text, text) to authenticated;
grant execute on function public.void_expense(uuid, uuid, text) to authenticated;
grant execute on function public.record_customer_adjustment(uuid, uuid, uuid, text, text, date, text) to authenticated;

create or replace function public.ownerbook_health()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('service', 'ownerbook', 'schema_version', 3, 'database_time', statement_timestamp());
$$;

commit;
