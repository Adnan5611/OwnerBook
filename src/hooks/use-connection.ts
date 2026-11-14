import { useCallback, useEffect, useRef, useState } from 'react';
import { checkSupabaseConnection, type ConnectionResult } from '../lib/connection';
import type { OwnerBookClient } from '../lib/supabase';

export type ConnectionState =
  { kind: 'idle' } | { kind: 'checking' } | { kind: 'checked'; result: ConnectionResult };

export function useConnection(client: OwnerBookClient | null, reachable: boolean | null) {
  const [state, setState] = useState<ConnectionState>({ kind: 'idle' });
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, []);

  const check = useCallback(async () => {
    if (!client || reachable === false || inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current;
    setState({ kind: 'checking' });
    const result = await checkSupabaseConnection(client);
    if (mounted.current && current === sequence.current) setState({ kind: 'checked', result });
    inFlight.current = false;
  }, [client, reachable]);

  return { state, check };
}
