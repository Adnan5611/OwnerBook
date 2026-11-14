import type { ExpoConfig, ConfigContext } from 'expo/config';
import { readSupabaseEnvironment } from './src/config/environment.ts';

export default ({ config }: ConfigContext): ExpoConfig => {
  const environment = readSupabaseEnvironment({
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  // An unconfigured local development bundle may show setup instructions. An EAS
  // artifact must never accidentally ship without a valid backend configuration.
  if (process.env.EAS_BUILD === 'true' && !environment.ok) {
    throw new Error(
      'EAS build blocked: configure EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY with a valid HTTPS project URL and publishable/anon key.',
    );
  }
  const projectId = process.env.EAS_PROJECT_ID?.trim();
  if (
    projectId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
  ) {
    throw new Error('EAS_PROJECT_ID must be the UUID supplied by Expo, not a placeholder.');
  }

  return {
    ...config,
    name: 'OwnerBook',
    slug: 'ownerbook',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    scheme: 'ownerbook',
    platforms: ['android'],
    android: {
      package: 'app.ownerbook.mobile',
      versionCode: 1,
      allowBackup: false,
      permissions: ['android.permission.INTERNET'],
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.CAMERA',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
    },
    // Backups are disabled above. Do not emit references to backup XML resources
    // that the SecureStore plugin does not itself generate.
    plugins: [['expo-secure-store', { configureAndroidBackup: false }]],
    extra: {
      releasePhase: 3,
      ...(projectId ? { eas: { projectId } } : {}),
    },
  };
};
