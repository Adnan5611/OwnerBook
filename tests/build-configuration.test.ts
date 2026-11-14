import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext } from 'expo/config';
import configure from '../app.config.ts';

const context = { config: {} } as ConfigContext;
const original = { ...process.env };
afterEach(() => {
  for (const key of [
    'EXPO_PUBLIC_SUPABASE_URL',
    'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'EAS_BUILD',
    'EAS_PROJECT_ID',
  ]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('Android release configuration', () => {
  it('permits an unconfigured local setup screen but blocks an unconfigured EAS build', () => {
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.EAS_BUILD;
    expect(configure(context).android?.package).toBe('app.ownerbook.mobile');
    process.env.EAS_BUILD = 'true';
    expect(() => configure(context)).toThrow('EAS build blocked');
  });

  it('allows a configured EAS build without a service-role key', () => {
    process.env.EAS_BUILD = 'true';
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
    expect(configure(context).android?.allowBackup).toBe(false);
    expect(configure(context).scheme).toBe('ownerbook');
    expect(configure(context).extra?.releasePhase).toBe(3);
  });

  it('does not accept a fabricated EAS project ID', () => {
    process.env.EAS_PROJECT_ID = 'replace-me';
    expect(() => configure(context)).toThrow('UUID');
  });

  it('includes a linked project ID only when supplied', () => {
    process.env.EAS_PROJECT_ID = '12345678-1234-4234-8234-123456789abc';
    expect(configure(context).extra?.eas).toEqual({ projectId: process.env.EAS_PROJECT_ID });
  });

  it('generates APKs in every Android build profile', () => {
    const eas = JSON.parse(readFileSync(join(process.cwd(), 'eas.json'), 'utf8'));
    for (const profile of Object.values(eas.build) as { android: { buildType: string } }[]) {
      expect(profile.android.buildType).toBe('apk');
    }
    expect(eas.cli.appVersionSource).toBe('remote');
  });

  it('does not request microphone or camera before those features exist', () => {
    const android = configure(context).android!;
    expect(android.permissions).toEqual(['android.permission.INTERNET']);
    expect(android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.CAMERA',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ]),
    );
    expect(configure(context).plugins).toContainEqual([
      'expo-secure-store',
      { configureAndroidBackup: false },
    ]);
  });
});
