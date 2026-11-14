import * as Linking from 'expo-linking';
import type { OwnerBookClient } from './supabase';
import { normalizeEmail, passwordProblem, validDisplayName, validEmail } from './validation';
import { validationError } from './errors';
import { parseAuthLink } from './auth-links';

export const authRedirects = {
  recovery: () => Linking.createURL('auth/recovery'),
  confirmation: () => Linking.createURL('auth/confirmation'),
};

export async function signIn(client: OwnerBookClient, email: string, password: string) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized) || !password) throw validationError('Enter your email and password.');
  const { error } = await client.auth.signInWithPassword({ email: normalized, password });
  if (error) throw error;
}
export async function register(
  client: OwnerBookClient,
  email: string,
  password: string,
  confirmation: string,
  displayName: string,
) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw validationError('Enter a valid email address.');
  if (!validDisplayName(displayName))
    throw validationError('Enter a display name of 1–80 characters.');
  const problem = passwordProblem(password, confirmation);
  if (problem) throw validationError(problem);
  const { error } = await client.auth.signUp({
    email: normalized,
    password,
    options: {
      data: { display_name: displayName.trim() },
      emailRedirectTo: authRedirects.confirmation(),
    },
  });
  if (error) throw error;
  // Do not infer account existence from the response. Supabase may obscure it.
}
export async function requestRecovery(client: OwnerBookClient, email: string) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw validationError('Enter a valid email address.');
  const { error } = await client.auth.resetPasswordForEmail(normalized, {
    redirectTo: authRedirects.recovery(),
  });
  if (error) throw error;
}
export async function completeRecovery(
  client: OwnerBookClient,
  password: string,
  confirmation: string,
) {
  const problem = passwordProblem(password, confirmation);
  if (problem) throw validationError(problem);
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
  // Recovery must not leave the temporary email-link session active.
  const { error: logoutError } = await client.auth.signOut({ scope: 'global' });
  if (logoutError) throw logoutError;
}
export async function consumeAuthLink(
  client: OwnerBookClient,
  raw: string,
): Promise<'recovery' | 'confirmation' | null> {
  const link = parseAuthLink(raw, __DEV__);
  if (!link) return null;
  if (link.kind === 'code') {
    const { error } = await client.auth.exchangeCodeForSession(link.code);
    if (error) throw error;
  } else if (link.kind === 'token') {
    const { error } = await client.auth.verifyOtp({
      token_hash: link.tokenHash,
      type: link.purpose === 'recovery' ? 'recovery' : 'signup',
    });
    if (error) throw error;
  } else {
    const { error } = await client.auth.setSession({
      access_token: link.accessToken,
      refresh_token: link.refreshToken,
    });
    if (error) throw error;
  }
  return link.purpose;
}
