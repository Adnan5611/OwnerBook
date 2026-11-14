import * as SecureStore from 'expo-secure-store';

export type SecureStorageBackend = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  deleteItem: (key: string) => Promise<void>;
};

const nativeBackend: SecureStorageBackend = {
  getItem: (key) => SecureStore.getItemAsync(key, { keychainService: 'ownerbook.auth' }),
  setItem: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainService: 'ownerbook.auth',
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, { keychainService: 'ownerbook.auth' }),
};

const CHUNK_LENGTH = 1536;
const MAX_CHUNKS = 128;
const STORAGE_VERSION = 1;

type Manifest = { version: number; generation: string; chunks: number };

/**
 * Supabase sessions may exceed SecureStore's recommended value size. Store bounded
 * ASCII chunks in the OS-encrypted store, never plaintext financial/session data in
 * AsyncStorage. A generation-specific manifest is committed LAST. Interrupted writes
 * cannot replace the last complete session. Operations are serialized per adapter.
 *
 * This is crash-consistent at the manifest level, not a multi-key OS transaction.
 * Cleanup is best effort; stale chunks remain encrypted and are never selected.
 */
export class SecureSessionStorage {
  private tail: Promise<void> = Promise.resolve();
  private generationCounter = 0;

  constructor(
    private readonly backend: SecureStorageBackend = nativeBackend,
    private readonly namespace = 'ownerbook.auth.v1',
  ) {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(namespace)) {
      throw new Error('Invalid secure-storage namespace.');
    }
  }

  private get manifestKey() {
    return `${this.namespace}.manifest`;
  }

  private chunkKey(generation: string, index: number) {
    return `${this.namespace}.${generation}.${index}`;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readManifest(): Promise<Manifest | null> {
    const raw = await this.backend.getItem(this.manifestKey);
    if (raw === null) return null;
    let manifest: Manifest;
    try {
      manifest = JSON.parse(raw) as Manifest;
    } catch {
      throw new Error('Secure session metadata is unreadable.');
    }
    if (
      !manifest ||
      manifest.version !== STORAGE_VERSION ||
      !/^[0-9]{1,16}-[0-9]{1,6}$/.test(manifest.generation) ||
      !Number.isInteger(manifest.chunks) ||
      manifest.chunks < 1 ||
      manifest.chunks > MAX_CHUNKS
    ) {
      throw new Error('Secure session metadata is invalid.');
    }
    return manifest;
  }

  private async deleteChunks(manifest: Manifest) {
    for (let index = 0; index < manifest.chunks; index += 1) {
      await this.backend.deleteItem(this.chunkKey(manifest.generation, index));
    }
  }

  getItem = (key: string): Promise<string | null> =>
    this.serialize(async () => {
      if (key !== this.namespace) throw new Error('Unexpected secure-storage key.');
      const manifest = await this.readManifest();
      if (!manifest) return null;
      const chunks = await Promise.all(
        Array.from({ length: manifest.chunks }, (_, index) =>
          this.backend.getItem(this.chunkKey(manifest.generation, index)),
        ),
      );
      // encodeURIComponent also preserves _ . ! ~ * ' ( ) - in addition to alphanumerics.
      if (chunks.some((chunk) => chunk === null || !/^[A-Za-z0-9%_.!~*'()-]*$/.test(chunk))) {
        throw new Error('Secure session is incomplete. It has not been discarded.');
      }
      try {
        return decodeURIComponent(chunks.join(''));
      } catch {
        throw new Error('Secure session is unreadable. It has not been discarded.');
      }
    });

  setItem = (key: string, value: string): Promise<void> =>
    this.serialize(async () => {
      if (key !== this.namespace) throw new Error('Unexpected secure-storage key.');
      const encoded = encodeURIComponent(value);
      const chunkCount = Math.max(1, Math.ceil(encoded.length / CHUNK_LENGTH));
      if (chunkCount > MAX_CHUNKS) throw new Error('Session exceeds secure-storage capacity.');
      const previous = await this.readManifest();
      this.generationCounter += 1;
      const timestamp = Math.max(Date.now(), Number(previous?.generation.split('-')[0] ?? 0) + 1);
      const manifest: Manifest = {
        version: STORAGE_VERSION,
        generation: `${timestamp}-${this.generationCounter}`,
        chunks: chunkCount,
      };
      for (let index = 0; index < chunkCount; index += 1) {
        const start = index * CHUNK_LENGTH;
        await this.backend.setItem(
          this.chunkKey(manifest.generation, index),
          encoded.slice(start, start + CHUNK_LENGTH),
        );
      }
      await this.backend.setItem(this.manifestKey, JSON.stringify(manifest));
      if (previous) {
        // The new session is durable before cleanup. A cleanup failure is not a write failure.
        try {
          await this.deleteChunks(previous);
        } catch {
          // No token values or native error payloads are logged.
        }
      }
    });

  removeItem = (key: string): Promise<void> =>
    this.serialize(async () => {
      if (key !== this.namespace) throw new Error('Unexpected secure-storage key.');
      let manifest: Manifest | null = null;
      let metadataError: unknown;
      try {
        manifest = await this.readManifest();
      } catch (error) {
        metadataError = error;
      }
      // Invalidate the pointer first, even when corrupt, so sign-out cannot
      // resurrect an old session. Orphaned chunks stay encrypted until cleanup.
      await this.backend.deleteItem(this.manifestKey);
      if (metadataError) throw metadataError;
      if (manifest) await this.deleteChunks(manifest);
    });
}

export const secureSessionStorage = new SecureSessionStorage();
