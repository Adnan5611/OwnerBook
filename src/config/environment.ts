export const SUPABASE_URL_VARIABLE = 'EXPO_PUBLIC_SUPABASE_URL';
export const SUPABASE_KEY_VARIABLE = 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY';

export type SupabaseConfiguration = {
  url: string;
  publishableKey: string;
};

export type EnvironmentResult =
  | { ok: true; configuration: SupabaseConfiguration; missing: [] }
  | { ok: false; configuration: null; missing: string[]; reason: 'missing' | 'invalid' };

type EnvironmentInput = { url?: string; publishableKey?: string; allowLocalHttp?: boolean };

// Decode only the role claim for a configuration safety check. This is NOT JWT
// verification; Supabase verifies signatures. Kept dependency-free so app.config.ts
// can also run on EAS before application dependencies are installed.
function decodeBase64Url(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error('Invalid base64url');
  const bytes: number[] = [];
  for (let offset = 0; offset < input.length; offset += 4) {
    const group = input.slice(offset, offset + 4);
    if (group.length === 1) throw new Error('Invalid base64url length');
    let buffer = 0;
    for (let index = 0; index < 4; index += 1) {
      buffer = (buffer << 6) | (index < group.length ? alphabet.indexOf(group[index]!) : 0);
    }
    bytes.push((buffer >> 16) & 255);
    if (group.length > 2) bytes.push((buffer >> 8) & 255);
    if (group.length > 3) bytes.push(buffer & 255);
  }
  return Uint8Array.from(bytes);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const bytes = decodeBase64Url(parts[1]!);
    // JWT JSON is UTF-8. This decoder does not depend on Node Buffer or window.atob.
    const json = decodeURIComponent(
      Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
    );
    const payload: unknown = JSON.parse(json);
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A configuration guard, not an authentication mechanism. Supabase validates keys
 * and RLS protects data. This guard prevents accidentally shipping privileged keys.
 * Legacy anon JWTs are accepted; every other JWT role is rejected.
 */
export function isPublicSupabaseKey(key: string): boolean {
  if (!key || /\s/.test(key) || key.startsWith('sb_secret_')) return false;
  if (key.startsWith('sb_publishable_')) return key.length > 'sb_publishable_'.length;
  const payload = decodeJwtPayload(key);
  return payload?.role === 'anon';
}

export function readSupabaseEnvironment(input: EnvironmentInput): EnvironmentResult {
  const url = input.url?.trim();
  const publishableKey = input.publishableKey?.trim();
  const missing = [
    ...(!url ? [SUPABASE_URL_VARIABLE] : []),
    ...(!publishableKey ? [SUPABASE_KEY_VARIABLE] : []),
  ];
  if (missing.length) return { ok: false, configuration: null, missing, reason: 'missing' };

  const invalid: EnvironmentResult = {
    ok: false,
    configuration: null,
    missing: [],
    reason: 'invalid',
  };
  try {
    const parsed = new URL(url!);
    const localHttp =
      input.allowLocalHttp === true &&
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '10.0.2.2'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !localHttp) return invalid;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return invalid;
    if (!isPublicSupabaseKey(publishableKey!)) return invalid;
    return {
      ok: true,
      configuration: {
        url: parsed.toString().replace(/\/+$/, ''),
        publishableKey: publishableKey!,
      },
      missing: [],
    };
  } catch {
    return invalid;
  }
}

/** Static EXPO_PUBLIC_* references are required for Expo/Metro compile-time inlining. */
export function getMobileEnvironment(): EnvironmentResult {
  return readSupabaseEnvironment({
    url: process.env.EXPO_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    // React Native replaces __DEV__ in release bundles. Plain HTTP is never a release fallback.
    allowLocalHttp: __DEV__,
  });
}
