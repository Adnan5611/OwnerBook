import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Linking from 'expo-linking';
import type { Session } from '@supabase/supabase-js';
import type { OwnerBookClient } from '../lib/supabase';
import { consumeAuthLink } from '../lib/auth-service';
import { parseAuthLink } from '../lib/auth-links';
import { clearRecovery, markRecovery, recoveryRequired } from '../lib/recovery-marker';

type AuthState = {
  session: Session | null;
  loading: boolean;
  recovery: boolean;
  error: string | null;
  clearError: () => void;
  finishRecovery: () => void;
  signOut: (scope?: 'global' | 'local') => Promise<void>;
};
const Context = createContext<AuthState | null>(null);
export function AuthProvider({
  client,
  children,
}: {
  client: OwnerBookClient;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const initialized = useRef(false);
  const lastLink = useRef<string | null>(null);
  const recoveryGate = useRef(false);
  const latestSession = useRef<Session | null>(null);
  useEffect(() => {
    alive.current = true;
    initialized.current = false;
    let queue: Promise<void> = Promise.resolve();
    let receivedAuthEvent = false;
    let resolveInitialLink!: () => void;
    const initialLinkHandled = new Promise<void>((resolve) => {
      resolveInitialLink = resolve;
    });
    const gate = (value: boolean) => {
      recoveryGate.current = value;
      if (alive.current) setRecovery(value);
    };
    const persistMarker = async (id?: string) => {
      try {
        await markRecovery(id);
      } catch {
        if (alive.current)
          setError(
            'Recovery could not be saved securely. Keep the app open and finish resetting your password.',
          );
      }
    };
    const handleLink = (url: string | null) => {
      const parsed = url ? parseAuthLink(url, __DEV__) : null;
      if (!url || !parsed || lastLink.current === url) return;
      lastLink.current = url;
      queue = queue.then(async () => {
        const previouslyGated = recoveryGate.current;
        if (parsed.purpose === 'recovery') {
          gate(true);
          await persistMarker();
        }
        try {
          const result = await consumeAuthLink(client, url);
          if (alive.current && result === 'confirmation')
            setError('Email confirmed. Your account is ready.');
        } catch {
          if (alive.current) {
            // A bad warm link must not unlock an already-gated recovery session.
            const current = latestSession.current;
            let required = false;
            try {
              required = !!current && (await recoveryRequired(current.user.id));
            } catch {
              required = true;
            }
            gate(required || previouslyGated);
            if (!latestSession.current && !previouslyGated) await clearRecovery().catch(() => {});
            setError(
              'This email link is invalid, expired or was opened on another device. Request a new link.',
            );
          }
        }
      });
    };
    // Subscribe before reading storage or links, as required by Supabase Auth.
    const { data } = client.auth.onAuthStateChange((event, next) => {
      if (!alive.current) return;
      latestSession.current = next;
      receivedAuthEvent = true;
      if (event === 'PASSWORD_RECOVERY') {
        gate(true);
        void persistMarker(next?.user.id);
      }
      if (event === 'SIGNED_OUT') {
        gate(false);
        lastLink.current = null;
        void clearRecovery().catch(() => {});
      }
      if (next && recoveryGate.current) void persistMarker(next.user.id);
      if (initialized.current) {
        setSession(next);
        setLoading(false);
      }
    });
    void Linking.getInitialURL()
      .then((url) => {
        handleLink(url);
        resolveInitialLink();
      })
      .catch(resolveInitialLink);
    void Promise.all([client.auth.getSession(), initialLinkHandled])
      .then(async ([{ data: stored, error: sessionError }]) => {
        await queue;
        if (!alive.current) return;
        // A null auth event is authoritative, including sign-out during initialization.
        // Never fall back to an older getSession result after such an event.
        const restored = receivedAuthEvent ? latestSession.current : stored.session;
        if (restored && !recoveryGate.current) {
          try {
            if (await recoveryRequired(restored.user.id)) gate(true);
          } catch {
            gate(true);
            setError('Secure recovery status could not be read. Reset your password or sign out.');
          }
        }
        if (!alive.current) return;
        initialized.current = true;
        setSession(restored);
        if (sessionError)
          setError('Your saved session could not be restored. Try signing in again.');
        setLoading(false);
      })
      .catch(() => {
        if (alive.current) {
          initialized.current = true;
          setError('Secure session storage is unavailable. Restart the app or sign in again.');
          setLoading(false);
        }
      });
    const subscription = Linking.addEventListener('url', ({ url }) => handleLink(url));
    return () => {
      alive.current = false;
      subscription.remove();
      data.subscription.unsubscribe();
    };
  }, [client]);
  const signOut = useCallback(
    async (scope: 'global' | 'local' = 'global') => {
      const { error: signOutError } = await client.auth.signOut({ scope });
      if (signOutError) throw signOutError;
      await clearRecovery().catch(() => {});
      recoveryGate.current = false;
      latestSession.current = null;
      setSession(null);
      setRecovery(false);
      setError(null);
    },
    [client],
  );
  return (
    <Context.Provider
      value={{
        session,
        loading,
        recovery,
        error,
        clearError: () => setError(null),
        finishRecovery: () => {
          recoveryGate.current = false;
          setRecovery(false);
          setError(null);
        },
        signOut,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const value = useContext(Context);
  if (!value) throw new Error('AuthProvider is missing');
  return value;
}
