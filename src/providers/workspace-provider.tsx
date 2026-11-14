import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { OwnerBookClient } from '../lib/supabase';
import { loadWorkspace, type BusinessMembership } from '../lib/business-service';
import { chooseMembership, readSelection, saveSelection } from '../lib/business-selection';
import type { Currency, Profile } from '../types/database';
import { safeErrorMessage } from '../lib/errors';

type WorkspaceState = {
  memberships: BusinessMembership[];
  active: BusinessMembership | null;
  profile: Profile | null;
  currencies: Currency[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<BusinessMembership[]>;
  select: (businessId: string, available?: BusinessMembership[]) => Promise<void>;
  canInvite: boolean;
};
const Context = createContext<WorkspaceState | null>(null);
/** Mount with key={session.user.id}: no previous user's data survives an account switch. */
export function WorkspaceProvider({
  client,
  userId,
  children,
}: {
  client: OwnerBookClient;
  userId: string;
  children: ReactNode;
}) {
  const [memberships, setMemberships] = useState<BusinessMembership[]>([]);
  const [active, setActive] = useState<BusinessMembership | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const selectedId = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    const requests = generation;
    return () => {
      alive.current = false;
      requests.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const [result, stored] = await Promise.all([
        loadWorkspace(client, userId),
        readSelection(userId),
      ]);
      if (!alive.current || current !== generation.current) return [];
      const selected = chooseMembership(result.memberships, selectedId.current ?? stored);
      selectedId.current = selected?.business.id ?? null;
      setMemberships(result.memberships);
      setActive(selected);
      setProfile(result.profile);
      setCurrencies(result.currencies);
      return result.memberships;
    } catch (cause) {
      if (alive.current && current === generation.current)
        setError(
          safeErrorMessage(
            cause,
            'Could not load your workspace. Retry; no records have been changed.',
          ),
        );
      return [];
    } finally {
      if (alive.current && current === generation.current) setLoading(false);
    }
  }, [client, userId]);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) return refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);
  const select = useCallback(
    async (id: string, available?: BusinessMembership[]) => {
      const selected = (available ?? memberships).find((item) => item.business.id === id);
      if (!selected) throw new Error('Membership no longer available');
      // An explicit selection wins over an older, still-running workspace request.
      generation.current += 1;
      setLoading(false);
      selectedId.current = id;
      setActive(selected);
      try {
        await saveSelection(userId, id);
      } catch {
        if (alive.current)
          setError('Business switched, but this device could not save the selection.');
      }
    },
    [memberships, userId],
  );
  const role = active?.membership.role;
  return (
    <Context.Provider
      value={{
        memberships,
        active,
        profile,
        currencies,
        loading,
        error,
        refresh,
        select,
        canInvite:
          role === 'owner' || (role === 'co_owner' && !!active?.business.co_owners_can_invite),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error('WorkspaceProvider is missing');
  return value;
}
