import type { OwnerBookClient } from './supabase';
import type { Business, BusinessRole, Currency, Membership, Profile } from '../types/database';
import {
  validBusinessName,
  validDisplayName,
  validEmail,
  normalizeEmail,
  extractInvitationToken,
} from './validation';
import { validationError } from './errors';

export type BusinessMembership = { business: Business; membership: Membership };

export async function loadWorkspace(client: OwnerBookClient, userId: string) {
  const [businessResult, membershipResult, profileResult, currencyResult] = await Promise.all([
    client.from('businesses').select('*').order('created_at', { ascending: true }),
    client.from('business_members').select('*').eq('user_id', userId).is('removed_at', null),
    client.from('profiles').select('*').eq('id', userId).single(),
    client.from('currencies').select('*').order('code'),
  ]);
  const error =
    businessResult.error ?? membershipResult.error ?? profileResult.error ?? currencyResult.error;
  if (error) throw error;
  const byId = new Map(
    (membershipResult.data ?? []).map((membership) => [membership.business_id, membership]),
  );
  const memberships: BusinessMembership[] = (businessResult.data ?? []).flatMap((business) => {
    const membership = byId.get(business.id);
    return membership ? [{ business, membership }] : [];
  });
  if (!profileResult.data)
    throw validationError(
      'Your profile is not ready. Apply the latest database migration and retry.',
    );
  return {
    memberships,
    profile: profileResult.data as Profile,
    currencies: (currencyResult.data ?? []) as Currency[],
  };
}
export async function createBusiness(
  client: OwnerBookClient,
  name: string,
  currency: string,
  timezone: string,
) {
  if (!validBusinessName(name)) throw validationError('Enter a business name of 1–120 characters.');
  const { data, error } = await client.rpc('create_business', {
    p_name: name.trim(),
    p_currency: currency,
    p_timezone: timezone,
  });
  if (error) throw error;
  return data;
}
export async function saveBusinessSettings(
  client: OwnerBookClient,
  business: Business,
  coOwnersCanInvite: boolean,
) {
  if (!validBusinessName(business.name))
    throw validationError('Enter a business name of 1–120 characters.');
  const { error } = await client.rpc('update_business_settings', {
    p_business_id: business.id,
    p_name: business.name.trim(),
    p_currency: business.currency,
    p_timezone: business.timezone.trim(),
    p_co_owners_can_invite: coOwnersCanInvite,
  });
  if (error) throw error;
}
export async function loadMembers(client: OwnerBookClient, businessId: string) {
  const { data: members, error } = await client
    .from('business_members')
    .select('*')
    .eq('business_id', businessId)
    .is('removed_at', null)
    .order('created_at');
  if (error) throw error;
  const rows = members ?? [];
  if (!rows.length) return [];
  const { data: profiles, error: profileError } = await client
    .from('profiles')
    .select('*')
    .in(
      'id',
      rows.map((member) => member.user_id),
    );
  if (profileError) throw profileError;
  const names = new Map((profiles ?? []).map((profile) => [profile.id, profile.display_name]));
  return rows.map((row) => ({
    ...row,
    name: row.display_name ?? names.get(row.user_id) ?? 'Member',
  }));
}
export async function createInvitation(
  client: OwnerBookClient,
  businessId: string,
  role: BusinessRole,
  email: string,
  hours: number,
) {
  if (role === 'owner') throw validationError('Ownership cannot be granted by invitation.');
  const normalized = email.trim() ? normalizeEmail(email) : null;
  if (normalized && !validEmail(normalized))
    throw validationError('Enter a valid email or leave it blank for a shareable invitation.');
  const { data, error } = await client.rpc('create_invitation', {
    p_business_id: businessId,
    p_role: role,
    p_email: normalized,
    p_expires_hours: hours,
  });
  if (error) throw error;
  if (!data || !/^[a-f0-9]{64}$/.test(data.token))
    throw validationError('The server returned an invalid invitation. Do not share it.');
  return data;
}
export async function previewInvitation(client: OwnerBookClient, input: string) {
  const token = extractInvitationToken(input);
  if (!token) throw validationError('Paste a valid OwnerBook invitation link or code.');
  const { data, error } = await client.rpc('preview_invitation', { p_token: token });
  if (error) throw error;
  return { preview: data, token };
}
export async function acceptInvitation(client: OwnerBookClient, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw validationError('Invalid invitation code.');
  const { data, error } = await client.rpc('accept_invitation', { p_token: token });
  if (error) throw error;
  return data;
}
export async function saveProfile(client: OwnerBookClient, userId: string, name: string) {
  if (!validDisplayName(name)) throw validationError('Enter a display name of 1–80 characters.');
  const { error } = await client
    .from('profiles')
    .update({ display_name: name.trim() })
    .eq('id', userId)
    .select('id')
    .single();
  if (error) throw error;
}
