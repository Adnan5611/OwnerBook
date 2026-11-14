import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { withPostgres } from './lib/pg-harness';

/**
 * Phase 3 suite: customers, khata ledger, sales, payments and expenses.
 *
 * Everything here runs against a real PostgreSQL 17 server with the real
 * migrations, the real Supabase role layout and a real `auth.uid()`. It proves
 * exact decimal arithmetic, idempotent posting, ledger/document reconciliation,
 * role permissions, tenant isolation and the currency lock. It does NOT prove
 * hosted Supabase Auth, PostgREST, Realtime or Storage behaviour, and it does not
 * produce an APK.
 */
type Json = Record<string, unknown>;
const FINANCIAL_TABLES = [
  'customers',
  'products',
  'sales',
  'sale_items',
  'payments',
  'expenses',
  'customer_ledger',
  'activity_logs',
  'operation_receipts',
];
const READ_MODELS = [
  'list_customers',
  'list_products',
  'list_sales',
  'list_payments',
  'list_expenses',
  'expense_categories',
  'list_activity',
  'customer_statement',
  'customer_balance',
  'period_summary',
  'balance_summary',
];
const WRITE_MODELS = [
  'save_customer',
  'archive_customer',
  'save_product',
  'create_sale',
  'void_sale',
  'record_payment',
  'void_payment',
  'create_expense',
  'void_expense',
  'record_customer_adjustment',
];

/** Exact 2-decimal string arithmetic, so the assertions never use binary floats. */
function cents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Not an exact 2-decimal amount: ${value}`);
  const whole = match[2];
  if (whole === undefined) throw new Error(`Not an exact 2-decimal amount: ${value}`);
  const fraction = match[3] ?? '';
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return match[1] === '-' ? -magnitude : magnitude;
}
function fromCents(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  return `${sign}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
}

function fnName(signature: string): string {
  const match = /(?:public\.)?(\w+)\(/.exec(signature);
  const name = match?.[1];
  if (!name) throw new Error(`Bad RPC signature: ${signature}`);
  return name;
}

async function main() {
  await withPostgres(
    async (h) => {
      const { ok, equal, denied, deniedWith, admin, actor } = h;
      const rows = async (client: Client, sql: string, params: unknown[] = []) =>
        (await client.query(sql, params)).rows;
      const scalar = async (client: Client, sql: string, params: unknown[] = []) => {
        const result = await rows(client, sql, params);
        return result[0] ? Object.values(result[0])[0] : undefined;
      };
      /** Calls an RPC the way the mobile app does and returns its jsonb payload. */
      const json = async (client: Client, signature: string, args: unknown[]): Promise<Json> => {
        const result = await rows(client, `select * from ${signature}`, args);
        return result[0][fnName(signature)] as Json;
      };
      const list = (client: Client, signature: string, args: unknown[]) =>
        rows(client, `select * from ${signature}`, args);
      const invite = async (
        businessId: string,
        inviter: Client,
        member: Client,
        role: string,
      ): Promise<void> => {
        const created = await json(inviter, 'public.create_invitation($1,$2,$3,$4)', [
          businessId,
          role,
          null,
          24,
        ]);
        await rows(member, 'select public.accept_invitation($1)', [created.token]);
      };
      const items = (lines: Record<string, unknown>[]) => JSON.stringify(lines);
      // Derived from the server clock so the suite never depends on the sandbox date.
      const today = (await scalar(
        admin,
        "select (now() at time zone 'Asia/Karachi')::date::text",
      )) as string;
      const monthStart = (await scalar(admin, "select date_trunc('month', $1::date)::date::text", [
        today,
      ])) as string;
      const monthEnd = (await scalar(
        admin,
        "select (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text",
        [today],
      )) as string;

      console.log('\nPhase 3 · schema guarantees');
      const ids: Record<string, string> = {};
      for (const name of [
        'owner',
        'coowner',
        'manager',
        'accountant',
        'staff',
        'clerk',
        'outsider',
        'rivalOwner',
      ]) {
        ids[name] = await h.createUser(name);
      }
      const clients: Record<string, Client> = {};
      for (const [name, id] of Object.entries(ids)) clients[name] = await actor(id);
      // A second connection for the same user: needed to prove that one operation
      // id submitted twice stores one document, without tripping the session guard.
      const clerkSecond = await actor(ids.clerk);
      const anon = await actor();

      equal(
        (
          await rows(
            admin,
            `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
               and c.relname = any($1::text[])`,
            [FINANCIAL_TABLES],
          )
        ).length,
        FINANCIAL_TABLES.length,
        'Row level security is on every financial table',
      );
      const writable: string[] = [];
      for (const table of FINANCIAL_TABLES) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
          if (
            await scalar(admin, 'select has_table_privilege($1,$2,$3)', [
              'authenticated',
              `public.${table}`,
              privilege,
            ])
          )
            writable.push(`${table}:${privilege}`);
        }
      }
      equal(writable.length, 0, 'Clients hold no direct write privilege on any financial table');
      equal(
        await scalar(admin, 'select has_table_privilege($1,$2,$3)', [
          'anon',
          'public.sales',
          'SELECT',
        ]),
        false,
        'Anonymous callers cannot read financial tables',
      );
      equal(
        await scalar(
          admin,
          "select count(*)::int from pg_policies where schemaname='public' and tablename='operation_receipts'",
        ),
        0,
        'Idempotency receipts have no client policy at all',
      );
      equal(
        await scalar(
          admin,
          `select count(*)::int from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
           join pg_type t on t.oid = a.atttypid
           where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
             and t.typname in ('float4','float8')`,
        ),
        0,
        'No binary floating point column exists anywhere in the schema',
      );
      const moneyColumns = await rows(
        admin,
        `select a.attname, format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1::text[])
           and a.attnum > 0 and not a.attisdropped
           and format_type(a.atttypid, a.atttypmod) like 'numeric%'`,
        [FINANCIAL_TABLES],
      );
      ok(
        moneyColumns.length >= 12 &&
          moneyColumns.every((column) => /^numeric\(18,[34]\)$/.test(column.type as string)),
        `Every money column is exact numeric (${moneyColumns.length} columns)`,
      );
      equal(
        await scalar(
          admin,
          `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1::text[]) and p.prosecdef`,
          [READ_MODELS],
        ),
        0,
        'Read models never elevate privileges, so RLS is enforced inside them too',
      );
      equal(
        await scalar(
          admin,
          `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1::text[])
             and (not p.prosecdef or not p.proconfig @> array['search_path=""'])`,
          [WRITE_MODELS],
        ),
        0,
        'Every financial write RPC is a definer function with a pinned empty search path',
      );
      equal(
        await scalar(
          admin,
          `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname <> 'ownerbook_health'
             and has_function_privilege('anon', p.oid, 'execute')`,
        ),
        0,
        'Anonymous callers cannot execute any Phase 3 RPC',
      );
      await denied(
        anon,
        'select * from public.list_customers($1)',
        [randomUUID()],
        'Anonymous customer listing denied',
      );

      console.log('\nPhase 3 · tenants, members and roles');
      const business = (await scalar(clients.owner!, 'select public.create_business($1,$2,$3)', [
        'Alpha Traders',
        'PKR',
        'Asia/Karachi',
      ])) as string;
      const rivalBusiness = (await scalar(
        clients.rivalOwner!,
        'select public.create_business($1,$2,$3)',
        ['Beta Books', 'USD', 'UTC'],
      )) as string;
      const yenBusiness = (await scalar(clients.owner!, 'select public.create_business($1,$2,$3)', [
        'Tokyo Store',
        'JPY',
        'Asia/Tokyo',
      ])) as string;
      const dinarBusiness = (await scalar(
        clients.owner!,
        'select public.create_business($1,$2,$3)',
        ['Kuwait Store', 'KWD', 'Asia/Kuwait'],
      )) as string;
      await invite(business, clients.owner!, clients.coowner!, 'co_owner');
      await invite(business, clients.owner!, clients.manager!, 'manager');
      await invite(business, clients.owner!, clients.accountant!, 'accountant');
      await invite(business, clients.owner!, clients.staff!, 'staff');
      await invite(business, clients.owner!, clients.clerk!, 'staff');
      await invite(rivalBusiness, clients.rivalOwner!, clients.outsider!, 'manager');
      equal(
        (
          await rows(clients.staff!, 'select 1 from public.business_members where business_id=$1', [
            business,
          ])
        ).length,
        6,
        'Every invited role is an active member of the trading business',
      );

      const customer = async (
        client: Client,
        businessId: string,
        name: string,
        opening = '0',
        phone: string | null = null,
      ): Promise<string> =>
        (
          await json(client, 'public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)', [
            randomUUID(),
            businessId,
            null,
            name,
            phone,
            null,
            null,
            opening,
          ])
        ).customer_id as string;
      const postSale = (
        client: Client,
        args: {
          businessId?: string;
          customerId?: string | null;
          date?: string;
          method?: string;
          paid?: string;
          lines: Record<string, unknown>[];
          operationId?: string;
        },
      ) =>
        json(client, 'public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
          args.operationId ?? randomUUID(),
          args.businessId ?? business,
          args.customerId === undefined ? null : args.customerId,
          args.date ?? today,
          args.method ?? 'cash',
          args.paid ?? '0',
          items(args.lines),
          null,
          null,
        ]);
      const pay = (client: Client, args: Record<string, unknown>) =>
        json(client, 'public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
          args.operationId ?? randomUUID(),
          args.businessId ?? business,
          args.customerId,
          args.saleId ?? null,
          args.direction ?? 'received',
          args.amount,
          args.method ?? 'cash',
          args.date ?? today,
          args.reference ?? null,
          args.note ?? null,
        ]);

      console.log('\nPhase 3 · customer records and input validation');
      const ali = await customer(clients.owner!, business, 'Ali Khan', '1500.50', '+923001234567');
      equal(
        (await json(clients.owner!, 'public.customer_balance($1)', [ali])).outstanding,
        '1500.50',
        'An opening balance is posted to the khata, not stored as a loose number',
      );
      equal(
        await scalar(
          admin,
          'select count(*)::int from public.customer_ledger where customer_id=$1',
          [ali],
        ),
        1,
        'The opening balance produced exactly one ledger entry',
      );
      const bilal = await customer(clients.staff!, business, 'Bilal Ahmed');
      ok(bilal.length === 36, 'Staff can open a customer khata at the counter');
      equal(
        (await json(clients.staff!, 'public.customer_balance($1)', [bilal])).outstanding,
        '0.00',
        'A new khata starts at exactly zero',
      );
      await deniedWith(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, null, 'Duplicate Phone', '+923001234567', null, null, '0'],
        '23505',
        'A duplicate customer phone inside one business is rejected',
      );
      await denied(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, null, 'Bad Phone', 'not-a-phone', null, null, '0'],
        'An invalid phone number is rejected',
      );
      await denied(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, null, '   ', null, null, null, '0'],
        'A blank customer name is rejected',
      );
      for (const junk of [
        '1e3',
        'NaN',
        'Infinity',
        '0x10',
        '1,000',
        '+5',
        '1.2.3',
        '10000000000000',
      ]) {
        await denied(
          clients.owner!,
          'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
          [randomUUID(), business, null, `Junk ${junk}`, null, null, null, junk],
          `Opening balance "${junk}" is rejected as a non-decimal literal`,
        );
      }
      await denied(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, ali, 'Ali Khan', null, null, null, '9999.00'],
        'An opening balance cannot be rewritten after the khata is open',
      );
      await denied(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), rivalBusiness, null, 'Smuggled', null, null, null, '0'],
        'A customer cannot be written into another tenant',
      );
      await denied(
        clients.rivalOwner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, null, 'Injected', null, null, null, '0'],
        'A foreign owner cannot write into this tenant',
      );
      const renamed = await json(
        clients.manager!,
        'public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          business,
          ali,
          'Ali Khan Traders',
          '+923001234567',
          'ali@example.test',
          'Bazar Road, Shekhupura',
          null,
        ],
      );
      equal(renamed.customer_id, ali, 'Updating a customer keeps the same persistent record');
      equal(
        await scalar(admin, 'select name from public.customers where id=$1', [ali]),
        'Ali Khan Traders',
        'The rename is stored in the database',
      );
      await denied(
        clients.staff!,
        'select public.archive_customer($1,$2)',
        [ali, true],
        'Staff cannot archive a customer',
      );
      await rows(clients.accountant!, 'select public.archive_customer($1,$2)', [ali, true]);
      ok(true, 'An accountant can archive a customer');
      const archivedBalance = await json(clients.owner!, 'public.customer_balance($1)', [ali]);
      ok(
        typeof archivedBalance.customer_archived_at === 'string',
        'An archived customer reports its archive time to the app',
      );
      equal(
        archivedBalance.customer_name,
        'Ali Khan Traders',
        'The balance call names the account, so a payment form never pages the customer list',
      );

      console.log('\nPhase 3 · exact decimal arithmetic');
      const decimal = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: [{ item_name: 'Sugar', quantity: '3', unit_price: '0.1' }],
      });
      equal(decimal.total, '0.30', '3 × 0.1 is exactly 0.30, not 0.30000000000000004');
      equal(
        await scalar(admin, 'select line_total::text from public.sale_items where sale_id=$1', [
          decimal.sale_id,
        ]),
        '0.3000',
        'The stored line total is exact numeric(18,4)',
      );
      equal(
        typeof decimal.total,
        'string',
        'Money is returned to the app as text, never as a JSON number',
      );
      const tie = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: [{ item_name: 'Cloth', quantity: '1', unit_price: '2.345' }],
      });
      equal(tie.total, '2.35', 'A half-way amount rounds away from zero, not to even');
      const fractional = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: [{ item_name: 'Rice', quantity: '1.5', unit_price: '199.999' }],
      });
      equal(
        fractional.total,
        '300.00',
        'A fractional quantity is rounded once, at the money scale',
      );
      const many = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: Array.from({ length: 100 }, () => ({
          item_name: 'Penny line',
          quantity: '1',
          unit_price: '0.01',
        })),
      });
      equal(many.total, '1.00', 'One hundred 0.01 lines sum to exactly 1.00');
      equal(many.lines, 100, 'Every line was persisted');
      const yenSale = await postSale(clients.owner!, {
        businessId: yenBusiness,
        method: 'cash',
        paid: '101',
        lines: [{ item_name: 'Bento', quantity: '1', unit_price: '100.6' }],
      });
      equal(yenSale.total, '101', 'A zero-decimal currency stores whole yen');
      equal(yenSale.currency, 'JPY', 'The sale snapshots the business currency');
      const dinarSale = await postSale(clients.owner!, {
        businessId: dinarBusiness,
        method: 'cash',
        paid: '1.235',
        lines: [{ item_name: 'Spice', quantity: '1', unit_price: '1.2345' }],
      });
      equal(dinarSale.total, '1.235', 'A three-decimal currency keeps its fils');
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'credit',
          '0',
          items([{ item_name: 'Over', quantity: '1', unit_price: '10', discount: '10.01' }]),
          null,
          null,
        ],
        'A line discount larger than the line total is rejected',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          '2999-12-31',
          'credit',
          '0',
          items([{ item_name: 'Future', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'A sale dated in the future is rejected',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), business, bilal, today, 'cash', '5', items([]), null, null],
        'A sale with no lines is rejected',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'cash',
          '5',
          items([{ item_name: 'Free', quantity: '1', unit_price: '0' }]),
          null,
          null,
        ],
        'A zero-value sale is rejected instead of silently posting',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'cash',
          '40',
          items([{ item_name: 'Overpaid', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'A counter payment larger than the sale total is rejected',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          null,
          today,
          'cash',
          '9',
          items([{ item_name: 'Walk-in', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'A sale without a customer must be settled in full',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'cash',
          '0',
          items([{ item_name: 'Wrong method', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'An unpaid sale must be recorded as credit, not as cash',
      );
      const beforeFailure = await scalar(admin, 'select count(*)::int from public.sales');
      const beforeItems = await scalar(admin, 'select count(*)::int from public.sale_items');
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'credit',
          '0',
          items([
            { item_name: 'Good', quantity: '1', unit_price: '10' },
            { item_name: 'Bad', quantity: '1', unit_price: '10', discount: '99' },
          ]),
          null,
          null,
        ],
        'One invalid line rejects the whole sale',
      );
      equal(
        await scalar(admin, 'select count(*)::int from public.sales'),
        beforeFailure,
        'A rejected sale leaves no partial document behind',
      );
      equal(
        await scalar(admin, 'select count(*)::int from public.sale_items'),
        beforeItems,
        'A rejected sale leaves no partial lines behind',
      );

      console.log('\nPhase 3 · catalog snapshots');
      const product = await json(clients.manager!, 'public.save_product($1,$2,$3,$4,$5,$6,$7,$8)', [
        randomUUID(),
        business,
        null,
        'Tea bag',
        'TEA-1',
        'box',
        '100',
        '60',
      ]);
      equal(product.sale_price, '100.00', 'Catalog prices are stored at the currency scale');
      await denied(
        clients.staff!,
        'select public.save_product($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, null, 'Staff item', null, 'pcs', '10', '5'],
        'Staff cannot change the catalog',
      );
      const fromCatalog = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: [{ product_id: product.product_id, quantity: '2' }],
      });
      equal(fromCatalog.total, '200.00', 'A catalog line uses the stored sale price');
      equal(fromCatalog.cogs, '120.00', 'Cost of goods sold is derived from the stored cost price');
      await json(clients.manager!, 'public.save_product($1,$2,$3,$4,$5,$6,$7,$8)', [
        randomUUID(),
        business,
        product.product_id,
        'Tea bag',
        'TEA-1',
        'box',
        '250',
        '180',
      ]);
      equal(
        await scalar(admin, 'select unit_price::text from public.sale_items where sale_id=$1', [
          fromCatalog.sale_id,
        ]),
        '100.0000',
        'A later price change never rewrites a posted sale',
      );
      const rivalProduct = await json(
        clients.rivalOwner!,
        'public.save_product($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), rivalBusiness, null, 'Rival item', null, 'pcs', '50', '25'],
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          bilal,
          today,
          'credit',
          '0',
          items([{ product_id: rivalProduct.product_id, quantity: '1' }]),
          null,
          null,
        ],
        'A catalog item from another business cannot be sold here',
      );

      console.log('\nPhase 3 · khata ledger reconciliation');
      const sana = await customer(clients.owner!, business, 'Sana Store');
      const saleA = await postSale(clients.owner!, {
        customerId: sana,
        method: 'credit',
        lines: [{ item_name: 'Flour', quantity: '5', unit_price: '500.15' }],
      });
      equal(saleA.total, '2500.75', 'A credit sale is exact to the paisa');
      equal(saleA.customer_outstanding, '2500.75', 'The khata balance is returned by the server');
      const saleB = await postSale(clients.owner!, {
        customerId: sana,
        method: 'cash',
        paid: '400.00',
        lines: [{ item_name: 'Oil', quantity: '4', unit_price: '250' }],
      });
      equal(saleB.total, '1000.00', 'A part-paid sale totals correctly');
      equal(saleB.due, '600.00', 'The remaining due is computed server-side');
      equal(
        saleB.customer_outstanding,
        '3100.75',
        'A counter receipt reduces the balance immediately',
      );
      const collection = await pay(clients.staff!, {
        customerId: sana,
        saleId: saleA.sale_id,
        amount: '1000.00',
      });
      equal(
        collection.customer_outstanding,
        '2100.75',
        'Staff can collect a payment at the counter',
      );
      const refund = await pay(clients.accountant!, {
        customerId: sana,
        direction: 'refunded',
        amount: '200.00',
        method: 'bank',
        reference: 'Damaged bag',
      });
      equal(refund.customer_outstanding, '2300.75', 'A refund increases what the customer owes');
      const creditNote = await json(
        clients.manager!,
        'public.record_customer_adjustment($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          business,
          sana,
          '-300.00',
          'Goods returned without a stock effect',
          today,
          null,
        ],
      );
      equal(creditNote.customer_outstanding, '2000.75', 'A credit note reduces the balance');
      await denied(
        clients.staff!,
        'select public.record_customer_adjustment($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), business, sana, '-1000', 'Staff write-off', null, null],
        'Staff cannot adjust a khata balance',
      );
      await denied(
        clients.manager!,
        'select public.record_customer_adjustment($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), business, sana, '-10', '   ', null, null],
        'An adjustment without a reason is rejected',
      );
      await denied(
        clients.owner!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [randomUUID(), business, sana, null, 'received', '100', 'credit', today, null, null],
        'A payment must record how money actually moved',
      );
      await denied(
        clients.owner!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [randomUUID(), business, sana, null, 'received', '0', 'cash', today, null, null],
        'A zero payment is rejected',
      );
      await denied(
        clients.owner!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [randomUUID(), business, ali, saleA.sale_id, 'received', '10', 'cash', today, null, null],
        'A payment cannot be attached to another customer’s sale',
      );
      const reconciled = await rows(
        admin,
        `with ledger as (
           select coalesce(sum(amount), 0) as total from public.customer_ledger where customer_id = $1
         ), documents as (
           select
             (select opening_balance from public.customers where id = $1)
             + (select coalesce(sum(total), 0) from public.sales
                where customer_id = $1 and status = 'posted')
             - (select coalesce(sum(paid_amount), 0) from public.sales
                where customer_id = $1 and status = 'posted')
             - (select coalesce(sum(amount), 0) from public.payments
                where customer_id = $1 and status = 'posted' and direction = 'received')
             + (select coalesce(sum(amount), 0) from public.payments
                where customer_id = $1 and status = 'posted' and direction = 'refunded')
             + (select coalesce(sum(amount), 0) from public.customer_ledger
                where customer_id = $1 and entry_type = 'adjustment') as total
         )
         select round(ledger.total, 2)::text as from_ledger,
                round(documents.total, 2)::text as from_documents
         from ledger, documents`,
        [sana],
      );
      equal(reconciled[0].from_ledger, '2000.75', 'The ledger holds the expected balance');
      equal(
        reconciled[0].from_ledger,
        reconciled[0].from_documents,
        'The append-only ledger reconciles exactly with its source documents',
      );
      const overpay = await pay(clients.owner!, {
        customerId: sana,
        amount: '5000.00',
        method: 'bank',
      });
      equal(
        overpay.customer_outstanding,
        '-2999.25',
        'An overpayment becomes a visible customer credit instead of being blocked or lost',
      );
      await pay(clients.owner!, {
        customerId: sana,
        direction: 'refunded',
        amount: '2999.25',
        method: 'bank',
        reference: 'Advance returned',
      });
      const settled = await json(clients.owner!, 'public.customer_balance($1)', [sana]);
      equal(
        settled.outstanding,
        '0.00',
        'Refunding the advance settles the khata back to exactly zero',
      );
      equal(settled.customer_archived_at, null, 'An active customer reports no archive time');
      equal(settled.customer_name, 'Sana Store', 'The settled balance still names its account');
      const namedStatement = await json(clients.owner!, 'public.customer_statement($1,$2,$3,$4)', [
        sana,
        null,
        null,
        10,
      ]);
      equal(
        namedStatement.customer_name,
        'Sana Store',
        'The statement names the khata it describes',
      );
      equal(
        namedStatement.customer_archived_at,
        null,
        'The statement reports that this khata is not archived',
      );

      console.log('\nPhase 3 · idempotent posting');
      const operationId = randomUUID();
      const first = await postSale(clients.clerk!, {
        customerId: bilal,
        method: 'cash',
        paid: '750.00',
        lines: [{ item_name: 'Idempotent item', quantity: '3', unit_price: '250' }],
        operationId,
      });
      const replay = await postSale(clerkSecond, {
        customerId: bilal,
        method: 'cash',
        paid: '750.00',
        lines: [{ item_name: 'Idempotent item', quantity: '3', unit_price: '250' }],
        operationId,
      });
      equal(first.replayed, false, 'The first post is not a replay');
      equal(replay.replayed, true, 'A retry with the same operation id is reported as a replay');
      equal(replay.sale_id, first.sale_id, 'A retry returns the original document, not a new one');
      equal(replay.total, first.total, 'A replay returns the original exact amounts');
      equal(
        await scalar(admin, 'select count(*)::int from public.sales where id=$1', [first.sale_id]),
        1,
        'A retry did not insert a second sale',
      );
      equal(
        await scalar(
          admin,
          'select count(*)::int from public.customer_ledger where reference_id=$1',
          [first.sale_id],
        ),
        2,
        'A retry did not duplicate the ledger entries',
      );
      const raced = randomUUID();
      const racers = await Promise.all([
        pay(clients.clerk!, {
          operationId: raced,
          customerId: bilal,
          amount: '250.00',
          note: 'Concurrent collection',
        }),
        pay(clerkSecond, {
          operationId: raced,
          customerId: bilal,
          amount: '250.00',
          note: 'Concurrent collection',
        }),
      ]);
      equal(
        racers[0].payment_id,
        racers[1].payment_id,
        'Two simultaneous submissions of one operation id store one payment',
      );
      equal(
        racers.filter((result) => result.replayed === true).length,
        1,
        'Exactly one of the simultaneous submissions was the replay',
      );
      equal(
        await scalar(admin, 'select count(*)::int from public.payments where id=$1', [
          racers[0].payment_id,
        ]),
        1,
        'The concurrent duplicate never reached the payments table',
      );
      equal(
        await scalar(
          admin,
          'select count(*)::int from public.operation_receipts where operation_id=$1',
          [raced],
        ),
        1,
        'Exactly one idempotency receipt exists for the raced operation',
      );
      const expenseOp = randomUUID();
      const expense = await json(
        clients.accountant!,
        'public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [expenseOp, business, today, 'Rent', '25000.00', 'bank', 'CHQ-991', 'Monthly rent'],
      );
      equal(expense.amount, '25000.00', 'An expense stores the exact amount');
      await deniedWith(
        clients.accountant!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          expenseOp,
          business,
          bilal,
          today,
          'credit',
          '0',
          items([{ item_name: 'Reuse', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        '22023',
        'An operation id cannot be reused for a different kind of write',
      );
      await deniedWith(
        clients.staff!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [expenseOp, business, bilal, null, 'received', '10', 'cash', today, null, null],
        '42501',
        'An operation id cannot be replayed by a different session',
      );
      const failedOp = randomUUID();
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          failedOp,
          business,
          bilal,
          today,
          'credit',
          '0',
          items([{ item_name: 'Will fail', quantity: '0', unit_price: '10' }]),
          null,
          null,
        ],
        'A zero quantity is rejected',
      );
      equal(
        await scalar(
          admin,
          'select count(*)::int from public.operation_receipts where operation_id=$1',
          [failedOp],
        ),
        0,
        'A rolled-back attempt stores no receipt and cannot poison the operation id',
      );
      const recovered = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'credit',
        lines: [{ item_name: 'Recovered after failure', quantity: '1', unit_price: '10' }],
        operationId: failedOp,
      });
      equal(recovered.replayed, false, 'The same operation id succeeds once the data is corrected');
      await deniedWith(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          null,
          business,
          bilal,
          today,
          'credit',
          '0',
          items([{ item_name: 'No op id', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        '22023',
        'A financial write without an operation id is refused',
      );
      await deniedWith(
        admin,
        'delete from public.operation_receipts where operation_id=$1',
        [expenseOp],
        '42501',
        'Idempotency receipts cannot be deleted, even by a superuser',
      );

      console.log('\nPhase 3 · voids and reversals');
      const voidTarget = await postSale(clients.owner!, {
        customerId: bilal,
        method: 'cash',
        paid: '100.00',
        lines: [{ item_name: 'Voidable', quantity: '1', unit_price: '1000' }],
      });
      const beforeVoid = (await json(clients.owner!, 'public.customer_balance($1)', [bilal]))
        .outstanding as string;
      await denied(
        clients.staff!,
        'select public.void_sale($1,$2,$3)',
        [randomUUID(), voidTarget.sale_id, 'Staff attempt'],
        'Staff cannot void a sale',
      );
      await denied(
        clients.accountant!,
        'select public.void_sale($1,$2,$3)',
        [randomUUID(), voidTarget.sale_id, '   '],
        'A void without a reason is rejected',
      );
      const voided = await json(clients.accountant!, 'public.void_sale($1,$2,$3)', [
        randomUUID(),
        voidTarget.sale_id,
        'Entered against the wrong customer',
      ]);
      equal(voided.voided, true, 'An accountant can void a sale with a reason');
      equal(
        (await json(clients.owner!, 'public.customer_balance($1)', [bilal])).outstanding,
        fromCents(cents(beforeVoid) - cents('900.00')),
        'Voiding a part-paid sale reverses both the charge and the counter receipt',
      );
      equal(
        voided.customer_outstanding,
        fromCents(cents(beforeVoid) - cents('900.00')),
        'The void response carries the same server-computed balance',
      );
      await denied(
        clients.accountant!,
        'select public.void_sale($1,$2,$3)',
        [randomUUID(), voidTarget.sale_id, 'Second attempt'],
        'A sale cannot be voided twice',
      );
      equal(
        await scalar(
          admin,
          'select count(*)::int from public.customer_ledger where reference_id=$1',
          [voidTarget.sale_id],
        ),
        4,
        'A void appends reversing entries instead of deleting history',
      );
      await deniedWith(
        admin,
        'delete from public.sales where id=$1',
        [voidTarget.sale_id],
        '42501',
        'A financial document cannot be deleted, even by a superuser',
      );
      await deniedWith(
        admin,
        'update public.customer_ledger set amount = 0 where customer_id=$1',
        [bilal],
        '42501',
        'A ledger entry cannot be rewritten, even by a superuser',
      );
      await deniedWith(
        admin,
        `insert into public.customer_ledger(business_id,customer_id,entry_type,amount,
            reference_type,reference_id,entry_date,created_by)
         select business_id, customer_id, entry_type, amount, reference_type, reference_id,
            entry_date, created_by
         from public.customer_ledger
         where id = (select id from public.customer_ledger where reference_id=$1 limit 1)`,
        [voidTarget.sale_id],
        '23505',
        'The same document can never post the same ledger effect twice',
      );
      const voidedPayment = await json(clients.manager!, 'public.void_payment($1,$2,$3)', [
        randomUUID(),
        collection.payment_id,
        'Recorded against the wrong receipt',
      ]);
      equal(voidedPayment.voided, true, 'A payment can be voided by a manager');
      equal(
        await scalar(
          admin,
          "select count(*)::int from public.customer_ledger where entry_type='payment_void' and reference_id=$1",
          [collection.payment_id],
        ),
        1,
        'A voided payment posts exactly one reversing ledger entry',
      );
      await denied(
        clients.manager!,
        'select public.void_payment($1,$2,$3)',
        [randomUUID(), collection.payment_id, 'Twice'],
        'A payment cannot be voided twice',
      );

      console.log('\nPhase 3 · expense permissions');
      await denied(
        clients.staff!,
        'select public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, today, 'Snacks', '500', 'cash', null, null],
        'Staff cannot record expenses',
      );
      await denied(
        clients.staff!,
        'select * from public.list_expenses($1,$2,$3,$4,$5,$6,$7)',
        [business, null, null, null, null, 30, 0],
        'Staff cannot list expenses',
      );
      equal(
        (await rows(clients.staff!, 'select * from public.expenses')).length,
        0,
        'Row level security hides expenses from staff',
      );
      ok(
        (await rows(clients.accountant!, 'select * from public.expenses')).length > 0,
        'An accountant can read expenses through RLS',
      );
      ok(
        (await rows(clients.coowner!, 'select * from public.expenses')).length > 0,
        'A co-owner can read expenses through RLS',
      );
      await denied(
        clients.accountant!,
        'select public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, today, 'Credit purchase', '500', 'credit', null, null],
        'An unpaid expense is refused until supplier ledgers exist',
      );
      await denied(
        clients.accountant!,
        'select public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, today, 'Negative', '-500', 'cash', null, null],
        'A negative expense is refused',
      );
      const voidedExpense = await json(clients.owner!, 'public.void_expense($1,$2,$3)', [
        randomUUID(),
        expense.expense_id,
        'Duplicate rent entry',
      ]);
      equal(voidedExpense.voided, true, 'An owner can void an expense');
      await denied(
        clients.staff!,
        'select public.void_expense($1,$2,$3)',
        [randomUUID(), expense.expense_id, 'Staff attempt'],
        'Staff cannot void an expense',
      );
      const utilities = await json(
        clients.accountant!,
        'public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), business, today, 'Utilities', '4321.10', 'cash', null, null],
      );
      equal(utilities.amount, '4321.10', 'A replacement expense is stored exactly');
      const categories = await list(clients.accountant!, 'public.expense_categories($1)', [
        business,
      ]);
      equal(categories.length, 1, 'Only posted expense categories are offered to the user');
      equal(categories[0].category, 'Utilities', 'The category list is built from real records');
      equal(categories[0].total, '4321.10', 'A voided expense is excluded from the category total');

      console.log('\nPhase 3 · reports derived from records, never hardcoded');
      const period = await json(clients.owner!, 'public.period_summary($1,$2,$3)', [
        business,
        monthStart,
        monthEnd,
      ]);
      equal(period.currency, 'PKR', 'The summary reports the business currency');
      equal(
        period.revenue,
        await scalar(
          admin,
          `select round(sum(total),2)::text from public.sales
           where business_id=$1 and status='posted' and sale_date between $2 and $3`,
          [business, monthStart, monthEnd],
        ),
        'Reported revenue equals the sum of posted sales in the period',
      );
      equal(
        period.net_profit,
        await scalar(
          admin,
          `select round(
             (select coalesce(sum(total),0) from public.sales
               where business_id=$1 and status='posted' and sale_date between $2 and $3)
             - (select coalesce(sum(cogs),0) from public.sales
               where business_id=$1 and status='posted' and sale_date between $2 and $3)
             - (select coalesce(sum(amount),0) from public.expenses
               where business_id=$1 and status='posted' and expense_date between $2 and $3),
           2)::text`,
          [business, monthStart, monthEnd],
        ),
        'Net profit is exactly revenue minus COGS minus expenses',
      );
      equal(
        period.gross_profit,
        fromCents(cents(period.revenue as string) - cents(period.cogs as string)),
        'Gross profit is exactly revenue minus COGS',
      );
      equal(
        period.cogs_coverage_percent,
        await scalar(
          admin,
          `select round(100 * sum(case when cogs > 0 then total else 0 end)
                   / nullif(sum(total),0), 1)::text
           from public.sales where business_id=$1 and status='posted'
             and sale_date between $2 and $3`,
          [business, monthStart, monthEnd],
        ),
        'The report states how much revenue actually has a recorded cost',
      );
      ok(
        Number(period.cogs_coverage_percent) < 100,
        'Profit coverage is reported honestly instead of assuming every cost is known',
      );
      const balances = await json(clients.owner!, 'public.balance_summary($1)', [business]);
      equal(
        balances.receivables_total,
        await scalar(
          admin,
          `select round(coalesce(sum(per_customer.outstanding),0),2)::text from (
             select sum(amount) as outstanding from public.customer_ledger where business_id=$1
             group by customer_id) per_customer
           where per_customer.outstanding > 0`,
          [business],
        ),
        'Receivables equal the sum of positive khata balances',
      );
      ok(
        Array.isArray(balances.cash_methods) && (balances.cash_methods as Json[]).length >= 2,
        'Cash is reported per payment method',
      );
      equal(
        balances.cash_net_total,
        await scalar(
          admin,
          `select round(
             (select coalesce(sum(paid_amount),0) from public.sales
               where business_id=$1 and status='posted')
             + (select coalesce(sum(amount),0) from public.payments
               where business_id=$1 and status='posted' and direction='received')
             - (select coalesce(sum(amount),0) from public.payments
               where business_id=$1 and status='posted' and direction='refunded')
             - (select coalesce(sum(amount),0) from public.expenses
               where business_id=$1 and status='posted'),
           2)::text`,
          [business],
        ),
        'Cash is derived once from documents, with no double counting',
      );
      ok(
        balances.cash_net_total !== period.net_profit,
        `Cash (${balances.cash_net_total}) is reported separately from profit (${period.net_profit})`,
      );
      equal(
        balances.financial_activity,
        true,
        'The business reports that it holds financial history',
      );
      await denied(
        clients.staff!,
        'select public.period_summary($1,$2,$3)',
        [business, monthStart, monthEnd],
        'Staff cannot read the profit summary',
      );
      await denied(
        clients.staff!,
        'select public.balance_summary($1)',
        [business],
        'Staff cannot read the balance summary',
      );
      await denied(
        clients.rivalOwner!,
        'select public.period_summary($1,$2,$3)',
        [business, monthStart, monthEnd],
        'A foreign owner cannot read this tenant’s summary',
      );
      await denied(
        clients.owner!,
        'select public.period_summary($1,$2,$3)',
        [rivalBusiness, monthStart, monthEnd],
        'This owner cannot read the rival tenant’s summary',
      );
      await denied(
        clients.owner!,
        'select public.period_summary($1,$2,$3)',
        [business, monthEnd, monthStart],
        'An inverted reporting range is rejected',
      );

      console.log('\nPhase 3 · tenant isolation on every record type');
      const rivalCustomer = await customer(
        clients.rivalOwner!,
        rivalBusiness,
        'Rival Buyer',
        '77.77',
      );
      await postSale(clients.rivalOwner!, {
        businessId: rivalBusiness,
        customerId: rivalCustomer,
        method: 'credit',
        lines: [{ item_name: 'Rival goods', quantity: '1', unit_price: '1000' }],
      });
      await json(clients.outsider!, 'public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)', [
        randomUUID(),
        rivalBusiness,
        today,
        'Rival rent',
        '500',
        'cash',
        null,
        null,
      ]);
      for (const table of FINANCIAL_TABLES.filter((name) => name !== 'operation_receipts')) {
        equal(
          (
            await rows(clients.owner!, `select * from public.${table} where business_id=$1`, [
              rivalBusiness,
            ])
          ).length,
          0,
          `A member of one business cannot read ${table} of another`,
        );
      }
      await denied(
        clients.owner!,
        'select * from public.operation_receipts where business_id=$1',
        [rivalBusiness],
        'Idempotency receipts cannot be read by any client, in any tenant',
      );
      await denied(
        clients.owner!,
        'select * from public.operation_receipts',
        [],
        'Idempotency receipts cannot be read even inside the caller’s own tenant',
      );
      ok(
        (await rows(clients.owner!, 'select * from public.sales')).every(
          (row) => row.business_id !== rivalBusiness,
        ),
        'An unfiltered sale query still returns only this tenant’s rows',
      );
      ok(
        (await rows(clients.owner!, 'select * from public.expenses')).every(
          (row) => row.business_id !== rivalBusiness,
        ),
        'An unfiltered expense query still returns only this tenant’s rows',
      );
      await denied(
        clients.owner!,
        'select public.customer_balance($1)',
        [rivalCustomer],
        'A foreign customer balance cannot be read',
      );
      await denied(
        clients.owner!,
        'select public.customer_statement($1,$2,$3,$4)',
        [rivalCustomer, null, null, 50],
        'A foreign khata statement cannot be read',
      );
      await denied(
        clients.owner!,
        'select * from public.list_customers($1,$2,$3,$4,$5)',
        [rivalBusiness, null, false, 50, 0],
        'A foreign customer list cannot be read',
      );
      await denied(
        clients.owner!,
        'select * from public.list_sales($1,$2,$3,$4,$5,$6,$7)',
        [rivalBusiness, null, null, null, null, 30, 0],
        'A foreign sale list cannot be read',
      );
      await denied(
        clients.owner!,
        'select * from public.list_payments($1,$2,$3,$4,$5,$6,$7)',
        [rivalBusiness, null, null, null, null, 30, 0],
        'A foreign payment list cannot be read',
      );
      await denied(
        clients.owner!,
        'select * from public.list_activity($1,$2,$3)',
        [rivalBusiness, 30, null],
        'A foreign activity feed cannot be read',
      );
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          rivalCustomer,
          today,
          'credit',
          '0',
          items([{ item_name: 'Cross tenant', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'A foreign customer cannot be sold to inside this tenant',
      );
      await denied(
        clients.owner!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [randomUUID(), business, rivalCustomer, null, 'received', '10', 'cash', today, null, null],
        'A foreign customer cannot be paid into this tenant',
      );
      await denied(
        clients.owner!,
        'select public.record_customer_adjustment($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), business, rivalCustomer, '10', 'Cross tenant note', null, null],
        'A foreign khata cannot be adjusted from this tenant',
      );
      await denied(
        clients.outsider!,
        'select public.void_sale($1,$2,$3)',
        [randomUUID(), saleA.sale_id, 'Foreign manager attempt'],
        'A manager of another business cannot void this tenant’s sale',
      );
      const ownStatement = await json(clients.staff!, 'public.customer_statement($1,$2,$3,$4)', [
        sana,
        null,
        null,
        100,
      ]);
      const statementEntries = ownStatement.entries as Json[];
      ok(statementEntries.length > 0, 'A member can read their own tenant’s khata statement');
      equal(
        ownStatement.closing_outstanding,
        (await json(clients.staff!, 'public.customer_balance($1)', [sana])).outstanding,
        'The statement’s closing balance equals the customer balance',
      );
      let running = cents(ownStatement.opening_outstanding as string);
      let runningConsistent = true;
      for (const entry of statementEntries) {
        running += cents(entry.amount as string);
        if (fromCents(running) !== entry.running_balance) runningConsistent = false;
      }
      ok(
        runningConsistent,
        'Every statement running balance is the exact cumulative sum of its entries',
      );
      equal(
        fromCents(running),
        ownStatement.closing_outstanding,
        'The cumulative statement sum ends on the closing balance',
      );
      const paged = await json(clients.staff!, 'public.customer_statement($1,$2,$3,$4)', [
        sana,
        null,
        null,
        2,
      ]);
      equal((paged.entries as Json[]).length, 2, 'A statement page is limited as requested');
      equal(paged.truncated, true, 'The statement says when older entries are not shown');
      equal(
        paged.closing_outstanding,
        ownStatement.closing_outstanding,
        'A truncated statement still ends on the true balance',
      );
      const listing = await list(clients.staff!, 'public.list_customers($1,$2,$3,$4,$5)', [
        business,
        'sana',
        false,
        50,
        0,
      ]);
      equal(listing.length, 1, 'Customer search matches on the stored name');
      equal(
        listing[0].outstanding,
        (await json(clients.staff!, 'public.customer_balance($1)', [sana])).outstanding,
        'The customer list carries the same server-computed balance',
      );
      equal(
        (
          await list(clients.staff!, 'public.list_customers($1,$2,$3,$4,$5)', [
            business,
            null,
            false,
            200,
            0,
          ])
        ).some((row) => row.name === 'Ali Khan Traders'),
        false,
        'An archived customer is hidden from the default list',
      );
      equal(
        (
          await list(clients.staff!, 'public.list_customers($1,$2,$3,$4,$5)', [
            business,
            null,
            true,
            200,
            0,
          ])
        ).some((row) => row.name === 'Ali Khan Traders'),
        true,
        'An archived customer stays visible when history is requested',
      );

      console.log('\nPhase 3 · currency lock and archived businesses');
      const lockBusiness = (await scalar(
        clients.owner!,
        'select public.create_business($1,$2,$3)',
        ['Lock Test', 'PKR', 'UTC'],
      )) as string;
      await rows(clients.owner!, 'select public.update_business_settings($1,$2,$3,$4,$5)', [
        lockBusiness,
        'Lock Test',
        'USD',
        'UTC',
        false,
      ]);
      equal(
        await scalar(admin, 'select currency from public.businesses where id=$1', [lockBusiness]),
        'USD',
        'The currency can still change while the business has no financial records',
      );
      await customer(clients.owner!, lockBusiness, 'First Khata', '10.00');
      equal(
        await scalar(
          admin,
          'select currency_locked_at is not null from public.businesses where id=$1',
          [lockBusiness],
        ),
        true,
        'An opening balance locks the currency',
      );
      await denied(
        clients.owner!,
        'select public.update_business_settings($1,$2,$3,$4,$5)',
        [lockBusiness, 'Lock Test', 'PKR', 'UTC', false],
        'The currency cannot be changed once khata money exists',
      );
      await rows(clients.owner!, 'select public.update_business_settings($1,$2,$3,$4,$5)', [
        lockBusiness,
        'Lock Test Renamed',
        'USD',
        'Asia/Karachi',
        true,
      ]);
      equal(
        await scalar(admin, 'select name from public.businesses where id=$1', [lockBusiness]),
        'Lock Test Renamed',
        'The business name still changes while the currency is locked',
      );
      equal(
        await scalar(admin, 'select timezone from public.businesses where id=$1', [lockBusiness]),
        'Asia/Karachi',
        'The timezone still changes while the currency is locked',
      );
      equal(
        await scalar(admin, 'select co_owners_can_invite from public.businesses where id=$1', [
          lockBusiness,
        ]),
        true,
        'The invitation setting still changes while the currency is locked',
      );
      await denied(
        clients.owner!,
        'select public.update_business_settings($1,$2,$3,$4,$5)',
        [business, 'Alpha Traders', 'USD', 'Asia/Karachi', false],
        'A trading business with sales cannot switch currency',
      );
      equal(
        await scalar(
          admin,
          'select currency_locked_at is not null from public.businesses where id=$1',
          [business],
        ),
        true,
        'The first sale locked the trading currency',
      );
      const archivedBusiness = (await scalar(
        clients.owner!,
        'select public.create_business($1,$2,$3)',
        ['Closed Shop', 'PKR', 'UTC'],
      )) as string;
      const archivedCustomer = await customer(clients.owner!, archivedBusiness, 'Old Buyer');
      await rows(clients.owner!, 'select public.archive_business($1,$2)', [archivedBusiness, true]);
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          archivedBusiness,
          archivedCustomer,
          today,
          'credit',
          '0',
          items([{ item_name: 'Late sale', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'An archived business cannot record new sales',
      );
      await denied(
        clients.owner!,
        'select public.create_expense($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), archivedBusiness, today, 'Late expense', '10', 'cash', null, null],
        'An archived business cannot record new expenses',
      );
      await denied(
        clients.owner!,
        'select public.record_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          randomUUID(),
          archivedBusiness,
          archivedCustomer,
          null,
          'received',
          '10',
          'cash',
          today,
          null,
          null,
        ],
        'An archived business cannot record new payments',
      );
      await denied(
        clients.owner!,
        'select public.save_customer($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), archivedBusiness, null, 'Late customer', null, null, null, '0'],
        'An archived business cannot add customers',
      );
      equal(
        (
          await rows(clients.owner!, 'select * from public.customers where business_id=$1', [
            archivedBusiness,
          ])
        ).length,
        1,
        'Archived history stays readable',
      );

      console.log('\nPhase 3 · concurrency, activity and audit history');
      const concurrentCustomer = await customer(clients.owner!, business, 'Concurrent Buyer');
      const [left, right] = await Promise.all([
        postSale(clients.clerk!, {
          customerId: concurrentCustomer,
          method: 'credit',
          lines: [{ item_name: 'Left', quantity: '1', unit_price: '100.25' }],
        }),
        postSale(clients.staff!, {
          customerId: concurrentCustomer,
          method: 'credit',
          lines: [{ item_name: 'Right', quantity: '1', unit_price: '200.50' }],
        }),
      ]);
      ok(left.sale_id !== right.sale_id, 'Two different operation ids create two sales');
      equal(
        (await json(clients.owner!, 'public.customer_balance($1)', [concurrentCustomer]))
          .outstanding,
        '300.75',
        'Concurrent postings do not lose an update in the khata balance',
      );
      const activity = await list(clients.staff!, 'public.list_activity($1,$2,$3)', [
        business,
        100,
        null,
      ]);
      ok(
        activity.length >= 10,
        `The activity feed is built from real records (${activity.length} rows)`,
      );
      ok(
        activity.some((row) => row.action === 'sale.created') &&
          activity.some((row) => row.action === 'payment.received') &&
          activity.some((row) => row.action === 'expense.created'),
        'Sales, payments and expenses all appear in the activity feed',
      );
      ok(
        activity.every(
          (row) => typeof row.summary === 'string' && (row.summary as string).length > 0,
        ),
        'Every activity row carries a readable summary',
      );
      ok(
        activity.every(
          (row) =>
            row.amount === null ||
            /^\d+\.\d{2}$/.test(row.amount as string) ||
            /^-\d+\.\d{2}$/.test(row.amount as string),
        ),
        'Activity amounts are exact decimal strings, never JSON numbers',
      );
      equal(
        (
          await rows(clients.staff!, 'select * from public.audit_logs where business_id=$1', [
            business,
          ])
        ).length,
        0,
        'Staff cannot read the financial audit trail',
      );
      const audit = await rows(
        clients.owner!,
        'select action, details from public.audit_logs where business_id=$1 order by created_at desc',
        [business],
      );
      ok(audit.length >= 10, `Financial changes are audited (${audit.length} rows)`);
      for (const action of [
        'sale.created',
        'sale.voided',
        'payment.received',
        'payment.voided',
        'expense.created',
        'expense.voided',
        'customer.credit_note',
        'customer.created',
      ]) {
        ok(
          audit.some((row) => row.action === action),
          `The audit trail records ${action}`,
        );
      }
      const saleAudit = audit.find((row) => row.action === 'sale.created')?.details as Json;
      ok(
        /^\d+(\.\d+)?$/.test(saleAudit.total as string) &&
          typeof saleAudit.operation_id === 'string',
        'Audited sale totals are exact decimal text and carry their operation id',
      );
      await deniedWith(
        admin,
        "update public.activity_logs set summary='rewritten' where business_id=$1",
        [business],
        '42501',
        'Activity history is immutable',
      );
      await deniedWith(
        admin,
        'delete from public.customers where id=$1',
        [sana],
        '42501',
        'A customer with khata history cannot be deleted',
      );
      await deniedWith(
        admin,
        'delete from public.sale_items where sale_id=$1',
        [saleA.sale_id],
        '42501',
        'Posted sale lines cannot be deleted',
      );

      console.log('\nPhase 3 · archived customers and read models');
      await denied(
        clients.owner!,
        'select public.create_sale($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          business,
          ali,
          today,
          'credit',
          '0',
          items([{ item_name: 'After archive', quantity: '1', unit_price: '10' }]),
          null,
          null,
        ],
        'An archived customer cannot take a new credit sale',
      );
      const archivedCollection = await pay(clients.owner!, {
        customerId: ali,
        amount: '500.50',
      });
      equal(
        archivedCollection.customer_outstanding,
        '1000.00',
        'An outstanding debt can still be collected from an archived customer',
      );
      const saleRows = await list(clients.clerk!, 'public.list_sales($1,$2,$3,$4,$5,$6,$7)', [
        business,
        sana,
        null,
        null,
        null,
        50,
        0,
      ]);
      ok(saleRows.length >= 2, 'A member can list the sales of one customer');
      ok(
        saleRows.every((row) => /^\d+\.\d{2}$/.test(row.total as string)),
        'Listed sale totals are exact decimal strings at the currency scale',
      );
      ok(
        saleRows.every((row) => row.customer_name === 'Sana Store'),
        'The sale list resolves customer names from the same tenant',
      );
      const voidedList = await list(clients.clerk!, 'public.list_sales($1,$2,$3,$4,$5,$6,$7)', [
        business,
        null,
        null,
        null,
        'voided',
        50,
        0,
      ]);
      ok(
        voidedList.length >= 1 && voidedList.every((row) => row.status === 'voided'),
        'Voided documents stay visible for review but stay out of the totals',
      );
      const paymentRows = await list(clients.clerk!, 'public.list_payments($1,$2,$3,$4,$5,$6,$7)', [
        business,
        null,
        null,
        null,
        null,
        50,
        0,
      ]);
      ok(
        paymentRows.length >= 3 &&
          paymentRows.every((row) => /^\d+\.\d{2}$/.test(row.amount as string)),
        'Payment rows are readable by counter staff with exact amounts',
      );
      const productRows = await list(clients.clerk!, 'public.list_products($1,$2,$3,$4,$5)', [
        business,
        'tea',
        false,
        50,
        0,
      ]);
      equal(productRows.length, 1, 'The catalog search finds the stored item');
      equal(productRows[0].sale_price, '250', 'Catalog unit prices keep their real precision');

      console.log('\nPhase 3 · health endpoint');
      const health = (await rows(anon, 'select public.ownerbook_health()'))[0]
        .ownerbook_health as Json;
      equal(health.schema_version, 3, 'The health endpoint reports schema version 3');
      equal(health.service, 'ownerbook', 'The health endpoint still identifies the service');
    },
    {
      summary:
        'native PostgreSQL Phase 3 checks passed. Hosted Supabase and an on-device APK still require live testing.',
    },
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
