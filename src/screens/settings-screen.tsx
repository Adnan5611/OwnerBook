import { useState } from 'react';
import { Alert, Text } from 'react-native';
import type { OwnerBookClient } from '../lib/supabase';
import { useAuth } from '../providers/auth-provider';
import { useWorkspace } from '../providers/workspace-provider';
import { useConnection } from '../hooks/use-connection';
import { useNetwork } from '../hooks/use-network';
import { Button, Card, Field, KeyValue, Notice, Screen, colors } from '../components/ui';
import { saveProfile } from '../lib/business-service';
import { ROLE_LABELS } from '../lib/validation';
import { safeErrorMessage } from '../lib/errors';
import { ArchiveBusiness } from './business-screens';

type Props = {
  client: OwnerBookClient;
  onBusinesses: () => void;
  onMembers: () => void;
  onSettings: () => void;
  onProfile?: () => void;
};
export function SettingsScreen({ client, onBusinesses, onMembers, onSettings }: Props) {
  const auth = useAuth();
  const workspace = useWorkspace();
  const { connected: reachable } = useNetwork();
  const connection = useConnection(client, reachable);
  const [name, setName] = useState(workspace.profile?.display_name ?? '');
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const business = workspace.active?.business;
  const owner = workspace.active?.membership.role === 'owner';
  const save = async () => {
    if (!auth.session || busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await saveProfile(client, auth.session.user.id, name);
      await workspace.refresh();
      setMessage('Profile saved.');
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const logout = () =>
    Alert.alert(
      'Sign out?',
      'Global sign-out revokes sessions on all devices and requires a connection. Local sign-out removes only this device’s session.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This device only', onPress: () => void signOut('local') },
        { text: 'All devices', style: 'destructive', onPress: () => void signOut('global') },
      ],
    );
  const signOut = async (scope: 'global' | 'local') => {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      await auth.signOut(scope);
    } catch (cause) {
      setError(
        safeErrorMessage(
          cause,
          'Could not sign out. Check your connection or choose this device only.',
        ),
      );
    } finally {
      setSigningOut(false);
    }
  };
  return (
    <Screen title="Settings" subtitle={auth.session?.user.email ?? 'Your account'}>
      {!!workspace.error && <Notice error>{workspace.error}</Notice>}
      <Card>
        <Text accessibilityRole="header" style={heading}>
          Active business
        </Text>
        <KeyValue label="Business" value={business?.name ?? 'None'} />
        <KeyValue
          label="Your role"
          value={workspace.active ? ROLE_LABELS[workspace.active.membership.role] : 'None'}
        />
        <KeyValue
          label="Currency / timezone"
          value={`${business?.currency ?? '—'} / ${business?.timezone ?? '—'}`}
        />
        <Button title="Switch or create business" secondary onPress={onBusinesses} />
        <Button title="Team and permissions" secondary onPress={onMembers} />
        {owner && <Button title="Business settings" secondary onPress={onSettings} />}
      </Card>
      <Card>
        <Text accessibilityRole="header" style={heading}>
          Your profile
        </Text>
        <Field label="Display name" value={name} onChangeText={setName} maxLength={80} />
        <Button title="Save profile" onPress={() => void save()} busy={busy} />
        {!!message && <Notice>{message}</Notice>}
      </Card>
      {owner && business && <ArchiveBusiness client={client} />}
      <Card>
        <Text accessibilityRole="header" style={heading}>
          Connection
        </Text>
        <Text style={{ color: colors.muted }}>
          {reachable === false
            ? 'Offline — business changes are unavailable.'
            : reachable === null
              ? 'Checking network…'
              : 'Network available'}
        </Text>
        {connection.state.kind === 'checked' && (
          <Notice error={!connection.state.result.ok}>
            {connection.state.result.ok
              ? `Database connected · schema ${connection.state.result.health.schema_version} · ${connection.state.result.health.database_time}`
              : connection.state.result.message}
          </Notice>
        )}
        <Button
          title="Check database connection"
          secondary
          onPress={() => void connection.check()}
          busy={connection.state.kind === 'checking'}
          disabled={reachable === false}
        />
        <Notice>
          SQLite is installed, but no financial offline cache or write queue is enabled. Business
          administration is online-only in this phase.
        </Notice>
      </Card>
      {!!error && <Notice error>{error}</Notice>}
      <Button title="Sign out" danger onPress={logout} busy={signingOut} />
      <Text style={{ color: colors.muted, fontSize: 13 }}>
        OwnerBook · Phase 2 · No sample financial data
      </Text>
    </Screen>
  );
}
const heading = { fontSize: 19, fontWeight: '700' as const, color: colors.ink };
