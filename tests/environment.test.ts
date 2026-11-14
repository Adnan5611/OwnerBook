import {
  getMobileEnvironment,
  isPublicSupabaseKey,
  readSupabaseEnvironment,
} from '../src/config/environment';

export function testJwt(payload: Record<string, unknown>): string {
  const part = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.test-signature`;
}

const valid = {
  url: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_test_key_123456',
};

describe('public Supabase environment', () => {
  it('accepts a publishable key and normalizes the project URL', () => {
    const result = readSupabaseEnvironment({ ...valid, url: 'https://project.supabase.co/' });
    expect(result).toEqual({ ok: true, configuration: valid, missing: [] });
  });

  it('reports both missing variables without inventing defaults', () => {
    const result = readSupabaseEnvironment({});
    expect(result).toEqual({
      ok: false,
      configuration: null,
      reason: 'missing',
      missing: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
    });
  });

  it('accepts a legacy anon JWT', () => {
    expect(
      readSupabaseEnvironment({ ...valid, publishableKey: testJwt({ role: 'anon' }) }).ok,
    ).toBe(true);
  });

  it.each([
    ['new secret', 'sb_secret_never_ship_this'],
    ['legacy service role', testJwt({ role: 'service_role' })],
    ['authenticated JWT', testJwt({ role: 'authenticated' })],
    ['missing role', testJwt({ sub: 'user' })],
    ['arbitrary string', 'not-a-key'],
    ['empty key', ''],
    ['whitespace in key', 'sb_publishable_invalid key'],
  ])('rejects %s', (_label, publishableKey) => {
    const result = readSupabaseEnvironment({ ...valid, publishableKey });
    expect(result.ok).toBe(false);
    if (publishableKey) expect(JSON.stringify(result)).not.toContain(publishableKey);
  });

  it.each([
    'http://project.supabase.co',
    'javascript:alert(1)',
    'not-a-url',
    'https://user:password@project.supabase.co',
    'https://project.supabase.co?token=secret',
    'https://project.supabase.co#secret',
  ])('rejects unsafe or invalid URL %s', (url) => {
    expect(readSupabaseEnvironment({ ...valid, url }).ok).toBe(false);
  });

  it('allows localhost HTTP only with the explicit development flag', () => {
    const input = { ...valid, url: 'http://127.0.0.1:54321' };
    expect(readSupabaseEnvironment(input).ok).toBe(false);
    expect(readSupabaseEnvironment({ ...input, allowLocalHttp: true }).ok).toBe(true);
    expect(
      readSupabaseEnvironment({ ...input, url: 'http://attacker.example', allowLocalHttp: true })
        .ok,
    ).toBe(false);
  });

  it('trims accidental surrounding whitespace', () => {
    expect(
      readSupabaseEnvironment({
        url: ` ${valid.url} `,
        publishableKey: ` ${valid.publishableKey} `,
      }).ok,
    ).toBe(true);
  });

  it('reads the statically referenced Expo variables', () => {
    const previous = process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_URL = valid.url;
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = valid.publishableKey;
    try {
      expect(getMobileEnvironment().ok).toBe(true);
    } finally {
      process.env.EXPO_PUBLIC_SUPABASE_URL = previous;
      delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    }
  });

  it('does not recognize a malformed JWT as public', () => {
    expect(isPublicSupabaseKey('eyJhbGciOiJIUzI1NiJ9.bad.signature')).toBe(false);
  });
});
