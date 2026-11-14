import { SecureSessionStorage, type SecureStorageBackend } from '../src/lib/secure-session-storage';

function memoryBackend() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  } satisfies SecureStorageBackend & { values: Map<string, string> };
}
const key = 'ownerbook.auth.v1';

describe('encrypted session adapter', () => {
  it('round-trips a large Unicode session through bounded native-store values', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    const session = JSON.stringify({ access_token: 'a'.repeat(6000), user: { name: 'عائشہ 📘' } });
    await storage.setItem(key, session);
    expect(await storage.getItem(key)).toBe(session);
    expect(backend.values.size).toBeGreaterThan(2);
    for (const value of backend.values.values()) expect(value.length).toBeLessThanOrEqual(2048);
    expect([...backend.values.values()].join('')).not.toContain('عائشہ');
  });

  it('returns null when no session exists', async () => {
    await expect(new SecureSessionStorage(memoryBackend()).getItem(key)).resolves.toBeNull();
  });

  it('preserves the last complete session when a new chunk fails', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await storage.setItem(key, 'old-session');
    const original = backend.setItem.getMockImplementation()!;
    backend.setItem.mockImplementationOnce(async () => {
      throw new Error('device full');
    });
    await expect(storage.setItem(key, 'n'.repeat(7000))).rejects.toThrow('device full');
    expect(await storage.getItem(key)).toBe('old-session');
    backend.setItem.mockImplementation(original);
  });

  it('preserves the last complete session when the manifest commit fails', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await storage.setItem(key, 'old-session');
    const original = backend.setItem.getMockImplementation()!;
    backend.setItem.mockImplementation(async (storageKey, value) => {
      if (storageKey.endsWith('.manifest')) throw new Error('commit interrupted');
      await original(storageKey, value);
    });
    await expect(storage.setItem(key, 'new-session')).rejects.toThrow('commit interrupted');
    backend.setItem.mockImplementation(original);
    expect(await storage.getItem(key)).toBe('old-session');
  });

  it('surfaces missing chunks instead of silently signing out or discarding the pointer', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await storage.setItem(key, 'a'.repeat(6000));
    const chunk = [...backend.values.keys()].find((name) => name.endsWith('.0'))!;
    backend.values.delete(chunk);
    await expect(storage.getItem(key)).rejects.toThrow('incomplete');
    expect(backend.values.has(`${key}.manifest`)).toBe(true);
  });

  it.each(['not-json', '{}', JSON.stringify({ version: 1, generation: '../escape', chunks: 1 })])(
    'rejects corrupt or unsafe metadata: %s',
    async (raw) => {
      const backend = memoryBackend();
      backend.values.set(`${key}.manifest`, raw);
      await expect(new SecureSessionStorage(backend).getItem(key)).rejects.toThrow();
    },
  );

  it('invalidates the manifest before deleting chunks on sign-out', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await storage.setItem(key, 'session');
    backend.deleteItem.mockImplementationOnce(async (storageKey) => {
      expect(storageKey).toBe(`${key}.manifest`);
      backend.values.delete(storageKey);
      throw new Error('cleanup interrupted');
    });
    await expect(storage.removeItem(key)).rejects.toThrow('cleanup interrupted');
    expect(await storage.getItem(key)).toBeNull();
  });

  it('serializes overlapping writes and retains the last submitted session', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await Promise.all([
      storage.setItem(key, 'first'.repeat(1000)),
      storage.setItem(key, 'second'.repeat(1000)),
      storage.setItem(key, 'third'),
    ]);
    expect(await storage.getItem(key)).toBe('third');
  });

  it('does not fail a committed write when old-chunk cleanup fails', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    await storage.setItem(key, 'old');
    backend.deleteItem.mockRejectedValueOnce(new Error('cleanup failed'));
    await storage.setItem(key, 'new');
    expect(await storage.getItem(key)).toBe('new');
  });

  it('rejects unexpected keys, unsafe namespaces and oversized payloads', async () => {
    const storage = new SecureSessionStorage(memoryBackend());
    expect(() => new SecureSessionStorage(memoryBackend(), '../unsafe')).toThrow();
    await expect(storage.getItem('another-app')).rejects.toThrow('Unexpected');
    await expect(storage.setItem(key, 'x'.repeat(250_000))).rejects.toThrow('capacity');
  });

  it('invalidates a corrupt pointer on sign-out and permits a fresh session', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    backend.values.set(`${key}.manifest`, 'corrupt');
    await expect(storage.removeItem(key)).rejects.toThrow();
    expect(backend.values.has(`${key}.manifest`)).toBe(false);
    await storage.setItem(key, 'fresh-session');
    expect(await storage.getItem(key)).toBe('fresh-session');
  });

  it('can recover after a failed operation', async () => {
    const backend = memoryBackend();
    const storage = new SecureSessionStorage(backend);
    backend.setItem.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(storage.setItem(key, 'lost-write')).rejects.toThrow();
    await storage.setItem(key, 'next-write');
    expect(await storage.getItem(key)).toBe('next-write');
  });
});
