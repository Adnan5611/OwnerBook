import {
  extractInvitationToken,
  normalizeEmail,
  passwordProblem,
  utf8Length,
  validBusinessName,
  validDisplayName,
  validEmail,
} from '../src/lib/validation';
import { parseAuthLink } from '../src/lib/auth-links';
import { safeErrorMessage } from '../src/lib/errors';
import { chooseMembership } from '../src/lib/business-selection';
import type { BusinessMembership } from '../src/lib/business-service';

describe('identity and invitation validation', () => {
  test.each(['a@example.com', 'person+book@example.co.uk'])('accepts %s', (email) =>
    expect(validEmail(email)).toBe(true),
  );
  test.each(['', 'a@b', 'a @b.com', 'a@b .com', `${'a'.repeat(250)}@b.com`])(
    'rejects malformed email %s',
    (email) => expect(validEmail(email)).toBe(false),
  );
  it('normalizes email without changing passwords', () => {
    expect(normalizeEmail(' A@Example.COM ')).toBe('a@example.com');
    expect(passwordProblem(' abc  ')).toBe('Use at least 10 characters.');
  });
  it('validates Unicode names and rejects control characters', () => {
    expect(validDisplayName(' کتاب ')).toBe(true);
    expect(validBusinessName('Ali & Sons')).toBe(true);
    expect(validDisplayName('')).toBe(false);
    expect(validDisplayName('a\nb')).toBe(false);
    expect(validBusinessName('a'.repeat(121))).toBe(false);
  });
  it('enforces password confirmation and bcrypt UTF-8 byte limit', () => {
    expect(passwordProblem('long passphrase', 'long passphrase')).toBeNull();
    expect(passwordProblem('long passphrase', 'different')).toBe('Passwords do not match.');
    const emoji = String.fromCodePoint(0x1f510);
    expect(utf8Length(emoji)).toBe(4);
    expect(passwordProblem(emoji.repeat(19))).toMatch(/72 UTF-8/);
    expect(passwordProblem(emoji.repeat(17))).toBeNull();
  });
  it('accepts only exact 256-bit lowercase hexadecimal invitations', () => {
    const token = 'a'.repeat(64);
    expect(extractInvitationToken(token)).toBe(token);
    expect(extractInvitationToken(`ownerbook://invite?token=${token}`)).toBe(token);
    for (const input of [
      'a'.repeat(63),
      'A'.repeat(64),
      `https://evil.test/invite?token=${token}`,
      `ownerbook://evil?token=${token}`,
      `ownerbook://invite?token=${token}&x=1`,
    ])
      expect(extractInvitationToken(input)).toBeNull();
  });
  it('selects only an actual membership and safely falls back after removal', () => {
    const a = { business: { id: 'a' }, membership: { role: 'owner' } } as BusinessMembership;
    const b = { business: { id: 'b' }, membership: { role: 'staff' } } as BusinessMembership;
    expect(chooseMembership([a, b], 'b')).toBe(b);
    expect(chooseMembership([a, b], 'removed')).toBe(a);
    expect(chooseMembership([], 'a')).toBeNull();
  });
  it('does not expose arbitrary server messages, tokens, or stack traces', () => {
    expect(safeErrorMessage({ message: 'secret-token xyz', code: 'unknown' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(safeErrorMessage({ code: '23514' })).toMatch(/active owner/);
    expect(safeErrorMessage({ code: 'invalid_credentials' })).toMatch(/incorrect/);
    expect(safeErrorMessage(null)).toMatch(/Something went wrong/);
  });
});
describe('allowlisted authentication callbacks', () => {
  it('routes recovery separately from confirmation', () => {
    expect(parseAuthLink('ownerbook://auth/recovery?code=abc')).toEqual({
      kind: 'code',
      purpose: 'recovery',
      code: 'abc',
    });
    expect(parseAuthLink('ownerbook://auth/confirmation?code=abc')).toEqual({
      kind: 'code',
      purpose: 'confirmation',
      code: 'abc',
    });
  });
  it('supports a one-time hashed email token', () => {
    expect(
      parseAuthLink(`ownerbook://auth/recovery?token_hash=${'a'.repeat(64)}&type=recovery`),
    ).toEqual({ kind: 'token', purpose: 'recovery', tokenHash: 'a'.repeat(64) });
  });
  it('supports Supabase recovery fragments but requires both tokens and recovery type', () => {
    expect(
      parseAuthLink('ownerbook://auth/recovery#access_token=a&refresh_token=b&type=recovery'),
    ).toMatchObject({ kind: 'session', accessToken: 'a', refreshToken: 'b' });
    expect(parseAuthLink('ownerbook://auth/recovery#access_token=a&type=recovery')).toBeNull();
    expect(
      parseAuthLink('ownerbook://auth/confirmation#access_token=a&refresh_token=b&type=recovery'),
    ).toBeNull();
  });
  it('rejects foreign origins, malformed tokens, errors and wrong OTP types', () => {
    for (const url of [
      'https://evil.test/auth/recovery?code=a',
      'ownerbook://evil/recovery?code=a',
      'ownerbook://auth/recovery#error=access_denied',
      'ownerbook://auth/other?code=a',
      'ownerbook://auth/recovery?token_hash=bad&type=recovery',
      'ownerbook://auth/confirmation?token_hash=' + 'a'.repeat(64) + '&type=recovery',
    ])
      expect(parseAuthLink(url)).toBeNull();
  });
  it('allows Expo development callbacks only when explicitly enabled', () => {
    const url = 'exp://192.0.2.1:8081/--/auth/recovery?code=a';
    expect(parseAuthLink(url)).toBeNull();
    expect(parseAuthLink(url, true)).toMatchObject({ purpose: 'recovery' });
  });
});
