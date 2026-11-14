# Phase 1 report — foundation

Date: 2026-11-01  
Branch: `arena/b7b90880-ownerbook`  
Starting checkout: `d980fa7` (initial README only)  
Status: **local foundation implementation and checks passed; hosted/device/EAS verification pending**.

## Inspection before changes

The repository contained only `README.md`; there was no existing app, migration,
lockfile or test suite to preserve. The workspace had Node 22.22.3 and npm 10.9.8,
but no Java, Android SDK, ADB, local PostgreSQL server, Docker or Supabase CLI.
No Supabase project configuration or linked Expo project was supplied. No cloud
build, paid subscription or external account was created.

## Implemented

1. **Native Android project:** Expo SDK 58.0.22, React Native 0.88.1, React 19.3 and
   strict TypeScript. Android-only Metro platforms, application ID
   `app.ownerbook.mobile`, generated-native-project workflow and locked dependencies.
2. **Safe configuration:** public Supabase URL/key validation; legacy anon JWT role
   checking; rejection of secret/service-role keys; no fabricated fallback project;
   EAS builds blocked when backend configuration is missing or invalid.
3. **Supabase foundation:** PKCE client, persisted sessions, React Native process
   lock, foreground/background refresh lifecycle, and a real PostgreSQL health RPC
   with timeout, cancellation and sanitized error states. No live success is claimed
   without a valid database response.
4. **Session storage:** bounded, percent-encoded chunks stored in Expo SecureStore,
   backed by Android Keystore. Writes commit a new manifest last; interrupted writes
   preserve the previous complete session. Sign-out invalidates the pointer first.
   Android cloud backup is disabled. Actual device Keystore behavior remains a
   required device test, not something a mocked unit test can certify.
5. **Honest setup UI:** native connection screen with missing/invalid configuration,
   network uncertainty, offline, loading, failure and verified-success states; safe
   areas, small-screen/large-font handling, accessible controls and a generic error
   boundary. No simulated dashboard or hardcoded financial results.
6. **Database foundation:** one transactional SQL migration creating a private
   helper schema and non-sensitive `ownerbook_health()` endpoint. It exposes no
   business data. Business tables and their RLS policies are deliberately deferred
   to the phases that implement and test them.
7. **Build/test infrastructure:** EAS development/preview/production profiles all
   output Android APKs; CI runs checks, exports the Android bundle and generates
   native Android configuration. Environment/build guards, SQL checks and native
   manifest checks are included.
8. **Design contracts:** normalized schema plan, role matrix, moving weighted-average
   accounting, separate cash/profit/receivables, transactional audit/activity,
   idempotent operations, SQLite outbox and explicit conflict handling are documented
   for subsequent implementation. These are designs, not completed modules.

## Verification performed

| Check                                                       | Result                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run typecheck`                                         | Passed                                                              |
| `npm run lint`                                              | Passed; zero warnings                                               |
| `npm run format:check`                                      | Passed                                                              |
| `npm test -- --coverage`                                    | **69 tests / 8 suites passed**                                      |
| `npm run test:db`                                           | **13 SQL checks passed** in embedded PostgreSQL                     |
| `npm run check`                                             | Passed                                                              |
| Clean `npm ci` followed by `npm run check`                  | Passed; lockfile installation reproduced                            |
| `npx expo export --platform android --output-dir dist`      | Passed; Android Hermes bundle, 692 modules                          |
| `npx expo prebuild --platform android --clean --no-install` | Passed                                                              |
| `npm run check:android`                                     | Passed; package ID, backup settings, permissions and XML references |
| Installed SDK package-range comparison                      | Passed against Expo's bundled native-module metadata                |
| `npm audit --omit=dev --audit-level=high`                   | Passed; **0 production dependency vulnerabilities reported**        |
| Synthetic public environment validation                     | Passed; no network request or real credentials used                 |
| Configured EAS Expo-config evaluation                       | Passed with synthetic public values                                 |
| Unconfigured EAS Expo-config evaluation                     | Correctly blocked                                                   |

The coverage run reported 94.85% line coverage for the selected environment,
connection and session-adapter modules. This is **not** whole-application coverage:
the Supabase factory and native UI are excluded from that coverage collection, and
hosted/device integration is not represented by this percentage.

### Failures found and resolved during implementation

- Initial strict-type checks exposed React Native font-weight/AppState typing and
  PostgREST error-shape differences; corrected.
- Initial Jest execution exposed Expo/URL-polyfill ESM transform configuration and
  React Native Testing Library 14's async rendering API; corrected.
- Session tests exposed an over-restrictive encoded-character check; corrected and
  covered by a large Unicode/punctuation round-trip test.
- Native generation exposed SecureStore backup XML references without generated
  resources. Since app backup is disabled, automatic backup-rule injection is now
  disabled too; regenerated manifest checks pass.
- The initial dependency audit reported moderate `glob`/`minimatch` advisories in
  Expo build tooling. Targeted overrides updated those paths; bundle/config/native
  generation checks were rerun. No unsafe forced Expo downgrade was applied.

### Remaining verification and warnings

- **No live Supabase request has succeeded yet:** no project URL/key was supplied.
  The local SQL test does not start hosted Auth, PostgREST, Realtime or Storage.
- **No APK exists yet:** EAS is configured, but no Expo account/project is linked,
  no signing credentials have been accepted, and no cloud build was authorized or started. Java/Android SDK are absent locally. Bundle export and prebuild are not APK
  compilation, signing, installation or device testing.
- `npx expo install --check` could not reach Expo's remote API from this sandbox.
  An offline comparison against the installed SDK's bundled version ranges passed;
  the offline CLI check also passed with an explicit reliability warning. Neither is represented as a successful remote Expo Doctor run.
- The full development-inclusive audit still reports lower-severity tooling
  advisories (including old Jest/ESLint transitive glob paths and `deepmerge`).
  The production only audit reports zero. Compatible upstream fixes should be
  revisited; no claim of zero development-dependency advisories is made.
- Android development tooling can contribute overlay/vibration permissions. Camera,
  microphone and broad external-storage permissions are explicitly removed in
  Phase 1. Revisit the final release manifest when chat media is implemented.
- SQLite is a dependency only; no offline cache, queued financial writes or sync
  conflict resolution is implemented yet. SecureStore device tests and account-
  isolation tests remain future release gates.
- The app uses the default Expo launcher icon at this foundation stage. Final
  branding, authentication/navigation and all operational modules remain pending.

## Files changed

Modified:

- `README.md`

Added application/configuration files:

- `.env.example`, `.gitignore`, `.nvmrc`, `.prettierignore`, `.prettierrc.json`
- `App.tsx`, `app.config.ts`, `index.ts`, `package.json`, `package-lock.json`
- `babel.config.js`, `metro.config.js`, `eslint.config.js`, `jest.config.js`, `tsconfig.json`
- `eas.json`, `.github/workflows/ci.yml`
- `src/components/AppErrorBoundary.tsx`, `src/components/FoundationScreen.tsx`
- `src/config/environment.ts`, `src/hooks/use-connection.ts`
- `src/lib/connection.ts`, `src/lib/secure-session-storage.ts`, `src/lib/supabase.ts`
- `src/types/database.ts`, `src/types/env.d.ts`

Added database/tooling files:

- `supabase/migrations/20261101000100_foundation.sql`, `supabase/README.md`
- `scripts/check-android.ts`, `scripts/check-env.ts`, `scripts/test-database.ts`

Added tests:

- `tests/auth-lifecycle.test.ts`, `tests/build-configuration.test.ts`
- `tests/connection.test.ts`, `tests/environment.test.ts`
- `tests/foundation-screen.test.tsx`, `tests/secure-session-storage.test.ts`
- `tests/supabase-client.test.ts`, `tests/use-connection.test.tsx`

Added documentation:

- `docs/ARCHITECTURE.md`, `docs/ANDROID_BUILD.md`, `docs/TESTING.md`, `docs/PHASE_1.md`

Generated `android/`, `dist/`, `coverage/` and `node_modules/` are intentionally
ignored. No environment file, signing key or APK is committed.

## Manual action needed before hosted/device verification

1. Create/select a Supabase project you control and apply the foundation migration.
2. Put its project URL and **publishable** key in your local `.env` (or provide those
   intentionally public values to the development team). Never provide a secret/
   service-role key, database password or recovery codes.
3. Run the app on an Android device/development build and verify the real connection
   and session-storage behavior.
4. For an APK, sign in to your Expo account, link the project with EAS, configure the
   public variables for the chosen EAS environment, and explicitly review signing
   and free-quota/build prompts. Follow `docs/ANDROID_BUILD.md`.

Phase 2 can now implement registration/login/recovery, profiles, businesses,
invitations and database-enforced membership/role policies. It must include live
cross-business security tests before any operational data is exposed.
