import { clearRecovery, markRecovery, recoveryRequired } from '../src/lib/recovery-marker';
import * as SecureStore from 'expo-secure-store';

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device',
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('persistent recovery gate', () => {
  it('cannot resurrect a cleared marker when an earlier write finishes late', async () => {
    let release!: () => void;
    const values = new Map<string, string>();
    jest.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      values.set(key, value);
    });
    jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      values.delete(key);
    });
    jest
      .mocked(SecureStore.getItemAsync)
      .mockImplementation(async (key) => values.get(key) ?? null);
    const pending = markRecovery();
    await Promise.resolve();
    const cleared = clearRecovery();
    release();
    await Promise.all([pending, cleared]);
    await expect(recoveryRequired('user')).resolves.toBe(false);
  });
});
