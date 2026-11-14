# OwnerBook architecture and implementation contracts

Status: Phase 3 customer khata, sales and expenses implemented locally on top of
Phase 2 identity/tenancy. Suppliers, inventory, payroll and chat remain design
contracts, not implemented features. PostgreSQL is the source of truth: every
balance, total and report in the app is a stored or server-computed value. The
Android app never receives a database password or service-role key.

## 1. Runtime and module boundaries

- Expo SDK 58, React Native 0.88, React 19.3 and strict TypeScript.
- Android application ID: `app.ownerbook.mobile`. Native projects are generated from
  `app.config.ts`; the generated `android/` directory is ignored, not a second source of truth.
- Supabase JS 2: Auth, PostgREST, Realtime and Storage against the user's project.
- Expo SecureStore: bounded, OS-encrypted session chunks with a last-write manifest.
- Expo SQLite: installed for the Phase 7 scoped cache/outbox. No offline financial
  writes are enabled yet; an installed dependency is not an implemented sync engine.
- EAS Build: explicitly configured to produce APKs, not only Play Store AABs.

Current source layout:

```text
App.tsx                         Android composition root
app.config.ts                   Validated Expo / Android configuration
src/config/                     Public environment validation
src/components/                 Shared UI primitives, offline banner, flash notices
src/providers/                  Auth recovery gate and account-scoped workspace
src/navigation/                 Auth/business gates and five Android bottom tabs
src/screens/                    Auth, business, member, settings, home, khata,
                                transaction and catalog UI
src/hooks/                      Connection lifecycle, network state, invite links
src/lib/                        Supabase client, sessions, domain services, exact
                                decimal money, operation ids, idempotent posting,
                                business-time dates, permissions and validation
src/types/                      Hand-maintained schema version 3 / RPC contract
supabase/migrations/            Forward, version-controlled SQL (3 migrations)
tests/                          TypeScript, Android-rendered UI and adapter tests
scripts/lib/pg-harness.ts       Shared native-PostgreSQL assertion harness
scripts/test-database.ts        PGlite migration/health checks
scripts/test-postgres.ts        Native PostgreSQL RLS/RPC/concurrency checks
scripts/test-ledger.ts          Native PostgreSQL Phase 3 accounting checks
.github/workflows/ci.yml        Tests, bundle export and native generation
```

Financial feature code must call a typed domain service, not assemble writes from
unrelated client requests: screens call `khata-service`, `sales-service`,
`expense-service` or `summary-service`, which validate, normalize money to the
business currency scale, attach one operation id and call a single RPC. The
required Home/Khata/Transactions/Chat/Settings tabs exist; Chat still says it is
not enabled. Future modules can be grouped under `src/features/` with
`src/lib/offline`. No financial cache/outbox is enabled yet, so Phase 3 is
online-only and says so when the device is offline.

## 2. Persistence and schema plan

Every business-owned table contains a non-null `business_id` referencing businesses.
Child rows use composite foreign keys where necessary to ensure that a sale item,
payment allocation, product or employee belongs to the same business as its parent.
Deleting a business must not cascade away financial history.

Required tables, grouped by ownership boundary:

| Boundary           | Tables                                               |
| ------------------ | ---------------------------------------------------- |
| Identity / tenancy | profiles, businesses, business_members, invitations  |
| Partners           | customers, suppliers                                 |
| Sales / purchasing | sales, sale_items, purchases, purchase_items         |
| Accounting         | expenses, payments, customer_ledger, supplier_ledger |
| Inventory          | products, stock_movements                            |
| People             | employees, attendance, salaries                      |
| Communication      | chat_messages, chat_attachments                      |
| Traceability       | activity_logs, audit_logs, notifications             |

Supporting migrations will add immutable `operation_receipts`, payment allocations,
salary advances/components, expense categories, cash/bank accounts and paired
account movements where needed. These are not seeded or exposed in Phase 1.

Use UUID primary keys; timestamptz in UTC; numeric money/quantity columns (never
PostgreSQL real/double precision); check constraints for signs and valid states;
unique natural identifiers scoped by business; indexes on `(business_id, date)`,
foreign keys, outstanding ledger queries and chat `(business_id, created_at)`.
Important financial records are voided/reversed, not hard-deleted. Display names,
contact details and catalogs may be archived. Currency is fixed per business after
financial activity; timezone controls presentation and business-date boundaries,
not the storage timezone.

## 3. Accounting method

Implemented in Phase 3 (migration `20261103000100_khata_sales_expenses.sql`):

- Revenue = the sum of posted `sales.total`, which is `subtotal - discount_total`
  and is recomputed by PostgreSQL from the submitted lines. Line totals are
  `round(quantity x unit_price) - round(discount)` at the currency scale, rounded
  per line before summing, so the phone preview and the stored document agree.
- COGS = the sum of posted `sales.cogs`, built from `sale_items.unit_cost x
quantity`. In Phase 3 the cost is the one recorded on the line (taken from the
  catalog item, or entered for a custom item). `period_summary.cogs_coverage_percent`
  reports how much of the period's revenue has a recorded cost, so an uncovered
  gross profit is visible instead of silently optimistic.
- Gross profit = revenue - COGS. Net profit = gross profit - posted expenses.
- Customer outstanding = the sum of signed `customer_ledger.amount` for that
  customer, and it reconciles with
  `opening_balance + posted sale totals - counter receipts - received payments +
refunded payments + signed adjustments`. `received` reduces the balance,
  `refunded` increases it; a negative balance is a customer advance, not a debt.
- Cash per method = counter receipts on `sales.paid_amount` + received payments -
  refunded payments - posted expenses. Counter receipts are never duplicated into
  `payments`, so cash is not double counted.
- Receivables, cash, and profit are three separate figures on the dashboard.

The mobile client uses an exact decimal library (`src/lib/decimal.ts`: BigInt units
at an internal scale of 8, half away from zero) for entry arithmetic and serializes
decimal strings; PostgreSQL performs authoritative numeric arithmetic with
`numeric` columns only. No binary floating-point totals, JS-number money columns or
client-supplied profit. Money crosses the API as text at exactly the currency's
minor units for totals and balances, and in shortest-exact form for unit prices and
quantities.

Planned with later financial migrations: use **perpetual moving weighted-average
inventory cost** in place of the manually recorded line cost.

- Sale revenue: line amounts after discounts, excluding tax (Phase 3 records no tax;
  invoices with tax arrive with the invoice module). Tax is a liability,
  not revenue. Invoice total includes tax. Returns reverse the original revenue,
  tax and receivable using references to original lines; they do not create a new
  negative cash sale unless money was actually refunded.
- COGS: quantity sold multiplied by the product's average unit cost at posting
  (Phase 3 uses the cost recorded on the line; Phase 4 replaces it).
  A sale return restores the original recorded cost and stock only when goods are
  actually returned to sellable inventory. Purchase returns reverse original cost.
  Updates lock product rows in a deterministic order inside the same transaction.
- Gross profit = net sales revenue − COGS.
- Net profit = gross profit − operating expenses, including earned salary expense
  and recognized stock write-downs. Paying an already-recorded liability is not a
  second expense. Salary advances are assets until applied to payroll.
- Customer receivables = posted credit ledger entries − receipts − returns −
  approved reversals. Implemented for customers in Phase 3 as the append-only
  `customer_ledger`; supplier payables use the corresponding purchase/payment
  ledger in Phase 4. Partial payments are explicit ledger entries; they are never
  inferred from display text. Phase 3 has no per-invoice allocation: the khata
  balance is per customer, and `payments.sale_id` is context only.
- Stock = opening + purchases + sale returns + adjustments − sales − purchase
  returns. Every movement references its source line. Negative stock is blocked
  unless a later, explicitly documented backorder policy permits it.
- Stock value = on-hand quantity multiplied by current moving-average cost.
  Adjustment movements distinguish quantity corrections, damage and write-downs.
- Cash and bank balances = opening account balances + actual account movements.
  Credit sales, receivables, supplier payables and profit are separate measures.
  Cash-to-bank transfers create two paired movements and no revenue or expense.
- Daily/weekly/monthly reports use the business timezone to select date boundaries,
  then aggregate stored UTC records. Accrual profit and cash movement are separate
  sections, with a reconciliation rather than a misleading combined total.

A multi-record financial operation is one PostgreSQL transaction. Locks, constraints,
source references and operation receipts commit together with ledger entries,
activity and audit records. Phase 3 writes are `SECURITY DEFINER` functions with an
empty `search_path` that lock the business row, recompute every amount from the
submitted text, append the ledger entries, record the receipt and write the activity
row in a single transaction. Read models are `SECURITY INVOKER` so RLS filters them a
second time. Never calculate an invoice total from untrusted client input without
server-side recomputation: the client preview is a convenience, and the server's
number is the one that is stored.

## 4. Database-enforced authorization

Permission matrix. Identity rows are implemented (Phase 2); the financial rows are
implemented in Phase 3 and enforced by `private.require_roles` inside every write
RPC plus RLS on every read model. `src/lib/permissions.ts` mirrors the same matrix
so the UI does not offer an action the database will refuse — it is gating only,
never the authority.

| Capability                            | Owner | Co-owner       | Manager         | Accountant         | Staff       |
| ------------------------------------- | ----- | -------------- | --------------- | ------------------ | ----------- |
| Business settings                     | Yes   | No             | No              | No                 | No          |
| Invite                                | Yes   | Delegated only | No              | No                 | No          |
| Change roles / remove members         | Yes   | No             | No              | No                 | No          |
| Add / edit customers, record sales    | Yes   | Yes            | Yes             | Yes                | Yes         |
| Record customer payments              | Yes   | Yes            | Yes             | Yes                | Yes         |
| Archive customers, manage the catalog | Yes   | Yes            | Yes             | Yes                | No          |
| Khata credit / debit notes            | Yes   | Yes            | Yes             | Yes                | No          |
| Void sales, payments and expenses     | Yes   | Yes            | Yes             | Yes                | No          |
| Record and read expenses              | Yes   | Yes            | Yes             | Yes                | No          |
| Read financial summaries and reports  | Yes   | Yes            | Yes             | Yes                | No          |
| Read audit logs                       | Yes   | Yes            | No              | No                 | No          |
| Read the business activity feed       | Yes   | Yes            | Yes             | Yes                | Yes         |
| Purchases / suppliers (Phase 4)       | Yes   | Yes            | Yes             | Yes                | No          |
| Employee administration / payroll     | Yes   | Delegated only | Attendance only | Authorized payroll | Own records |
| Business chat (Phase 6)               | Yes   | Yes            | Yes             | Yes                | Yes         |

All private tables have RLS enabled. Membership/role helper functions live in the
non-public `private` schema, use a fixed search path and avoid recursive member
policies. Readable tables use membership-scoped `using` policies; profile updates also use
own-row `with check`. Privileged tables have no direct client write policy and use
validated RPCs instead. Financial table
writes go through validated RPCs; actor identity comes from `auth.uid()`, never a
client parameter. Privileged helpers are narrowly scoped, explicitly granted and
tested; do not make every RPC SECURITY DEFINER to bypass design mistakes.

Invitations use 256-bit random tokens, store only a SHA-256 hash, have an
expiry/revocation state, optionally bind a confirmed email, constrain the granted
role/business, and are consumed under business/invitation row locks with a unique
membership constraint. Raw tokens are returned once and kept only in memory on the
client. Email delivery uses the user's email app, not an automatic paid provider. A member cannot elevate their own
role. Last-owner protection is enforced in the database.

Chat attachments use a private Storage bucket and business-prefixed object paths.
Storage policy checks message ownership and current membership. Only validated
image/audio MIME types and size limits are accepted; no video, PDF or arbitrary
file upload. Downloads use short-lived signed URLs. Realtime subscriptions use
private channels and the same RLS checks. Removing a member revokes future reads;
already downloaded content cannot be remotely erased.

## 5. Idempotency and offline synchronization contract

Financial create/void commands carry a client-generated UUID `operation_id`, scoped
to `(business_id, actor_id, operation_id, kind)`. The server stores a canonical
payload hash and the committed result in `operation_receipts` in the same
transaction. A retry with the same hash returns the original result with
`"replayed": true`; the same id with a changed payload, a different kind or a
different session is rejected. Never use amount/date similarity as a
duplicate-detection rule. Clients cannot read `operation_receipts` at all.

Implemented in Phase 3 on both sides:

- `src/lib/operation-id.ts` generates a validated RFC 4122 v4 id from
  `expo-crypto.randomUUID()` (the native CSPRNG, not `Math.random`) and throws
  rather than degrading if the platform cannot produce one.
- `src/lib/posting.ts` generates exactly one id per user action and reuses it for
  every attempt at that action. Only transport failures (network, fetch, timeout,
  aborted, socket errors) are retried; any database answer, including a rejection,
  is surfaced immediately so a refusal is never hidden behind a retry loop.
- Every write RPC takes `p_operation_id uuid` as its first argument and calls
  `private.begin_operation` / `private.finish_operation` around its work.

The Phase 7 SQLite outbox will store operation ID, business/account scope, schema
version, payload, expected record version, status, attempt count and retry time.
Only explicitly supported commands can be queued. The UI must distinguish cached,
pending, syncing, committed, failed and conflicting records. Financial mutations
remain pending until a server receipt is obtained. A lost response is resolved by
looking up the operation ID before retrying, not by creating a new ID.

Edits use optimistic version preconditions. Conflicts retain both the unsent local
payload and the latest server version for explicit resolution or a compensating
operation. There is no silent last-write-wins for financial data. Sign-out/account
switch must not expose one account's cache to another or discard an unresolved
outbox. Server permissions are checked again at sync time. Retry backoff is bounded;
permanent validation/permission failures remain visible and are not endlessly retried.

## 6. Activity, audit and testing

Activity logs are the user-facing business timeline: actor display name, action,
amount/currency, timestamp and source record. Audit logs are immutable technical
records with actor, operation ID, before/after values and source reference. Database
triggers/RPCs create them atomically with the underlying change. Notifications are
records, not a substitute for audit history. No external logging service receives
message bodies, credentials or financial payloads by default. Phase 2 audit rows
cover tenant/member/invitation changes; the activity feed and audit browser are later work.

Required release gates include cross-business reads/writes, role escalation,
invitation reuse/expiry, ledger balance identities, payment allocation, duplicate
retries, transaction rollback, inventory cost/return behavior, payroll duplication,
chat/storage/Realtime isolation, activity/audit creation and offline conflict tests.
Run SQL tests with real PostgreSQL semantics and run critical concurrent cases on
the actual Supabase project. A mocked adapter test is not a device Keystore test;
a JavaScript bundle export is not an APK; a local SQL test is not a hosted API test.
