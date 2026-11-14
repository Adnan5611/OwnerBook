import * as SecureStore from 'expo-secure-store';
import type { BusinessMembership } from './business-service';

/** Only the authenticated user's UUID and a validated selection are stored, never records/tokens. */
export function chooseMembership(
  memberships: BusinessMembership[],
  storedId: string | null,
): BusinessMembership | null {
  return memberships.find((item) => item.business.id === storedId) ?? memberships[0] ?? null;
}
function key(userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid user id');
  return `ownerbook.active.${userId}`;
}
export async function readSelection(userId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key(userId));
  } catch {
    return null;
  }
}
export async function saveSelection(userId: string, businessId: string | null): Promise<void> {
  if (businessId) await SecureStore.setItemAsync(key(userId), businessId);
  else await SecureStore.deleteItemAsync(key(userId));
}
