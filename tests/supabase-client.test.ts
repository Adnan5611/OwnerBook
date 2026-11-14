import { createClient, processLock } from '@supabase/supabase-js';
import { createOwnerBookClient, getSupabaseClient } from '../src/lib/supabase';
import { secureSessionStorage } from '../src/lib/secure-session-storage';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: {} })),
  processLock: jest.fn(),
}));

const configuration = {
  url: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test_only',
};

describe('Supabase client configuration', () => {
  it('uses secure persisted PKCE sessions and the React Native-safe lock', () => {
    createOwnerBookClient(configuration);
    expect(createClient).toHaveBeenCalledWith(configuration.url, configuration.publishableKey, {
      auth: {
        storage: secureSessionStorage,
        storageKey: 'ownerbook.auth.v1',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        lock: processLock,
      },
      global: { headers: { 'X-Client-Info': 'ownerbook-android/0.1.0' } },
    });
  });

  it('does not construct a fake client when public configuration is absent', () => {
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    try {
      expect(getSupabaseClient()).toBeNull();
    } finally {
      if (url !== undefined) process.env.EXPO_PUBLIC_SUPABASE_URL = url;
      if (key !== undefined) process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = key;
    }
  });
});
