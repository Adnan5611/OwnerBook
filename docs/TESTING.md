# Testing and release gates

## Automated local commands

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:db
npm run test:postgres
npm run test:ledger               # Phase 3 accounting identities on real PostgreSQL
npm run check:env                 # requires your public project configuration
npx expo export --platform android --output-dir dist
npx expo prebuild --platform android --clean --no-install
npm run check:android             # after prebuild; not a native compilation test
EXPO_OFFLINE=1 npx expo install --check
npm audit --omit=dev --audit-level=high
```

`npm run check` combines type checking, lint, formatting, Jest and all three SQL suites. It does not require a hosted account or claim hosted integration coverage.

### Jest / Android-rendered UI

The Android React Native preset and React Native Testing Library cover:

- Public environment validation and rejection of secret/service-role keys.
- Bounded SecureStore session storage, interrupted writes, corruption and sign-out.
- Supabase PKCE/client options, AppState refresh lifecycle and real health-probe behavior.
- Auth/recovery validation, callback allowlisting, auth provider restoration/recovery gating and account services.
- Tenant-scoped workspace selection, removal fallback, stale response handling and failure states.
- Native auth forms, business creation, invitation preview/acceptance, role-gated team actions and confirmation before removal.
- Authenticated navigation gate and all five required bottom tabs, now routing to the real khata, transaction and catalog screens.
- Android/EAS configuration and APK output settings.

Phase 3 adds:

- `decimal.test.ts` — exact BigInt money: rejected literals, half-away-from-zero rounding that matches PostgreSQL `round(numeric, int)`, no negative zero, `3 x 0.1 = 0.30`, `1.5 x 199.999 = 300.00`, currency scales 0/2/3 and display grouping.
- `sale-preview.test.ts` — the preview reproduces `create_sale`: per-line rounding before summing, subtotal/discount/total/COGS/paid/due, and every refusal (line discount over the line, overpayment, negative receipt, credit with money received, cash with none, an unsettled counter sale, a zero total, an unparseable amount, an incomplete line).
- `posting.test.ts` and `operation-id.test.ts` — one operation id per action reused across retries, retries only for transport failures, immediate surfacing of database rejections, UUID v4 shape and a hard failure when the device cannot produce a safe id.
- `permissions.test.ts` — the client capability matrix for all five roles plus "no membership", and a refusal sentence for every capability.
- `business-time.test.ts` — business-timezone day conversion (UTC, Karachi, New York, Kiritimati, Niue), unknown-zone fallback, month ranges including leap years, and rendering a stored date without shifting it.
- `khata-service.test.ts` — money normalization, validation before any network call, the exact RPC argument objects, operation-id reuse on a lost response, no retry of a rejection, and archive-as-status rather than delete.
- `khata-screen.test.tsx`, `home-dashboard.test.tsx` and `sale-screen.test.tsx` — Android-rendered screens: real balances and running statement totals, honest empty/error/archived/offline states, role-gated actions, and a full sale entry run through the real service layer to a fake network boundary, asserting the posted line snapshot and a single `create_sale` call.

The sale-screen test deliberately does **not** mock the service layer: only `client.rpc` is faked, so preview arithmetic, validation, money normalization and idempotent posting are all exercised as they run on a device.

SecureStore, GoTrue and some domain services are mocked in these tests. They do not certify Android Keystore behavior, actual email delivery, native deep-link routing or physical-device rendering.

### SQL suites

`test:db` runs the actual three migrations in PGlite with pgcrypto and minimal Supabase-like roles. It checks foundation replay, ordered migrations, health schema version 3, search-path pinning and execute privileges. PGlite reports creation errors only: a `returns table` column mismatch or a bad `group by` inside a function body surfaces at execution, which is why `test:ledger` executes every read model.

`test:postgres` runs a temporary **native PostgreSQL 17** cluster using the pinned beta `embedded-postgres` test harness. It creates real independent database connections and a minimal `auth.users`/`auth.uid()` fixture. Coverage includes:

- Cross-business and anonymous reads; profile-directory isolation.
- Direct business/membership/role writes denied; owner-only settings and member administration.
- All five roles; delegated co-owner invitations; self-escalation denial.
- Random invitation token hashing, confirmed-email binding, expiry, revocation, single use and rejoining.
- Concurrent accept/revoke and two-account accept/accept races on independent connections: exactly one succeeds.
- Immediate withdrawal of delegated co-owner permissions; archived-business invitation denial; cross-business invitation/member administration denial.
- Every non-owner role denied archive, owner removal and self-promotion; audit forgery and profile ownership changes denied.
- Last-owner demotion/leave/deletion protection and atomic ownership transfer.
- Immediate revocation of removed-member business/profile access without affecting unrelated memberships.
- Atomic audit records, tenant-isolated audit reads, denied client audit writes and privileged-SQL immutability trigger checks.
- Anonymous RPC denial and fixed search paths on every SECURITY DEFINER function.

The harness uses a non-root OS user, an available localhost port and a temporary ignored workspace directory, which is removed in `finally`. Linux x64 is verified locally and used by CI. The harness is a development dependency, never shipped in the Android app. Its beta status and platform binary requirements are explicit limitations.

`test:ledger` runs the same native PostgreSQL 17 harness against the Phase 3 accounting layer, with 220 executing checks:

- Privileges and isolation: RLS on every financial table, no client write privileges, no anonymous SELECT or EXECUTE, no policy at all on `operation_receipts`, and cross-tenant denial on 9 tables and 6 RPCs, including a rival business's product id inside a sale.
- Exact decimals: `3 x 0.1 = 0.30`, a `2.345` tie rounding to `2.35`, `1.5 x 199.999 = 300.00`, `100 x 0.01 = 1.00`, JPY at scale 0 and KWD at scale 3, and rejection of 8 malformed decimal literals.
- Khata identities: an independent document-level formula reconciles with the ledger sum for a sale, an overpayment that produces a customer advance, and a refund that settles the account to `0.00`; opening balances are immutable after creation; a duplicate phone raises 23505.
- Idempotency: the same operation id replayed returns the stored result with `"replayed": true`; a second idempotency kind or a changed payload with the same id is rejected; a rolled-back attempt poisons nothing; and two **independent concurrent connections** posting the same id produce exactly one payment and one receipt.
- Voids: voiding a sale, payment or expense appends reversing ledger entries, keeps the original document, records the reason and actor, and blocks superuser UPDATE/DELETE on financial rows.
- Catalog snapshots: editing a product's price after a sale does not change the stored line.
- Reports: revenue, COGS, gross profit, net profit, `cogs_coverage_percent`, receivables and cash per method are re-derived in SQL inside the test and compared with the RPC output — including a case where cash (`-1120.35`) and profit (`323.30`) legitimately disagree.
- Currency lock after financial activity, archived-business write refusal, a `300.75` concurrency case, activity/audit feed content and `schema_version = 3`.

Neither SQL suite starts GoTrue, PostgREST, Storage or Realtime. Passing them is not evidence of a hosted Supabase deployment.

## Required hosted/device acceptance before release

Use a staging project, at least two confirmed users and two businesses. Never run destructive tests against real business data. Keep privileged setup keys outside the app and Git.

| Gate         | Required evidence                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth         | Register/confirm/login; wrong password; resend/rate limits; cold/warm recovery; process-death recovery gate; password reset/global revocation; session persistence/refresh; local/global logout |
| Native links | Exact redirect allowlist; PKCE on requesting device; token-hash/fragment template actually emitted by project; foreign schemes/hosts rejected; Expo Go versus APK callback behavior             |
| Tenancy      | Create/switch businesses; settings/currency/timezone; archive/restore; invitation preview/accept/revoke/expiry/reuse; confirmed-email mismatch                                                  |
| Permissions  | Every role against direct REST and RPC; self-elevation; owner transfer; last-owner protection; co-owner delegation and its withdrawal                                                           |
| Isolation    | Business A cannot read/write/subscribe to Business B; removed member loses future REST/Realtime/Storage access; unrelated memberships remain                                                    |
| Android      | Small screen/large font; TalkBack; background/foreground; offline errors; SecureStore restart/uninstall; signed EAS APK install/launch                                                          |
| Khata        | Credit, partial payment, reversal, outstanding balance and statement identities on a device, plus a lost-response retry that must not double-post (locally covered by `test:ledger`)            |
| Sales        | Multi-line totals, discounts, cash/credit, void/reversal, and the exact preview-to-stored total on a real device (tax and original-cost returns arrive with invoicing and Phase 4)              |
| Expenses     | Category/method/date validation, void audit, no duplicate payment expense                                                                                                                       |
| Suppliers    | Purchases, partial payments, returns, payable balance and statement                                                                                                                             |
| Inventory    | Opening/purchase/sale/return/adjustment identities, negative-stock protection, valuation                                                                                                        |
| Payroll      | Attendance, advances, earned salary versus payment, duplicate-payment prevention                                                                                                                |
| Chat         | Membership, replies/reactions/read state/search; image/audio-only private attachments; signed access and removal                                                                                |
| Traceability | Activity plus separate immutable audit for every important financial operation                                                                                                                  |
| Offline      | Durable queue, retry after lost response, duplicate prevention, version conflict, account isolation; no silent financial data loss                                                              |

Test actual JWTs and direct HTTP requests, not only the UI. Test concurrent payment retries and membership/invitation races against hosted PostgreSQL. Verify RLS on every future private table and Storage object. An APK is not delivered until a real signed build artifact exists.

## Reporting rules

Record commands, pass/fail counts, environment and unverified surfaces in the phase report. A failed check is not a pass because a screen renders. Do not mark later modules complete based on identity/foundation tests. See `PHASE_3.md` for the latest exact results.
