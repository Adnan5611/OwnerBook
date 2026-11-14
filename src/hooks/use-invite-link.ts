import { useCallback, useEffect, useState } from 'react';
import * as Linking from 'expo-linking';
import { extractInvitationToken } from '../lib/validation';

/** Bearer tokens stay in memory only; authentication may complete before acceptance. */
export function useInviteLink() {
  const [token, setToken] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    const handle = (url: string | null) => {
      const parsed = url ? extractInvitationToken(url) : null;
      if (parsed && alive) setToken(parsed);
    };
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  const clear = useCallback(() => setToken(undefined), []);
  return { token, clear };
}
