# Android APK build and delivery

## Current state

The app is configured for Android APK output. Local TypeScript/unit/SQL checks,
Android JavaScript bundling and native project generation are verified separately
in the phase report. **No APK has been built or signed yet.** This sandbox has no
Java/Android SDK, and there is no linked Expo project or authenticated Expo session.
No paid plan or cloud build has been started automatically.

## 1. Configure the backend

1. Create or select a Supabase project you control. A free project is sufficient to
   start; free-plan quotas, pausing and backup limitations still apply.
2. Apply `supabase/migrations/20261101000100_foundation.sql` as described in
   `supabase/README.md`.
3. Copy `.env.example` to `.env` and set the project URL and **publishable** key.
   A legacy anon JWT is accepted. Secret/service-role keys are rejected.
4. Run `npm ci`, `npm run check:env` and `npm start`. Test the connection action on
   an Android development build/device before distributing an APK.

`EXPO_PUBLIC_*` values are embedded in the APK and are not secrets. RLS, Auth and
server-side validation are the security boundary. Never put privileged credentials
in these variables, app extras, source code or screenshots.

## 2. Link Expo without inventing credentials

Create/sign in to an Expo account you control, then run:

```sh
npx --yes eas-cli@27.2.0 login
npx --yes eas-cli@27.2.0 init
```

`init` links this app to a real Expo project. Put the supplied project UUID in
`EAS_PROJECT_ID` in your local `.env`; `app.config.ts` exposes it as
`extra.eas.projectId`. Do not use a placeholder UUID. If the CLI offers to write the
ID into the dynamic config, you can use the environment-variable route instead.
The package name is currently `app.ownerbook.mobile`; confirm it before the first
release because future updates must use the same application ID and signing key.

Set the same public variables and project ID in each EAS environment you intend to
use (`development`, `preview`, `production`). Use Expo's environment-variable UI or
`eas env:create`; select **plaintext** visibility only for these intentionally public
values. EAS ignores your local `.env` when it is excluded from source control.

```sh
npx --yes eas-cli@27.2.0 env:create --environment preview
npx --yes eas-cli@27.2.0 env:create --environment production
```

Do not upload a service-role key to any mobile build environment. The configured
post-install check and dynamic Expo config both block an unconfigured EAS build.

## 3. Build an installable APK

For internal testing:

```sh
npm run build:android:preview
```

For a release-signed APK:

```sh
npm run build:android:production
```

Both profiles explicitly use `android.buildType: apk`. Production uses EAS remote
version increments. On the first build, explicitly review and accept EAS-managed
Android signing credentials. Back up the signing key securely: losing it prevents
normal updates to installed copies. No keystore or credential JSON belongs in Git.

EAS may require waiting in its free build quota. Review the CLI's plan/credit prompts;
this project does not authorize paid upgrades. Do not use `--auto` or unattended
purchase decisions. Download the resulting `.apk` from the real EAS build page.
APKs and signing artifacts are ignored by Git; attach the tested APK to the eventual
release/delivery rather than committing a large binary.

## 4. Device acceptance before calling it delivered

- Install on a physical Android phone; verify launch, small-screen layout and large
  font settings, background/foreground session behavior and process restart.
- Verify configured, unconfigured, wrong-key, missing-migration, offline and paused-
  project states. The connection screen must not claim success without an RPC result.
- Complete the authentication, RLS, financial and offline tests as those phases land.
- Verify that a release APK has no development server dependency and no secret key.
- Record APK version/application ID, signing profile, build ID, SHA-256 checksum,
  device/Android version, test results and known limitations with the delivery.

## Local native alternative

With a separately installed Java/Android SDK and a configured device/emulator:

```sh
npx expo run:android --variant release
```

This is a local native build, not evidence of an EAS release. The usual generated
debug/release signing setup must be reviewed before distribution. EAS is the primary
documented build path because this workspace does not include Android native tools.

## Checks that do not require an Expo account

```sh
npm ci
npm run check
npx expo export --platform android --output-dir dist
npx expo prebuild --platform android --clean --no-install
```

The last command generates `android/` from config. It does not compile Java, sign an
APK or test a device. `dist/` and `android/` are disposable generated outputs.
