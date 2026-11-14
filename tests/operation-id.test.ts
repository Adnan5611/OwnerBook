import { isOperationId, newOperationId } from '../src/lib/operation-id';
import { postExactlyOnce } from '../src/lib/posting';

/**
 * A predictable idempotency key is worse than none: two different payments could
 * collide and the second would be silently swallowed by the stored receipt. The
 * module must fail loudly when the platform cannot give it a real UUID v4.
 */
jest.mock('expo-crypto', () => ({ randomUUID: () => 'not-a-real-uuid' }));

describe('operation ids without a CSPRNG', () => {
  it('throws instead of degrading to a predictable value', () => {
    expect(() => newOperationId()).toThrow(/cannot generate a safe operation id/i);
    expect(isOperationId('not-a-real-uuid')).toBe(false);
  });

  it('refuses to post a financial document at all', async () => {
    await expect(postExactlyOnce(async () => ({ replayed: false }))).rejects.toThrow(
      /cannot generate a safe operation id/i,
    );
  });
});
