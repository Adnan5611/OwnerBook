# Phase 2 report — identity, businesses and permissions

Date: **3 November 2026**  
Branch: `arena/b7b90880-ownerbook`  
Status: **implemented and locally verified; hosted Supabase and physical-device acceptance pending.**

This checkpoint adds real authentication and tenant administration to the Phase 1 Android foundation. It does not claim that financial accounting, inventory, payroll, chat, offline sync or a signed APK is complete.

## Implemented

### Authentication and profiles

- Native email/password sign-in and registration with confirmation redirect.
- Password recovery request, allowlisted cold/warm native callbacks, PKCE code exchange, token-hash verification and recovery-fragment support.
- Recovery-only password update gate, persisted across process restarts with a non-credential SecureStore marker; successful update revokes all sessions.
- Global and explicitly labeled local sign-out; safe error messages without raw callback URLs/tokens.
- Persistent profile editing and per-business display names.
- Account-keyed workspace provider clears prior-account state and rejects stale async responses. An explicit business selection also invalidates older refresh requests.
- Recovery marker writes are serialized; an authoritative sign-out event cannot be overwritten by an older stored-session result. Recovery has an explicit sign-out escape if password update/revocation fails.

### Businesses and team

- Create multiple businesses; choose supported currency and validated IANA timezone; switch business with a per-user SecureStore selection.
- Owner-only settings and reversible archive/restore. Archived businesses retain history reads but block new invitations.
- Owner / Co-owner / Manager / Accountant / Staff roles stored in PostgreSQL.
- Owner-only role changes, removal and ownership transfer. Last active owner cannot leave or be demoted/removed, enforced at transaction commit.
- Co-owner invitation creation/revocation only when delegated by Owner; co-owners cannot change roles or remove members.
- Team list, confirmed role changes/removal, leave-business action and member name editing.
- Required Home/Khata/Transactions/Chat/Settings tabs. Unimplemented modules are explicitly labeled, not populated with demo data.

### Secure invitations

- PostgreSQL generates 256-bit random tokens; only SHA-256 hashes are stored.
- Raw token returned once; never logged, audited or persisted in preferences. Sharing metadata is frozen when the token is issued, so later form edits cannot mislabel its role or invited email.
- Invite links are cleared on account changes; team/invitation screens remount on business changes to avoid displaying the previous tenant’s state.
- Optional confirmed-email binding, 1–720 hour expiry, revocation, single use and a pending-invitation cap.
- Preview business/role before accepting; no public tenant directory.
- Business/invitation row locks serialize acceptance and revocation; an independent-connection race test verifies exactly one outcome.
- Share through the user's email app. **Automatic email delivery is not implemented** and no paid provider was provisioned.

### Database protections

- RLS on profiles, businesses, business_members, invitations and audit_logs; authenticated-only currency catalog reads.
- No client write grants for businesses/memberships/invitations/audit; profile updates restricted to own display name and checked for an actual changed row.
- Narrow authenticated RPCs derive actor from `auth.uid()`, validate current role and pin an empty search path.
- Membership-scoped business/profile/audit reads. Removed users retain only their own membership history row, not the tenant directory.
- Atomic audit records for business settings/archive, invitation and membership changes; client mutation denied and database mutation trigger tested.
- Schema health version **2**; the app rejects the outdated version-1 schema.

## Final local verification

Executed after a clean **`npm ci`** on Node **22.22.3**, npm **10.9.8**, Linux x64:

| Check                                                         | Result                                           |
| ------------------------------------------------------------- | ------------------------------------------------ |
| Strict TypeScript                                             | Passed                                           |
| ESLint, zero warnings                                         | Passed                                           |
| Prettier check                                                | Passed                                           |
| Jest Android-preset unit/provider/UI tests                    | **17 suites, 133 tests passed**                  |
| PGlite SQL migration/health/grant suite                       | **13 checks passed**                             |
| Native PostgreSQL 17 security/RPC/concurrency suite           | **96 checks passed**                             |
| Android Hermes JavaScript export                              | **962 modules; approximately 2.8 MB bundle**     |
| Expo Android prebuild                                         | Passed                                           |
| Native manifest/Gradle/resource-reference/scheme checks       | Passed; not Gradle compilation                   |
| Production dependency audit (`--omit=dev --audit-level=high`) | **0 vulnerabilities**                            |
| Offline Expo dependency version check                         | Passed with explicit offline reliability warning |
| Git whitespace check                                          | Passed                                           |

The native SQL suite starts a real temporary PostgreSQL 17 cluster, uses independent authenticated-role connections, and removes its test directory. It covers cross-tenant denial, direct write denial, all roles, email binding, expiry/reuse/revocation, concurrent accept/revoke and two-account accept/accept races, delegation withdrawal, archived-invitation denial, ownership invariants, removal/rejoining, profile isolation, audit immutability and RPC grants/search paths.

The test harness is the explicitly pinned **beta** `embedded-postgres@17.11.0-beta.19`, a development-only dependency. Its approximately 60 MB Linux binary stays in ignored `node_modules`, not Git or the APK. Linux x64 is tested; other operating systems may require a different local PostgreSQL test setup.

Development dependencies still emit deprecation warnings during installation. The clean production audit is not a claim that every development/transitive package is vulnerability-free.

## Main changed/added files

- `supabase/migrations/20261102000100_identity_businesses.sql` — schema, RLS, RPCs, invitations and invariants.
- `src/types/database.ts` — typed table/RPC contract for schema version 2.
- `src/lib/auth-service.ts`, `auth-links.ts`, `recovery-marker.ts` — authentication and recovery.
- `src/lib/business-service.ts`, `business-selection.ts`, `validation.ts`, `errors.ts` — domain operations and validation.
- `src/providers/auth-provider.tsx`, `workspace-provider.tsx` — lifecycle, recovery and tenant isolation.
- `src/screens/auth-screen.tsx`, `business-screens.tsx`, `member-screen.tsx`, `settings-screen.tsx` — operational native workflows.
- `src/navigation/app-navigation.tsx`, `src/components/ui.tsx`, `src/hooks/use-invite-link.ts` — navigation, shared UI and invite handling.
- `App.tsx`, `app.config.ts`, `src/lib/connection.ts`, `src/components/FoundationScreen.tsx` — phase/schema integration.
- `scripts/test-postgres.ts`, `scripts/test-database.ts`, `scripts/check-android.ts` — SQL and native configuration gates.
- `tests/auth-*.test.*`, `tests/recovery-marker.test.ts`, `identity-*.test.ts`, `business-form.test.tsx`, `member-screen.test.tsx`, `workspace-provider.test.tsx`, `navigation.test.tsx` and updated foundation tests.
- `package.json`, `package-lock.json`, CI/ignore configuration — navigation/linking and PostgreSQL test dependencies.
- `README.md`, `supabase/README.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, this report — setup, security model and acceptance instructions.

## Review fixes and regression coverage

The final review fixed initialization/sign-out ordering, out-of-order recovery-marker persistence, stale refresh versus explicit business selection, newly created business selection, recovery exit controls, pending invitation navigation before route registration, and tenant/invite screen state isolation. The native SQL suite now also tests simultaneous acceptance by two accounts, withdrawal of co-owner invitation delegation, cross-business invitation administration, archived-business acceptance denial, audit forgery denial and every non-owner role’s denial of ownership/archive/removal operations.

Initial regression runs exposed a recovery-marker test timing error and shared navigation-test state; both test harness issues were corrected and the final suite passes. The clean production audit does not remove the development-tool deprecation warnings noted above.

## Important limitations / deliberate boundaries

1. **No hosted project configured:** `.env` is absent. No real Supabase registration/email/JWT/PostgREST/Realtime/Storage test was possible. Minimal Auth SQL fixtures are not GoTrue.
2. **No APK:** no linked Expo project, signing acceptance, Android SDK/Java compilation or device installation. Export/prebuild are not an APK.
3. Business administration is online-only. SQLite cache/outbox and financial idempotency are Phase 7/financial-module work; no financial writes are silently queued.
4. Membership changes on another device require Refresh/sign-in or a new request; live membership subscriptions are not implemented. PostgreSQL still denies revoked access immediately on the next request.
5. Currency can be changed only because financial operations do not exist yet. Phase 3 must add the database currency lock before enabling transactions.
6. Audit data is persisted, but the activity feed/audit browser is later work. Database administrators remain trusted; immutability is not protection against a malicious project owner disabling triggers.
7. Unbound invitation links are bearer credentials. Email-bound invitations are recommended. Already downloaded data cannot be remotely erased after removal.
8. Database types are hand-maintained and tested against the migration contract; generate types from the deployed staging schema before release.
9. Default Expo icon remains. Camera/microphone/broad storage permissions remain blocked until their features are implemented.
10. No remote GitHub CI run, paid provisioning, new commit or push was performed. Changes are preserved on the session branch workspace.

## Manual actions required

Follow **`supabase/README.md`** to apply both migrations, enable/configure Email Auth, allowlist the exact native callbacks, and verify the actual email template format. Use staging accounts and data first.

Then perform the hosted/device checklist in **`docs/TESTING.md`**:

- Two confirmed accounts and two businesses; direct REST/RPC isolation checks.
- Cold/warm confirmation and recovery links, process restart, global sign-out and session refresh.
- Invitation wrong-email/expiry/reuse/revoke and simultaneous accept/revoke.
- Every role, ownership transfer, last-owner protection and removed-member access denial.
- Small-screen/large-font/TalkBack behavior and SecureStore persistence on a physical Android device.
- APK signing/build/install through the explicitly authorized EAS workflow in `docs/ANDROID_BUILD.md`.

Do not treat this local checkpoint as production release approval. The next implementation phase is **Phase 3: customers, khata, payments, sales and expenses**, beginning with exact-decimal transaction RPCs, idempotency, currency locking and tenant-isolation tests.
