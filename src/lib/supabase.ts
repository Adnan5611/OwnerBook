import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient, processLock, type SupabaseClient } from '@supabase/supabase-js';
import { getMobileEnvironment, type SupabaseConfiguration } from '../config/environment';
import type { Database } from '../types/database';
import { secureSessionStorage } from './secure-session-storage';

export type OwnerBookClient = SupabaseClient<Database>;
let client: OwnerBookClient | null = null;

export function createOwnerBookClient(configuration: SupabaseConfiguration): OwnerBookClient {
  return createClient<Database>(configuration.url, configuration.publishableKey, {
    auth: {
      storage: secureSessionStorage,
      storageKey: 'ownerbook.auth.v1',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      // React Native has no browser Navigator Locks API.
      lock: processLock,
    },
    global: {
      headers: { 'X-Client-Info': 'ownerbook-android/0.1.0' },
    },
  });
}

/** No placeholder URL/key and no client creation before the project is configured. */
export function getSupabaseClient(): OwnerBookClient | null {
  const environment = getMobileEnvironment();
  if (!environment.ok) return null;
  client ??= createOwnerBookClient(environment.configuration);
  return client;
}

/** Pause background token refresh while Android is not active. */
export function observeAuthLifecycle(
  auth: Pick<OwnerBookClient['auth'], 'startAutoRefresh' | 'stopAutoRefresh'>,
): () => void {
  const update = (state: string | null | undefined) => {
    if (state === 'active') void auth.startAutoRefresh();
    else void auth.stopAutoRefresh();
  };
  update(AppState.currentState);
  const subscription = AppState.addEventListener('change', update);
  return () => subscription.remove();
}
