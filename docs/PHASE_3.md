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
Docker, no local PostgreSQL server, no EAS account. A hosted Supabase project is now
provisioned, migrated and verified; see the next section.

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

## Hosted Supabase verification

The Supabase project `OwnerBook` (`uplbjnbislmzmiykiylt`, eu-west-1, PostgreSQL
17.11.003) was paused. After restoring it, inspection showed an **unrelated earlier
scaffold**: 13 tables (`transactions`, `stock_transactions`, `salary_transactions`,
`staff`, `chat_messages`, …), **0 rows in every table**, **0 `auth.users`**, 0
policies, no `private` schema and one platform function. Five names collided with
OwnerBook's (`businesses`, `business_members`, `customers`, `products`, `profiles`),
so the scaffold was dropped with the owner's approval. Nothing was lost: no rows and
no users existed. The platform's `rls_auto_enable` event trigger was kept, because it
enforces RLS on every new `public` table.

This sandbox has no network route to Supabase (DNS resolves, connections are
blocked), so the migrations were applied **server-side**. The project's own
`extensions.http_get` fetched each file from `raw.githubusercontent.com` at an
immutable commit SHA; the SHA-256 of the fetched bytes was compared with the
repository's `sha256sum` and only then was the script executed:

| Migration                                 | Bytes  | SHA-256 verified identical on both sides |
| ----------------------------------------- | ------ | ---------------------------------------- |
| `20261101000100_foundation.sql`           | 1168   | `11ecd2e7af6cbece…5d619bdbd`             |
| `20261102000100_identity_businesses.sql`  | 29924  | `b64d19ac63f9564c…7daf945f`              |
| `20261103000100_khata_sales_expenses.sql` | 102630 | `e033ac41971528c3…a26a9e872`             |

Each file's own `begin;`/`commit;` lines were stripped before `EXECUTE`, because
transaction control is illegal inside a PL/pgSQL block; atomicity is preserved since
the whole script runs in one transaction. A deliberately broken attempt (an invalid
`encode(…, 'sha256')` algorithm name) confirmed the rollback: the project still
reported version 2 and 6 tables afterwards.

**Result on the hosted project:** `schema_version = 3`, 15 tables, 159 columns,
34 public functions, 25 private functions, 14 policies, 25 trigger events,
40 indexes, **0 tables without RLS**, **0 float money columns**. Migration history was
recorded in `supabase_migrations.schema_migrations` with the same three versions as
the filenames, and the Supabase API reports exactly those three, so `supabase
migration list` / `db push` will treat them as applied rather than re-applying them.

### Hosted schema equals the local schema

`scripts/sql/schema-fingerprint.sql` digests ten categories of schema definition.
The same text runs locally (`npm run fingerprint`) and on the hosted project.

| Category                   | Local              | Hosted             | Verdict                                  |
| -------------------------- | ------------------ | ------------------ | ---------------------------------------- |
| `cols` (159 columns)       | `7e1d65298f168753` | `7e1d65298f168753` | identical                                |
| `fns` (59 functions)       | `243e48d29d3da6d5` | `243e48d29d3da6d5` | identical                                |
| `pol` (14 policies)        | `fae44a7677e15bb9` | `fae44a7677e15bb9` | identical                                |
| `rls` (15 tables)          | `afb7f604d402d850` | `afb7f604d402d850` | identical                                |
| `trg` (25 triggers)        | `46f28bbe40e7c85d` | `46f28bbe40e7c85d` | identical                                |
| `idx` (40 indexes)         | `381cd5e630884cb5` | `381cd5e630884cb5` | identical                                |
| `nsp` (private schema ACL) | `028a1751d9ca9718` | `028a1751d9ca9718` | identical                                |
| `acl` (15 table ACLs)      | `0c18e004db83c625` | `1f659901d38857c9` | differs: `service_role=arwdDxtm`         |
| `tg` (table grants)        | 13 lines           | 118 lines          | differs: +105 = 15 tables × 7 privileges |
| `fg` (function grants)     | 45 lines           | 79 lines           | differs: +34 `service_role` EXECUTE      |

The three differences are Supabase's own `ALTER DEFAULT PRIVILEGES`, and the
arithmetic is exact. A per-line fingerprint (`scripts/sql/line-fingerprint.sql`)
proved it: **124 of 124 function, trigger and index lines matched one-for-one**, with
no line present on only one side. So the earlier whole-category digest mismatch was
ordering, not schema.

`scripts/sql/grant-audit.sql` answers the security questions directly, and both sides
agree on everything that matters: **0 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
grants to `anon`/`authenticated`**, 13 RLS-filtered SELECT grants (needed by the
SECURITY INVOKER read models), EXECUTE on exactly 8 private helpers
(`active_business_ids`, `has_role`, `is_member`, `money_scale`, `require_roles`,
`role_business_ids`, `round_money`, `shares_business`) and **not** on the
tenant-probing helper, 0 EXECUTE for `PUBLIC` or `service_role` on any OwnerBook
function, an identical `private` schema ACL (`postgres=UC`, `authenticated=U`), and
22 SECURITY DEFINER functions all with a pinned `search_path`.

### A real fidelity bug this comparison found

The local harness cluster was **SQL_ASCII with the C collation**, because the sandbox
locale is POSIX. Under SQL_ASCII `char_length()` counts **bytes**, so the 1–120
character validation limits were being tested against a different encoding than
production, and non-ASCII input was never validated as UTF-8. The harness now
initialises with `C.utf8` and asserts UTF8 before applying migrations, so a locale
regression fails loudly. `en_US.UTF-8` (hosted) cannot be generated here: no
charmaps, no root. The fingerprint therefore orders every category by the SHA-256 hex
of each line — plain ASCII, so the digest is collation-independent — and the residual
collation difference is documented rather than hidden.

### 28 behavioural acceptance checks on the hosted project

`scripts/sql/hosted-acceptance.sql` runs the real RPCs end to end and was executed on
the hosted project: **28 passed, 0 failed** (`npm run test:acceptance` runs the same
file locally first, 29 lines including the harness's own migration check).

It proves, against hosted Postgres with real `auth.uid()` and real RLS: the profile
trigger fires on `auth.users`; business creation records the owner; a khata opens with
an exact balance; the catalog's four-decimal price is snapshotted;
`1.5 × 199.999` rounds to `300.00` per line and totals to `400.50 − 0.50 = 400.00`
with COGS `210.00`; a repeated `operation_id` replays instead of double-posting a
customer or a sale; a partial payment leaves exactly `800.00`; an overpayment becomes
an exact visible advance (`-99199.00`) and a refund settles it back to `800.00`;
voiding a payment or sale appends reversing entries and keeps the document; net profit
is `400.00 − 210.00 − 250.75 = -60.75`; three `0.10` adjustments sum to exactly
`0.30`; statement running balances equal the cumulative ledger sum and the closing
balance; the currency locks once history exists; every write produced an activity row;
an authenticated client has no INSERT/UPDATE privilege; non-members are refused
outright (`42501`) on reads and writes; isolation is symmetric; the ledger rejects
UPDATE even for the table owner; and the health endpoint reports version 3.

**The run left nothing behind.** All work happens inside a PL/pgSQL block whose
changes a deliberate exception rolls back, while the results array survives because
variables are not part of the subtransaction — necessary, because the financial
triggers block DELETE even for the owner. Afterwards every public table and
`auth.users` were counted again: all **0**.

Writing this suite exposed three wrong expectations of mine, all in the test rather
than the product, and all corrected: an overpayment is a documented **advance**, not
an error (the ledger suite already asserted `-2999.25` then a refund to zero);
read models **raise `42501` "Membership required"** for non-members instead of
returning zero rows, which is stronger defence in depth; and a reused `v_pay` variable
made the void target the refund instead of the original payment.

### Configuration applied to the project

- Auth `site_url` = `ownerbook://auth/confirmation`; redirect allowlist =
  `ownerbook://auth/confirmation,ownerbook://auth/recovery`. Signup, email auth,
  JWT expiry (3600 s) and email confirmation were left as they were. The API also
  normalised four platform-managed fields to `null` (`rate_limit_email_sent`,
  `security_captcha_provider`, `sms_provider`, session timeouts); captcha, SMS and
  phone auth are disabled, so this changes no behaviour.
- `.env` was written locally with the project URL and the **publishable** key
  `sb_publishable_0gGFg…`. It is gitignored (`git check-ignore` confirms, `git status`
  is clean). The legacy `service_role` JWT and the `sb_secret_…` key were **never**
  written to any file, and never leave the server side.
- `npm run check:env` passes. All eight services report `ACTIVE_HEALTHY`: GoTrue
  v2.197.0, PostgREST (exposing `public,graphql_public`), Realtime, Storage, the
  database, pooler and pg_bouncer.

## Known limitations (honest)

1. **Hosted verification covers the database, not a real client.** The project is
   migrated, schema-identical to the local one and passes 28 behavioural checks, but
   no request has travelled from an app through GoTrue/PostgREST: issued JWTs, the
   publishable key over HTTP, hosted rate limits, Realtime channels and Storage
   buckets are still untested. The local suites use a minimal `auth.uid()` fixture,
   and the hosted acceptance run sets the JWT claim directly instead of signing a
   token.
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
8. **Collation differs from production.** The local cluster is `C.utf8`; hosted is
   `en_US.UTF-8`. Text `ORDER BY` (customer and item names) can therefore sort
   differently in tests than on a device. `en_US.UTF-8` cannot be generated in this
   sandbox, so this is documented rather than fixed.

## Manual actions required from you

Setup (once):

1. **Done for the provisioned project** (`uplbjnbislmzmiykiylt`): `.env` written with
   the URL and publishable key, all three migrations applied and recorded in
   `supabase_migrations.schema_migrations`, Auth redirect URLs set, `check:env`
   passing. For any _other_ project, repeat these steps as described in
   `supabase/README.md`, and re-run `scripts/sql/hosted-acceptance.sql` against it.
2. If you use your own machine instead: `npm ci`, `cp .env.example .env`, apply the
   three migrations in order, confirm `ownerbook_health()` reports `schema_version = 3`,
   set the `ownerbook://` redirect URLs, then `npm run check:env`.
3. Re-run the hosted acceptance suite after any future migration, and re-run
   `npm run fingerprint` on both sides to confirm the schemas still match.
4. `npm start` or `npx expo run:android` once a device or emulator is available.

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
