import { randomUUID as nodeRandomUUID } from 'node:crypto';

/**
 * Jest stand-in for the native `expo-crypto` module.
 *
 * jest-expo replaces the native module with `undefined`, which would hand every
 * test the same idempotency key and hide duplicate-posting bugs. Node's real
 * CSPRNG keeps the tests honest; the device build uses the native module.
 */
export function randomUUID(): string {
  return nodeRandomUUID();
}
