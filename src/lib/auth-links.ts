export type AuthLink =
  | { kind: 'code'; purpose: 'recovery' | 'confirmation'; code: string }
  | { kind: 'token'; purpose: 'recovery' | 'confirmation'; tokenHash: string }
  | { kind: 'session'; purpose: 'recovery'; accessToken: string; refreshToken: string };

/** Only callbacks addressed to this app may establish or recover a session. */
export function parseAuthLink(raw: string, allowDevelopment = false): AuthLink | null {
  try {
    const url = new URL(raw);
    const custom = url.protocol === 'ownerbook:' && url.hostname === 'auth';
    const development =
      allowDevelopment &&
      ['exp:', 'exps:'].includes(url.protocol) &&
      /\/--\/auth\/(recovery|confirmation)$/.test(url.pathname);
    if (!custom && !development) return null;
    const match = url.pathname.match(/\/(recovery|confirmation)$/);
    if (!match) return null;
    const purpose = match[1] as 'recovery' | 'confirmation';
    const query = url.searchParams;
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (query.get('error') || fragment.get('error')) return null;
    const code = query.get('code');
    if (code && code.length <= 4096) return { kind: 'code', purpose, code };
    const tokenHash = query.get('token_hash');
    if (
      tokenHash &&
      /^[a-f0-9]{64}$/.test(tokenHash) &&
      query.get('type') === (purpose === 'recovery' ? 'recovery' : 'signup')
    ) {
      return { kind: 'token', purpose, tokenHash };
    }
    const accessToken = fragment.get('access_token');
    const refreshToken = fragment.get('refresh_token');
    if (
      purpose === 'recovery' &&
      fragment.get('type') === 'recovery' &&
      accessToken &&
      refreshToken &&
      accessToken.length < 16384 &&
      refreshToken.length < 4096
    ) {
      return { kind: 'session', purpose, accessToken, refreshToken };
    }
    return null;
  } catch {
    return null;
  }
}
