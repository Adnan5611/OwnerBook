# OwnerBook

Android-first business management and accounting, built with React Native, Expo, TypeScript and Supabase. **Current milestone: Phase 3 — customer khata, sales, payments, expenses and real reports, on top of Phase 2 authentication, businesses, invitations and database-enforced permissions.**

This is a native Android application, not a website-only dashboard. Every balance, total and report comes from PostgreSQL records; nothing is estimated, sampled or hardcoded. Inventory, payroll and chat still state clearly that they are not enabled yet.

## Implemented in this checkpoint

- Customer khata: add/edit/search customers, an opening balance that can only be set once, archive/restore, and an append-only ledger statement with a running balance per entry.
- Sales: multi-line sales from the catalog or as custom items, per-line discounts, cash/bank/wallet/cheque/credit, counter sales that must settle in full, and partial payments that leave an exact due amount.
- Exact money: BigInt decimal arithmetic on the phone (`3 × 0.1 = 0.30`, `1.5 × 199.999 = 300.00`) mirroring PostgreSQL `numeric` rounding, so the previewed total is the stored total.
- Idempotency: every financial write carries a UUID v4 operation id generated once per action and reused on retry; the server replays the stored receipt instead of posting twice. Only transport failures are retried — a database rejection is shown, never looped.
- Payments and refunds against a khata, plus dated credit/debit notes for corrections, and voiding of sales, payments and expenses with a mandatory reason (records are reversed, never deleted).
- Categorized expenses by payment method, with expenses kept out of customer balances.
- Dashboard and Transactions reports calculated in SQL: receivables, customer advances, net receivables, cash per method, revenue, COGS, gross profit, expenses, net profit, cash in/out and how much revenue has a recorded cost.
- Item catalog with SKU, unit, sale price and cost price; a sale snapshots the name, price and cost, so later catalog edits never rewrite history.
- Activity feed for all 15 financial actions, linked from the Home screen to the sale it describes.
- Role-gated UI matching the database matrix: every member can sell and collect; only owner/co-owner/manager/accountant see expenses, summaries, voids, notes and the catalog; only owners read the audit log.
- Offline is reported honestly on every financial screen: Phase 3 reads and writes need the server, and nothing is queued silently (the SQLite outbox arrives in Phase 7).

## Implemented in Phase 2

- Email/password registration, sign-in, email confirmation callbacks, password recovery and a recovery-only password update gate.
- SecureStore-backed sessions and recovery markers; global/local sign-out; account-scoped workspace state.
- Persistent profiles, multiple businesses, business switching, currency/timezone settings and reversible archiving.
- Owner / Co-owner / Manager / Accountant / Staff membership roles, ownership transfer and last-active-owner protection.
- Server-generated, hashed, expiring, single-use invitations with optional confirmed-email binding, revocation and delegated co-owner invitation permission.
- Team management, business-specific display names and atomic audit records for important tenant changes.
- RLS on every private table; no direct client writes to businesses, memberships, invitations or audit logs.
- Required native bottom tabs: **Home, Khata, Transactions, Chat, Settings**. Only Home/Settings and business/team workflows are operational in this phase.
- Real PostgreSQL isolation/privilege tests, including independent connections and an accept/revoke race.
- Validated public configuration, Android APK build profiles and local/CI verification gates.

**Not delivered yet:** hosted Supabase verification, a signed/installable APK, suppliers/purchases, stock quantities and valuation, payroll, chat, invoicing with tax, sales returns, an audit browser, or offline financial synchronization. SQLite is installed but its cache/outbox is deliberately not enabled. No paid service has been provisioned.

See [the Phase 3 report](docs/PHASE_3.md) for exact verification, changed files, limitations and manual acceptance steps. [Phase 2](docs/PHASE_2.md) and [Phase 1](docs/PHASE_1.md) remain historical checkpoints.

## Quick start

Requirements: Node **22.22.3** (see `.nvmrc`), npm, a Supabase project you control, and an Android device/emulator for native testing. Native PostgreSQL tests run as a non-root user on Linux x64; see the database guide for other platforms.

```sh
npm ci
cp .env.example .env
```

Set these using your project's API settings:

```dotenv
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
```

Only a publishable key or legacy **anon** key belongs in the app. Never use a secret/service-role key or database password. Expo public variables are embedded in the APK; database RLS and server-side checks are the actual access controls.

Apply **all three ordered migrations** and configure Auth redirect URLs using [supabase/README.md](supabase/README.md). The required schema version is **3**. Then:

```sh
npm run check:env
npm start
```

For native development, use `npx expo run:android` with Java/Android SDK installed, or build the EAS development profile. Expo Go can be used for initial development, but its installation-specific `exp://` callback must be allowlisted separately. Test the stable `ownerbook://` scheme in a development/preview APK before release.

### First-run workflow

1. Register a test account and confirm its email (or use an already confirmed account).
2. Sign in, create a business, and choose its currency and IANA timezone.
3. From Settings, edit your profile or open Team and permissions.
4. As Owner, generate an **email-bound** invitation for a second confirmed account. Send it using your email app; delivery is not automated.
5. On the second account/device, open the invitation or paste it into Join business. Review the business/role, then accept.
6. Confirm the member appears in the team list. Test a role change and revocation on staging data.
7. Switch businesses from Home/Settings. Use Refresh after membership changes on another device; live membership subscriptions are not implemented yet.
8. In **Khata**, add a customer with an opening balance, then open it to see the statement.
9. In **Transactions → Sales**, record a multi-line sale (pick a catalog item, or use a custom item), watch the exact totals, and save it as cash or credit.
10. Record a partial payment against that customer and confirm the balance and the statement's running totals move correctly.
11. Record an expense, then check the Home dashboard: revenue, cost of goods, gross profit, expenses, net profit and cash per method.
12. Void a payment or sale with a reason and confirm the reversing ledger entry and that the original document is still readable.

## Verification

```sh
npm run check                         # types + lint + format + Jest + all three SQL suites
npx expo export --platform android --output-dir dist
npx expo prebuild --platform android --clean --no-install
npm run check:android                 # native configuration, not compilation
npm audit --omit=dev --audit-level=high
```

See [docs/TESTING.md](docs/TESTING.md). Mocked SecureStore/Auth tests and embedded PostgreSQL checks are not substitutes for physical-device and hosted-project tests. `test:postgres` uses real native PostgreSQL 17, starts a temporary local cluster, and removes its test data afterward. It does not start Supabase Auth or PostgREST.

## Android APK

Read [docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md). Link your own Expo project, configure public build variables, and explicitly accept signing/build options. Then `npm run build:android:preview` creates an internal APK; `npm run build:android:production` creates a release APK. Both require Expo authentication and available quota. This repository does not authorize paid upgrades or unattended purchases.

The final product release remains gated on all modules, hosted security tests, device QA and an actual signed APK. A JavaScript bundle or generated Android directory is **not** an APK.

## Project map

- `App.tsx`, `src/providers/`, `src/navigation/`, `src/screens/` — native auth, business, khata, sale, expense, catalog and dashboard workflows
- `src/lib/` — typed domain services, exact decimal money, operation ids, idempotent posting, business-timezone dates, permissions, secure sessions and validation
- `src/types/database.ts` — hand-maintained schema/RPC contract; regenerate from staging before release
- `supabase/migrations/` — authoritative SQL changes, including the Phase 3 khata/sales/expenses schema, RLS and RPCs
- `tests/`, `scripts/` — unit/UI/provider checks plus three SQL suites (`test:db`, `test:postgres`, `test:ledger`)
- `docs/ARCHITECTURE.md` — accounting, permissions and sync contracts
- `docs/PHASE_3.md` — current scope, verification and outstanding work

## Delivery status

| Phase | Scope                                                 | Status                                                |
| ----- | ----------------------------------------------------- | ----------------------------------------------------- |
| 1     | Expo architecture, Supabase connection, build setup   | Implemented locally; historical report retained       |
| 2     | Auth, businesses, invitations, roles and RLS          | Implemented locally; hosted/device acceptance pending |
| 3     | Customers, khata, payments, sales, expenses           | Implemented locally; hosted/device acceptance pending |
| 4     | Suppliers, purchases, inventory                       | Not implemented                                       |
| 5     | Staff, attendance, payroll                            | Not implemented                                       |
| 6     | Chat, voice/photos, activity feed                     | Not implemented                                       |
| 7     | Reports, SQLite cache/outbox, audit UI                | Not implemented                                       |
| 8     | Hosted security tests, device QA, signed APK delivery | Not completed                                         |

Keep secrets, `.env`, signing credentials, generated native folders and APK binaries out of Git. Do not mark a feature production-complete without its relevant tests.
