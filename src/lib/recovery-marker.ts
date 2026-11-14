import * as SecureStore from 'expo-secure-store';

const KEY = 'ownerbook.recovery.v1';
// Auth emits several events during one recovery. Serialize marker reads/writes so
// a slow "pending" write cannot resurrect the gate after a later clear/sign-out.
let tail: Promise<void> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = tail.then(operation, operation);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** A marker, not a credential. Preserves the recovery gate across process death. */
export function markRecovery(userId = 'pending'): Promise<void> {
  return serialize(() =>
    SecureStore.setItemAsync(KEY, userId, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  );
}
export function recoveryRequired(userId: string): Promise<boolean> {
  return serialize(async () => {
    const value = await SecureStore.getItemAsync(KEY);
    return value === 'pending' || value === userId;
  });
}
export function clearRecovery(): Promise<void> {
  return serialize(() => SecureStore.deleteItemAsync(KEY));
}
