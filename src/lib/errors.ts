/** Render allowlisted messages, never raw server/native errors or link tokens. */
export function safeErrorMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!error || typeof error !== 'object') return fallback;
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (/rate.limit|too.many|over_request_rate_limit/i.test(`${code} ${message}`))
    return 'Too many attempts. Please wait before trying again.';
  if (/email_not_confirmed/i.test(code)) return 'Confirm your email address before signing in.';
  if (/invalid.credentials|invalid_login_credentials/i.test(code))
    return 'Email or password is incorrect.';
  if (/user_already_exists|email_exists/i.test(code))
    return 'Unable to register with those details. Try signing in or recovering your password.';
  if (/same_password|weak_password/i.test(code)) return 'Choose a different, stronger password.';
  if (/session_missing|session_expired|refresh_token/i.test(code))
    return 'Your session expired. Sign in again.';
  if (/network|fetch|timeout/i.test(message))
    return 'Could not connect. Check your connection and try again.';
  const known: Record<string, string> = {
    '42501': 'You do not have permission, or this invitation is invalid or expired.',
    '22023': 'Check the values you entered. This action may no longer be available.',
    '23505': 'That record already exists. Check for a duplicate phone number or reference.',
    '23514': /check constraint/i.test(message)
      ? 'Those amounts are not allowed. Check the totals and try again.'
      : 'A business must retain an active owner. Transfer ownership first.',
    P0002: 'That record no longer exists. Refresh and try again.',
    OWNERBOOK_VALIDATION: message,
  };
  return known[code] ?? fallback;
}
export function validationError(message: string) {
  return { code: 'OWNERBOOK_VALIDATION', message };
}
/**
 * Copy for the permission matrix the database enforces. The server decides; these
 * strings only explain a refusal that has already happened.
 */
export const PERMISSION_COPY = {
  financialSummary: 'Owners, managers and accountants can see profit and cash summaries.',
  expenses: 'Owners, managers and accountants can record and view expenses.',
  voidDocuments: 'Owners, managers and accountants can void a recorded document.',
  catalog: 'Owners, managers and accountants can change the item catalog.',
  adjustments: 'Owners, managers and accountants can adjust a khata balance.',
} as const;
