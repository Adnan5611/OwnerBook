-- Behavioural acceptance checks for a deployed OwnerBook project.
--
-- This is the hosted counterpart of scripts/test-ledger.ts. It runs the real
-- RPCs against a real Supabase database (real auth.uid(), real RLS, real
-- Postgres roles) and asserts the accounting contract end to end.
--
-- Every row it writes is rolled back: all work happens inside a PL/pgSQL block
-- whose changes are discarded by a deliberate exception, while the results array
-- survives because PL/pgSQL variables are not part of the subtransaction. The
-- financial immutability triggers block DELETE even for the table owner, so this
-- is the only way to test a live project without permanently polluting it.
--
-- Run it with: npm run fingerprint -- scripts/sql/hosted-acceptance.sql
-- (locally) or by executing the file against the project (hosted).
do $hosted$
declare
  results text[] := '{}';
  v_owner uuid;
  v_other uuid;
  v_business uuid;
  v_other_business uuid;
  v_customer uuid;
  v_product uuid;
  v_op uuid;
  v_sale jsonb;
  v_replay jsonb;
  v_pay jsonb;
  v_payment_id uuid;
  v_void jsonb;
  v_expense jsonb;
  v_stmt jsonb;
  v_bal jsonb;
  v_period jsonb;
  v_balance jsonb;
  v_health jsonb;
  v_count bigint;
  v_sum numeric;
  v_last numeric;
  v_err text;
begin
  begin
    ------------------------------------------------------------------ setup
    v_owner := gen_random_uuid();
    v_other := gen_random_uuid();
    insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
      (v_owner, 'hosted-owner@ownerbook.test', now(), jsonb_build_object('display_name', 'Hosted Owner')),
      (v_other, 'hosted-other@ownerbook.test', now(), jsonb_build_object('display_name', 'Hosted Other'));

    select count(*) into v_count from public.profiles where id in (v_owner, v_other);
    results := array_append(results, case when v_count = 2
      then 'PASS auth.users insert fires the profile trigger for both users'
      else 'FAIL profile trigger created ' || v_count || ' of 2 profiles' end);

    execute 'set local role authenticated';
    perform set_config('request.jwt.claim.sub', v_owner::text, true);

    v_business := public.create_business('Hosted Acceptance Traders', 'PKR', 'Asia/Karachi');
    results := array_append(results, case when v_business is not null
      then 'PASS create_business returns an id as an authenticated owner'
      else 'FAIL create_business returned null' end);

    select count(*) into v_count from public.business_members
      where business_id = v_business and user_id = v_owner and role = 'owner';
    results := array_append(results, case when v_count = 1
      then 'PASS the creator is recorded as the business owner'
      else 'FAIL owner membership row missing' end);

    ------------------------------------------------------------------ khata
    v_op := gen_random_uuid();
    select public.save_customer(v_op, v_business, null, 'Hosted Customer', '03001234567',
      null, null, '500.00') into v_bal;
    v_customer := (v_bal ->> 'customer_id')::uuid;
    results := array_append(results, case when (v_bal ->> 'replayed')::boolean is false and v_customer is not null
      then 'PASS save_customer creates the khata with an opening balance'
      else 'FAIL save_customer result: ' || v_bal::text end);

    -- Same operation id must replay instead of creating a second customer.
    select public.save_customer(v_op, v_business, null, 'Hosted Customer', '03001234567',
      null, null, '500.00') into v_replay;
    select count(*) into v_count from public.customers where business_id = v_business;
    results := array_append(results, case when (v_replay ->> 'replayed')::boolean and v_count = 1
      then 'PASS a repeated operation id replays instead of duplicating the customer'
      else 'FAIL idempotency: replayed=' || coalesce(v_replay ->> 'replayed', 'null')
        || ' customers=' || v_count end);

    select public.customer_balance(v_customer) into v_bal;
    results := array_append(results, case when v_bal ->> 'outstanding' = '500.00'
        and v_bal ->> 'customer_name' = 'Hosted Customer'
      then 'PASS customer_balance reports the opening balance and the account name'
      else 'FAIL customer_balance: ' || v_bal::text end);

    ------------------------------------------------------------------ catalog
    select public.save_product(gen_random_uuid(), v_business, null, 'Hosted Rice', 'SKU-1',
      'kg', '199.999', '100') into v_bal;
    v_product := (v_bal ->> 'product_id')::uuid;
    results := array_append(results, case when v_product is not null
      then 'PASS save_product stores a four-decimal unit price'
      else 'FAIL save_product: ' || v_bal::text end);

    ------------------------------------------------------------------- sale
    v_op := gen_random_uuid();
    select public.create_sale(v_op, v_business, v_customer, current_date, 'credit', '0',
      jsonb_build_array(
        -- No unit_price/unit_cost: the catalog values must be snapshotted.
        jsonb_build_object('product_id', v_product, 'quantity', '1.5'),
        jsonb_build_object('item_name', 'Custom widget', 'quantity', '2',
          'unit_price', '50.25', 'discount', '0.50', 'unit_cost', '30')),
      null, null) into v_sale;

    results := array_append(results, case
      when v_sale ->> 'subtotal' = '400.50' and v_sale ->> 'discount_total' = '0.50'
        and v_sale ->> 'total' = '400.00' and v_sale ->> 'cogs' = '210.00'
        and v_sale ->> 'due' = '400.00' and v_sale ->> 'customer_outstanding' = '900.00'
      then 'PASS create_sale rounds 1.5 x 199.999 to 300.00 and reports exact totals'
      else 'FAIL create_sale amounts: ' || v_sale::text end);

    select public.create_sale(v_op, v_business, v_customer, current_date, 'credit', '0',
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', '1.5'),
        jsonb_build_object('item_name', 'Custom widget', 'quantity', '2',
          'unit_price', '50.25', 'discount', '0.50', 'unit_cost', '30')),
      null, null) into v_replay;
    select count(*) into v_count from public.sales where business_id = v_business;
    results := array_append(results, case when (v_replay ->> 'replayed')::boolean and v_count = 1
      then 'PASS a repeated sale operation id cannot double-post revenue'
      else 'FAIL sale idempotency: sales=' || v_count end);

    --------------------------------------------------------------- payments
    select public.record_payment(gen_random_uuid(), v_business, v_customer,
      (v_sale ->> 'sale_id')::uuid, 'received', '100.00', 'cash', current_date, null, null) into v_pay;
    results := array_append(results, case when v_pay ->> 'customer_outstanding' = '800.00'
      then 'PASS a partial payment reduces the outstanding balance exactly'
      else 'FAIL record_payment: ' || v_pay::text end);
    -- Captured before the advance/refund pair below reuses v_pay, so the void
    -- targets this payment and not the refund.
    v_payment_id := (v_pay ->> 'payment_id')::uuid;

    select public.record_payment(gen_random_uuid(), v_business, v_customer, null,
      'received', '99999.00', 'cash', current_date, null, null) into v_pay;
    results := array_append(results, case when v_pay ->> 'customer_outstanding' = '-99199.00'
      then 'PASS an overpayment becomes an exact visible customer advance, never lost money'
      else 'FAIL advance: ' || coalesce(v_pay ->> 'customer_outstanding', 'null') end);

    select public.record_payment(gen_random_uuid(), v_business, v_customer, null,
      'refunded', '99999.00', 'cash', current_date, null, null) into v_pay;
    results := array_append(results, case when v_pay ->> 'customer_outstanding' = '800.00'
      then 'PASS refunding the advance settles the khata back to exactly 800.00'
      else 'FAIL refund: ' || coalesce(v_pay ->> 'customer_outstanding', 'null') end);

    select public.void_payment(gen_random_uuid(), v_payment_id,
      'Hosted acceptance reversal') into v_void;
    select public.customer_balance(v_customer) into v_bal;
    results := array_append(results, case when v_bal ->> 'outstanding' = '900.00'
      then 'PASS voiding a payment appends a reversing entry and restores the balance'
      else 'FAIL void_payment balance: ' || v_bal::text end);

    select count(*) into v_count from public.payments
      where business_id = v_business and status = 'voided';
    results := array_append(results, case when v_count = 1
      then 'PASS a voided payment is kept as a document, not deleted'
      else 'FAIL voided payment count ' || v_count end);

    -------------------------------------------------------------- expenses
    select public.create_expense(gen_random_uuid(), v_business, current_date, 'Rent',
      '250.75', 'cash', null, null) into v_expense;
    select public.period_summary(v_business, current_date - 30, current_date + 2) into v_period;
    results := array_append(results, case
      when v_period ->> 'revenue' = '400.00' and v_period ->> 'cogs' = '210.00'
        and v_period ->> 'expense_total' = '250.75' and v_period ->> 'net_profit' = '-60.75'
      then 'PASS net profit = revenue - COGS - expenses (400.00 - 210.00 - 250.75)'
      else 'FAIL period_summary: ' || v_period::text end);

    ---------------------------------------------------- exact decimal sums
    for i in 1 .. 3 loop
      perform public.record_customer_adjustment(gen_random_uuid(), v_business, v_customer,
        '0.10', 'Hosted decimal check', current_date, null);
    end loop;
    select public.customer_balance(v_customer) into v_bal;
    results := array_append(results, case when v_bal ->> 'outstanding' = '900.30'
      then 'PASS three 0.10 adjustments sum to exactly 0.30 (no binary floating point)'
      else 'FAIL decimal accumulation: ' || v_bal::text end);

    ----------------------------------------------------------------- voids
    select public.void_sale(gen_random_uuid(), (v_sale ->> 'sale_id')::uuid,
      'Hosted acceptance void') into v_void;
    select public.customer_balance(v_customer) into v_bal;
    select public.period_summary(v_business, current_date - 30, current_date + 2) into v_period;
    results := array_append(results, case
      when v_bal ->> 'outstanding' = '500.30' and v_period ->> 'revenue' = '0.00'
        and v_period ->> 'net_profit' = '-250.75'
      then 'PASS voiding a sale removes its revenue and COGS but keeps the expense'
      else 'FAIL after void: balance=' || coalesce(v_bal ->> 'outstanding', 'null')
        || ' revenue=' || coalesce(v_period ->> 'revenue', 'null')
        || ' profit=' || coalesce(v_period ->> 'net_profit', 'null') end);

    ------------------------------------------------------- statement math
    select public.customer_statement(v_customer, current_date - 30, current_date + 2, 500) into v_stmt;
    select coalesce(sum((e ->> 'amount')::numeric), 0) into v_sum
      from jsonb_array_elements(v_stmt -> 'entries') as e;
    select (t.e ->> 'running_balance')::numeric into v_last
      from jsonb_array_elements(v_stmt -> 'entries') with ordinality as t(e, ord)
      order by ord desc limit 1;
    results := array_append(results, case
      when v_sum = (v_bal ->> 'outstanding')::numeric and v_last = v_sum
        and (v_stmt ->> 'closing_outstanding')::numeric = v_sum
      then 'PASS statement running balances equal the exact cumulative ledger sum'
      else 'FAIL statement sum=' || v_sum::text || ' last=' || coalesce(v_last::text, 'null')
        || ' closing=' || coalesce(v_stmt ->> 'closing_outstanding', 'null') end);

    --------------------------------------------------------- currency lock
    begin
      perform public.update_business_settings(v_business, 'Hosted Acceptance Traders',
        'USD', 'Asia/Karachi', false);
      results := array_append(results, 'FAIL the currency was changed after financial history existed');
    exception when others then
      results := array_append(results, case when sqlstate in ('22023', '23514')
        then 'PASS the currency is locked once financial history exists (' || sqlstate || ')'
        else 'FAIL currency change raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    ------------------------------------------------------------- activity
    select count(*) into v_count from public.list_activity(v_business, 50, null);
    results := array_append(results, case when v_count >= 5
      then 'PASS every financial write produced an activity row (' || v_count || ')'
      else 'FAIL activity rows ' || coalesce(v_count::text, 'null') end);

    ------------------------------------------- client privileges and RLS
    begin
      insert into public.customers (business_id, name, created_by)
        values (v_business, 'Direct insert', v_owner);
      results := array_append(results, 'FAIL a direct table insert succeeded for an authenticated client');
    exception when others then
      results := array_append(results, case when sqlstate = '42501'
        then 'PASS an authenticated client has no INSERT privilege on customers (42501)'
        else 'FAIL direct insert raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    begin
      update public.sales set total = 0;
      results := array_append(results, 'FAIL an authenticated client updated sales');
    exception when others then
      results := array_append(results, case when sqlstate = '42501'
        then 'PASS an authenticated client has no UPDATE privilege on sales (42501)'
        else 'FAIL direct update raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    -- Switch to a user who is not a member of this business.
    perform set_config('request.jwt.claim.sub', v_other::text, true);
    v_other_business := public.create_business('Hosted Other Traders', 'PKR', 'Asia/Karachi');

    begin
      perform count(*) from public.list_customers(v_business, null, false, 200, 0);
      results := array_append(results, 'FAIL a non-member could list another business customers');
    exception when others then
      results := array_append(results, case when sqlstate = '42501'
        then 'PASS list_customers refuses a non-member outright (42501), not just via RLS'
        else 'FAIL non-member list raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    begin
      perform public.customer_balance(v_customer);
      results := array_append(results, 'FAIL a non-member read another business customer balance');
    exception when others then
      results := array_append(results, case when sqlstate in ('42501', '22023', 'P0002')
        then 'PASS customer_balance refuses a non-member (' || sqlstate || ')'
        else 'FAIL non-member balance raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    begin
      perform public.save_customer(gen_random_uuid(), v_business, null, 'Intruder',
        null, null, null, '0');
      results := array_append(results, 'FAIL a non-member wrote into another business');
    exception when others then
      results := array_append(results, case when sqlstate in ('42501', '22023', 'P0002')
        then 'PASS save_customer refuses a non-member of the target business (' || sqlstate || ')'
        else 'FAIL non-member write raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    -- The owner must not see the other business either.
    perform set_config('request.jwt.claim.sub', v_owner::text, true);
    begin
      perform count(*) from public.list_customers(v_other_business, null, false, 200, 0);
      results := array_append(results, 'FAIL the owner could list a foreign business');
    exception when others then
      results := array_append(results, case when sqlstate = '42501'
        then 'PASS isolation is symmetric: the owner is refused on a foreign business (42501)'
        else 'FAIL foreign list raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    ------------------------------------------------------- immutability
    execute 'reset role';
    begin
      update public.customer_ledger set amount = 0 where business_id = v_business;
      results := array_append(results, 'FAIL a ledger row was updated by the table owner');
    exception when others then
      results := array_append(results, case when sqlstate in ('42501', '22023', 'P0002')
        then 'PASS the ledger rejects UPDATE even for the table owner (' || sqlstate || ')'
        else 'FAIL ledger update raised ' || sqlstate || ': ' || sqlerrm end);
    end;

    ------------------------------------------------------------ health
    v_health := public.ownerbook_health();
    results := array_append(results, case when v_health ->> 'schema_version' = '3'
        and v_health ->> 'service' = 'ownerbook'
      then 'PASS ownerbook_health reports schema version 3 on the hosted project'
      else 'FAIL health: ' || coalesce(v_health::text, 'null') end);

    -- Discard every row written above. Financial triggers block DELETE even for
    -- the owner, so a rollback is the only clean way to leave no trace.
    raise exception 'OWNERBOOK_ROLLBACK_TEST_DATA' using errcode = '22023';
  exception when others then
    v_err := sqlerrm;
    if v_err <> 'OWNERBOOK_ROLLBACK_TEST_DATA' then
      results := array_append(results, 'FAIL the acceptance run aborted: ' || sqlstate || ': ' || v_err);
    end if;
  end;

  execute 'reset role';
  drop table if exists _hosted_acceptance;
  create temp table _hosted_acceptance as
    select t.n, t.line from unnest(results) with ordinality as t(line, n);
end
$hosted$;

-- Read by the local runner. The hosted wrapper issues its own select because
-- EXECUTE inside PL/pgSQL discards row results.
select count(*) as checks,
       count(*) filter (where line like 'PASS%') as passed,
       count(*) filter (where line like 'FAIL%') as failed,
       coalesce(string_agg(line, E'\n' order by n), '') as results
from _hosted_acceptance
