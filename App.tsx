import { useEffect, useMemo, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppErrorBoundary } from './src/components/AppErrorBoundary';
import { FoundationScreen } from './src/components/FoundationScreen';
import { getMobileEnvironment } from './src/config/environment';
import { useConnection } from './src/hooks/use-connection';
import { useInviteLink } from './src/hooks/use-invite-link';
import { getSupabaseClient, observeAuthLifecycle } from './src/lib/supabase';
import type { OwnerBookClient } from './src/lib/supabase';
import { Loading } from './src/components/ui';
import { AuthProvider, useAuth } from './src/providers/auth-provider';
import { AppNavigation } from './src/navigation/app-navigation';
import NetInfo from '@react-native-community/netinfo';

function Foundation() {
  const environment = useMemo(() => getMobileEnvironment(), []);
  const network = NetInfo.useNetInfo();
  const reachable =
    network.isConnected === false || network.isInternetReachable === false
      ? false
      : network.isConnected === true && network.isInternetReachable === true
        ? true
        : null;
  const { state, check } = useConnection(null, reachable);
  return (
    <FoundationScreen
      environment={environment}
      reachable={reachable}
      connection={state}
      onCheck={() => void check()}
    />
  );
}
function Root() {
  const client = useMemo(() => getSupabaseClient(), []);
  const invite = useInviteLink();
  useEffect(() => {
    if (client) return observeAuthLifecycle(client.auth);
  }, [client]);
  if (!client) return <Foundation />;
  return (
    <AuthProvider client={client}>
      <AuthenticatedRoot client={client} inviteToken={invite.token} clearInvite={invite.clear} />
    </AuthProvider>
  );
}
function AuthenticatedRoot({
  client,
  inviteToken,
  clearInvite,
}: {
  client: OwnerBookClient;
  inviteToken?: string;
  clearInvite: () => void;
}) {
  const auth = useAuth();
  const previousUser = useRef<string | null>(null);
  useEffect(() => {
    const id = auth.session?.user.id ?? null;
    if (previousUser.current && previousUser.current !== id) clearInvite();
    previousUser.current = id;
  }, [auth.session?.user.id, clearInvite]);
  if (auth.loading) return <Loading label="Restoring your secure session…" />;
  return <AppNavigation client={client} inviteToken={inviteToken} clearInvite={clearInvite} />;
}
export default function App() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <StatusBar style="dark" />
        <Root />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}
