# Phase 3 report — customers, khata, sales, payments and expenses

Date: 2026-11-06. Branch: `arena/b7b90880-ownerbook`. Base commit: `d980fa7`.

Phase 3 turns OwnerBook from an identity/tenancy shell into a working accounting
app for a small business: real customer khatas, real sales documents, real
payments, real expenses and reports calculated by PostgreSQL from those records.
Nothing on any screen is a sample, an estimate or a hardcoded figure.

## What was implemented

### Database (authoritative layer)

`supabase/migrations/20261103000100_khata_sales_expenses.sql` (1714 lines) adds:

- **9 tables**: `customers`, `products`, `sales`, `sale_items`, `payments`,
  `expenses`, `customer_ledger`, `activity_logs`, `operation_receipts`. Every
  business-owned row carries a non-null `business_id`; `sale_items` and
  `payments` use composite foreign keys so a line or a payment cannot be attached
  to a parent in another business.
- **18 exact `numeric` money/quantity columns and zero `float4`/`float8` columns.**
  Money is `numeric(18,4)` internally and leaves the server as text at exactly the
  currency's minor units (totals/balances) or in shortest-exact form (unit prices,
  quantities).
- **21 public functions**: 11 `SECURITY INVOKER` read models
  (`list_customers`, `list_products`, `list_sales`, `list_payments`,
  `list_expenses`, `expense_categories`, `list_activity`, `customer_statement`,
  `period_summary`, `balance_summary`, `customer_balance`) and 10
  `SECURITY DEFINER` writes (`save_customer`, `archive_customer`, `save_product`,
  `create_sale`, `void_sale`, `record_payment`, `void_payment`, `create_expense`,
  `void_expense`, `record_customer_adjustment`), plus 15 `private` helpers and a
  currency-lock addition to `update_business_settings`.
- **8 RLS policies, 17 indexes, 14 triggers.** Financial rows are immutable by
  trigger (`customer_ledger`, `sale_items`, `activity_logs` and voided documents
  reject UPDATE/DELETE even for a superuser); corrections are new reversing rows.
- Writes recompute every amount from the submitted decimal text, lock the business
  row, append ledger entries, record an idempotency receipt, write the activity row
  and commit as one transaction. Read models are invoker-security so RLS filters
  them a second time.
- `customer_statement` and `customer_balance` also return the customer's name and
  archive time, so a khata or payment screen never has to page through the customer
  list to name the account it is showing (that shortcut broke past 200 customers).
- Required schema version is now **3**.

### Accounting contract as implemented

- Revenue = Σ posted `sales.total`, where `total = subtotal − discount_total` and
  each line is `round(quantity × unit_price) − round(discount)` at the currency
  scale, rounded **per line before summing**.
- COGS = Σ posted `sales.cogs` from `sale_items.unit_cost × quantity`. Phase 3 uses
  the cost recorded on the line (from the catalog item, or entered for a custom
  item); Phase 4 replaces it with perpetual weighted-average cost from stock
  movements. `period_summary.cogs_coverage_percent` states how much of the period's
  revenue has a recorded cost, so an optimistic gross profit is visible.
- Gross profit = revenue − COGS. **Net profit = revenue − COGS − expenses.**
- Customer outstanding = Σ signed `customer_ledger.amount`, and it reconciles with
  `opening_balance + Σ posted sale totals − Σ counter receipts − Σ received
payments + Σ refunded payments + Σ signed adjustments`. `received` reduces the
  balance; `refunded` increases it; a negative balance is a customer advance.
- Cash per method = counter receipts (`sales.paid_amount`) + received payments −
  refunded payments − posted expenses. Counter receipts are never duplicated into
  `payments`, so cash is not double counted.
- Receivables, cash and profit remain three distinct figures everywhere, including
  on the dashboard, which states why cash and profit differ.
- A counter sale (no customer) must settle in full. A customer sale may be partially
  paid; only overpayment is refused. Opening balances cannot be edited after
  creation — corrections are dated credit/debit notes.
- Documents are voided, never deleted; a void requires a reason, appends reversing
  ledger entries and is excluded from every report.

### Client

- `src/lib/decimal.ts` — BigInt units at an internal scale of 8, half-away-from-zero
  rounding matching PostgreSQL `round(numeric, int)`, no negative zero, per-currency
  scales (0/2/3), display grouping. No JavaScript number ever touches money.
- `src/lib/operation-id.ts` — RFC 4122 v4 ids from `expo-crypto.randomUUID()` (the
  native CSPRNG); throws rather than degrading to a predictable value.
- `src/lib/posting.ts` — one operation id per user action, reused across attempts;
  retries only transport failures; any database answer (including a rejection) is
  surfaced immediately.
- `src/lib/khata-service.ts`, `sales-service.ts`, `expense-service.ts`,
  `summary-service.ts` — the only path from a screen to the server: validate,
  normalize money to the currency scale, attach the operation id, call one RPC.
- `src/lib/sales-service.ts#previewSale` — a pure BigInt preview that mirrors
  `create_sale` exactly, so the total on the phone is the total the server stores.
  It returns a `problem` string rather than silently charging zero.
- `src/lib/business-time.ts` — document dates in the business timezone (never the
  device's), month ranges, and rendering of stored dates without shifting them.
- `src/lib/permissions.ts` — the role matrix mirrored for UI gating only. The
  database remains the authority; a modified client gains nothing.
- `src/types/database.ts` — rewritten for schema version 3: table rows, read-model
  rows, RPC results, and a full `Functions` map with exact `p_*` argument names.
  Financial tables are read-only types (`Insert`/`Update` are `never`).

### Screens

- **Home** — receivables, customer advances, net receivables, cash per method and
  cash on hand, this month's revenue/COGS/gross profit/expenses/net profit with the
  cost-coverage caveat, quick actions, and the activity feed with a link from a
  `sale` entry to its document. Roles that cannot read summaries are told so instead
  of being shown zeros.
- **Khata** — searchable customer list with each real balance (positive = owes you,
  negative = you hold an advance), customer detail with a full statement and a
  running balance per entry, add/edit customer with a one-time opening balance,
  archive/restore with confirmation, record payment/refund, and credit/debit notes.
- **Transactions** — Sales / Payments / Expenses segments over an editable period,
  the period result card for financial roles, inline voiding with a mandatory
  reason, sale entry with a live exact preview of every line and total, sale detail
  showing the snapshotted lines, and expense entry by category and payment method.
- **Items** — catalog with SKU, unit, sale price and cost price, and an explanation
  of what a cost does to gross profit.
- Shared: `OfflineBanner` on every financial screen, `FlashProvider` confirmations
  that report what the server stored, empty/loading/error states everywhere, and
  confirmation before destructive or irreversible actions.

The five required Android bottom tabs (Home, Khata, Transactions, Chat, Settings)
are unchanged; Chat still states that it is not enabled (Phase 6).

## Verification

Environment: Node 22.22.3, npm 10.9.8, Linux x64, no Java/Android SDK/ADB, no
Docker, no local PostgreSQL server, no hosted Supabase project, no EAS account.

| Check                                                       | Result                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `npx tsc --noEmit`                                          | Clean, no output                                          |
| `npx eslint . --max-warnings=0`                             | Clean, zero warnings                                      |
| `npx prettier --check .`                                    | All matched files use Prettier code style                 |
| `npx jest`                                                  | **27 suites, 233 tests passed, 0 failed**                 |
| `npm run test:db` (PGlite, 3 migrations)                    | **13 SQL checks passed**, `schema_version: 3`             |
| `npm run test:postgres` (native PostgreSQL 17)              | **96 checks passed**                                      |
| `npm run test:ledger` (native PostgreSQL 17)                | **220 checks passed**                                     |
| `CI=1 EXPO_OFFLINE=1 npx expo export --platform android`    | **985 modules, ~3 MB Hermes bytecode**, 17 assets, exit 0 |
| `npx expo prebuild --platform android --clean --no-install` | Passed                                                    |
| `npm run check:android`                                     | Passed (native configuration, not compilation)            |

New Jest suites in this phase: `decimal` (12), `sale-preview` (17), `posting` (9),
`operation-id` (2), `permissions` (6), `business-time` (7), `khata-service` (16),
`khata-screen` (14), `home-dashboard` (8), `sale-screen` (8). The Phase 2 baseline
was 17 suites / 133 tests. `sale-screen` deliberately mocks only `client.rpc`, so
the real preview, validation, money normalization and idempotent posting all run.

### What the 220 ledger checks prove

- RLS on every financial table; no client write privileges; no anonymous SELECT or
  EXECUTE; **no policy at all** on `operation_receipts`; read models are not
  `prosecdef`; write RPCs are `prosecdef` with `search_path = ''`.
- Cross-tenant denial on 9 tables and 6 RPCs, including a rival business's product
  id smuggled into a sale line.
- Exact decimals: `3 × 0.1 = 0.30`, a `2.345` tie → `2.35`, `1.5 × 199.999 = 300.00`,
  `100 × 0.01 = 1.00`, JPY → `101`, KWD → `1.235`; 8 malformed decimal literals
  rejected with `22023`.
- Khata identities reconciled against an independent document-level formula
  (`2000.75`, an overpayment producing a `-2999.25` advance, a refund settling to
  `0.00`); immutable opening balances; duplicate phone → `23505`.
- Idempotency: replay returns the stored result with `"replayed": true`; reusing an
  id across sessions or kinds is rejected; a rolled-back attempt poisons nothing;
  and **two independent concurrent connections** posting the same id produce exactly
  one payment and one receipt.
- Voids append reversing entries, keep the original document with reason and actor,
  and block superuser UPDATE/DELETE.
- Catalog snapshots survive later price changes.
- Reports re-derived in SQL inside the test and compared with the RPC output:
  revenue, net profit = revenue − COGS − expenses, gross profit,
  `cogs_coverage_percent`, receivables and cash per method — including a case where
  cash (`-1120.35`) and profit (`323.30`) legitimately disagree.
- Currency lock after financial activity; archived business refuses every financial
  write including voids; a `300.75` concurrency case; activity and audit feed
  content; `schema_version = 3`.

Two real migration bugs were found and fixed by these suites rather than by review:
a `GROUP BY` that omitted a selected column in `expense_categories` (`42803`, which
only appears when a `returns table` function executes) and a negative-zero result
from `round(-0.001, 2)` that would have rendered `-0.00`.

## Main changed/added files

- `supabase/migrations/20261103000100_khata_sales_expenses.sql` — new schema, RLS,
  triggers, read models and write RPCs.
- `scripts/test-ledger.ts` — the Phase 3 accounting suite (220 executing checks).
- `scripts/lib/pg-harness.ts` — shared native-PostgreSQL harness now used by both
  SQL suites; `scripts/test-postgres.ts` refactored onto it.
- `src/types/database.ts` — schema version 3 contract.
- `src/lib/decimal.ts`, `operation-id.ts`, `posting.ts`, `business-time.ts`,
  `khata-service.ts`, `sales-service.ts`, `expense-service.ts`, `summary-service.ts`,
  `permissions.ts` — new; `validation.ts` and `errors.ts` extended.
- `src/screens/home-screen.tsx`, `khata-screens.tsx` (728 lines),
  `transaction-screens.tsx` (990 lines), `catalog-screen.tsx` — new.
- `src/components/ui.tsx` (list rows, segmented control, choices, amount rows,
  money, empty states), `OfflineBanner.tsx`, `flash.tsx` — new/extended.
- `src/hooks/use-network.ts` — one definition of "offline", now also used by
  Settings.
- `src/navigation/app-navigation.tsx` — Phase 3 routes and real tab screens; the
  placeholders for Khata and Transactions are gone.
- `package.json` (`test:ledger`, extended `check`, `expo-crypto`),
  `jest.config.js` (`expo-crypto` mock mapping), `tests/mocks/expo-crypto.ts`.
- `README.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, this file.
- Eight files updated for schema version 2 → 3 (`connection.ts`,
  `FoundationScreen.tsx`, `app.config.ts`, SQL scripts and tests).

A Phase 2 navigation defect was also fixed: "Switch business" on Home and Settings
called `navigate('Businesses')`, but that route is only mounted while the picker is
open, so the action was silently unhandled. It now goes through an explicit
workspace-action context that opens the picker.

## Known limitations (honest)

1. **No hosted Supabase verification.** There is no `.env`, no project, no GoTrue,
   PostgREST, Realtime or Storage in this environment. SQL suites run against a real
   temporary PostgreSQL 17 cluster with minimal `auth.users`/`auth.uid()` fixtures.
   JWT-based access, hosted rate limits and network behaviour are untested.
2. **No APK.** `expo export` produces a JavaScript bundle and `check:android`
   validates generated native configuration. Neither is a compiled or signed APK,
   and no device or emulator test has been run. Java/Android SDK/EAS are absent.
3. **Online-only.** SQLite is installed but unused. There is no cache, no outbox and
   no conflict resolution yet; offline is reported visibly and no financial data is
   queued or discarded silently. That work is Phase 7.
4. **No Realtime.** Lists refresh on focus and on an explicit Refresh button;
   another device's change is not pushed live.
5. **Scope gaps inside Phase 3 features:** no invoicing, tax, sales returns or
   per-invoice payment allocation (the khata balance is per customer, and
   `payments.sale_id` is context only); no stock quantities, so cost of goods is the
   cost recorded on the line; no audit-log browser UI (audit rows are written and
   tested); pagination is capped at 200 customers/items and 100 documents per list.
6. **Cost coverage is user-dependent.** An item without a cost price sells fine but
   understates COGS; the report shows the coverage percentage rather than hiding it.
7. Development dependencies still emit deprecation warnings on install. The clean
   production audit is not a claim about every transitive dev package.
8. Nothing has been committed or pushed by the agent; all work is in the working
   tree on `arena/b7b90880-ownerbook`.

## Manual actions required from you

Setup (once):

1. `npm ci`, then `cp .env.example .env` and set
   `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (never a
   service-role key).
2. Apply **all three** migrations in order with the Supabase CLI or the SQL editor,
   as described in `supabase/README.md`. Confirm `select * from public.ownerbook_health();`
   reports `schema_version = 3`.
3. Configure the Auth redirect URLs for the `ownerbook://` scheme.
4. `npm run check:env`, then `npm start` or `npx expo run:android`.

Acceptance (staging data only):

5. Create a business, pick a currency with a non-2 scale (for example JPY or KWD)
   and confirm amounts render at that scale; then try to change the currency after
   the first financial record and confirm it is locked.
6. Khata: add a customer with an opening balance, add a second with none, record a
   multi-line sale on credit, then a partial payment, then a refund. Confirm the
   statement's running balance and the Home receivables figure agree, and that an
   overpayment turns into a customer advance.
7. Idempotency on a real network: record a payment, and while it is in flight enable
   airplane mode. Confirm the app reports the failure, that nothing was saved, and
   that after reconnecting a single retry produces exactly one payment.
8. Voids: void a payment and a sale with reasons; confirm reversing ledger entries,
   that the documents are still readable with their reasons, and that reports
   exclude them.
9. Permissions: invite a Staff member and confirm they can add customers, sell and
   take payments, but see no expenses, no summaries, no void buttons and no catalog
   management; then confirm the same refusals if they call the API directly.
10. Isolation: with a second business, confirm its customers, sales and reports are
    invisible from the first.
11. Small-screen and TalkBack pass on a real device, plus an offline pass with
    airplane mode to confirm the banner and the honest failure messages.
12. Only after the above: link your own Expo project and run
    `npm run build:android:preview` for an installable APK (see
    `docs/ANDROID_BUILD.md`). This repository does not authorize paid upgrades.
