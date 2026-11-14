# OwnerBook database — schema version 3

Migrations are ordered by filename and are the source of truth. Apply all three:

1. `20261101000100_foundation.sql`: private helper schema and health RPC.
2. `20261102000100_identity_businesses.sql`: profiles, businesses, memberships, invitations, currencies, audit logs, RLS and authenticated RPCs.
3. `20261103000100_khata_sales_expenses.sql`: customers, products, sales, sale items, payments, expenses, the append-only customer ledger, activity logs, idempotency receipts, the read models and the financial write RPCs.

There are no financial seed records, demo balances, permissive anon policies or client-supplied actor IDs. Each migration intentionally supersedes the previous health schema version, so `select * from public.ownerbook_health();` must report `schema_version = 3` after all three are applied.

## Applied and verified on a hosted project

The free-tier project `uplbjnbislmzmiykiylt` (eu-west-1) carries all three migrations. They were applied server-side: the project fetched each file from `raw.githubusercontent.com` at an immutable commit SHA with `extensions.http_get`, its SHA-256 was compared with the repository's `sha256sum`, and only then was it executed (with the file's own `begin;`/`commit;` stripped, because transaction control is illegal inside a PL/pgSQL block). The same three versions are recorded in `supabase_migrations.schema_migrations`, so `supabase migration list` shows them as applied and `supabase db push` will not re-apply them.

The deployed schema was then compared with the local one and accepted behaviourally:

```sh
npm run fingerprint                              # local schema digest
npm run fingerprint -- scripts/sql/grant-audit.sql   # local privilege audit
npm run test:acceptance                          # local run of the hosted acceptance SQL
```

Run the same three files against the project (see `docs/PHASE_3.md` for the exact transport) and compare. Result on the provisioned project: 7 of 10 fingerprint categories byte-identical, 124 of 124 function/trigger/index lines matching one-for-one, the three grant categories differing only by Supabase's own `service_role` default privileges, 0 client write grants, and **28 of 28 acceptance checks passed with every table and `auth.users` back at 0 rows**.

## Apply to your project

Use a new/staging project first. Install and authenticate the Supabase CLI, then link the project you control:

```sh
npx supabase login
npx supabase init
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push --dry-run
npx supabase db push
```

If starting entirely from the SQL editor, execute both files **in order, once each**. Prefer the CLI so migration history is recorded. Do not blindly replay the feature migration or mark a manually applied migration as applied without reconciling history. Do not edit an already-applied migration on a real project; add a new migration.

After deployment, verify `select public.ownerbook_health();` returns `schema_version: 2`. Settings → Database connection check now rejects the old version-1 schema instead of claiming the app is ready.

## Native authentication configuration

Enable the Email provider in Supabase Auth. For a secure release, require email confirmation, use strong passwords, configure custom SMTP when ready, and keep Auth rate limits enabled. The app requests a minimum 10-character password and enforces the 72-byte bcrypt limit; configure matching server-side password requirements.

Set **Site URL** to your production app link, `ownerbook://auth/confirmation`, and add these exact patterns under **Additional Redirect URLs**:

```text
ownerbook://auth/confirmation
ownerbook://auth/recovery
```

The app also accepts actual `ownerbook://invite?token=<64 lowercase hex characters>` links. Invitation links are handled entirely by the app, not by a Supabase Auth redirect endpoint, so they do not need an Auth redirect allowlist entry. Verify generated invite links on a device.

For Expo Go development, `Linking.createURL()` produces an installation-specific `exp://.../--/auth/...` URL. Run the app, request a recovery email, and inspect the redirect using your own test account if necessary; add that exact development URL to the allowlist. Development callbacks are accepted only in development builds. Use a development/preview APK with the stable `ownerbook://` scheme for reliable release-like testing. Do not wildcard arbitrary HTTPS origins.

The client uses PKCE and manually handles cold/warm links. It supports:

- `?code=...` on the recovery/confirmation callback (exchange on the device that requested the link);
- `?token_hash=...&type=recovery` or `?token_hash=...&type=signup` (one-time email token verification);
- the recovery-only `#access_token=...&refresh_token=...&type=recovery` callback emitted by some Supabase email templates.

If using token-hash templates, the links should point at the supplied redirect, for example:

```html
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=recovery">Reset password</a>
<a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=signup">Confirm email</a>
```

Use the correct template for each email type; do not put recovery tokens in signup emails. Keep the default secure templates unless you have a tested reason to customize them. Verify your actual project's template/link format on a physical device.

Recovery opens a gated password-update screen, not the business workspace. A SecureStore marker preserves this gate across process restarts. Successful password update performs global sign-out. If revocation fails, the recovery screen remains gated and the user must retry/sign out. Never log callback URLs or email tokens.

## Authorization model

| Action                                 | Owner             | Co-owner             | Manager | Accountant | Staff |
| -------------------------------------- | ----------------- | -------------------- | ------- | ---------- | ----- |
| Read active business/member directory  | Yes               | Yes                  | Yes     | Yes        | Yes   |
| Change business settings/archive       | Yes               | No                   | No      | No         | No    |
| Create invitations                     | Yes               | Only if delegated    | No      | No         | No    |
| List/revoke invitations                | All               | Own, while delegated | No      | No         | No    |
| Change roles/remove members            | Yes               | No                   | No      | No         | No    |
| Read audit history                     | Yes               | Yes                  | No      | No         | No    |
| Edit own profile/business display name | Yes               | Yes                  | Yes     | Yes        | Yes   |
| Leave business                         | Unless last owner | Yes                  | Yes     | Yes        | Yes   |

Future financial capabilities will be added in their own migrations/tests; this matrix is not a claim that those modules exist. Owners may promote an existing member to Owner. The last active owner cannot be removed or demoted, enforced by a deferred constraint trigger so atomic ownership transfer works.

All five private business tables have RLS. Clients have no direct business/membership/invitation/audit writes. Profile updates are limited to `display_name`, own row, and must return the changed row. RPCs derive the actor from `auth.uid()`, validate current membership/role, pin an empty search path, and have no anon execute grants. Business-first row locks serialize membership and invitation state changes.

## Invitations and privacy

- Server-generated 256-bit random token; only SHA-256 hash stored.
- Raw token returned once, never included in audit logs or saved to app preferences.
- 1–720 hour expiry; single use; revocation; maximum 50 pending invitations per business.
- Cannot invite an Owner.
- Optional email binding requires the current account's **confirmed** email to match both preview and acceptance.
- Unbound invitations are bearer credentials: any authenticated recipient can join. The UI warns about this; email binding is recommended.
- Invitation emails are **not sent automatically**. The app opens your email app with the link; you choose whether to send it. No paid email provider is provisioned.
- Archived businesses retain membership/history reads but reject new invitation creation/acceptance.
- Removing a member revokes future tenant/profile/audit reads. Previously downloaded data cannot be erased remotely.

`audit_logs` records important identity/tenant changes atomically. Client update/delete privileges are denied and a trigger rejects mutation even through privileged SQL. Database administrators can still disable triggers or alter the database; this is not a claim of protection against a malicious project administrator. The user-facing activity/audit browser is Phase 7.

Currency is editable only because no financial operations exist yet. **Phase 3 must add the database guard locking currency after financial activity before enabling transactions.** Timezones are validated against PostgreSQL's IANA zone catalog; stored timestamps are UTC.

## Local verification

```sh
npm run test:db         # PGlite: migration/health/grant checks
npm run test:postgres   # real native PostgreSQL 17: RLS/RPC/concurrency tests
npm run test:ledger     # real native PostgreSQL 17: 220 Phase 3 accounting checks
npm run test:acceptance # the hosted acceptance SQL, proven locally first
```

The native test dependency is pinned to `embedded-postgres@17.11.0-beta.19` (a beta test harness, not a production service or mobile dependency). It downloads platform-specific open-source PostgreSQL binaries through npm, starts a temporary localhost cluster as a non-root user, and removes its workspace data directory afterward. Linux x64 is verified here and used by CI. Other platforms may need a locally installed PostgreSQL/Supabase test setup. The app itself never embeds PostgreSQL.

Tests create a minimal `auth.users`/`auth.uid()` fixture and real Supabase-like roles, in a UTF8 cluster because a SQL_ASCII cluster would make `char_length()` count bytes instead of characters. They are **not** a running Supabase Auth/PostgREST deployment. Before release, test actual JWTs, direct REST requests, email delivery/callbacks, Auth rate limits, current-membership revocation and concurrent RPCs against a staging Supabase project. Never put a service-role key in the mobile environment.
