import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert, Text } from 'react-native';
import type { OwnerBookClient } from '../lib/supabase';
import { loadMembers } from '../lib/business-service';
import { useWorkspace } from '../providers/workspace-provider';
import { useAuth } from '../providers/auth-provider';
import { Button, Card, Field, Loading, Notice, Screen } from '../components/ui';
import { safeErrorMessage } from '../lib/errors';
import { ROLE_LABELS } from '../lib/validation';
import type { BusinessRole, Invitation } from '../types/database';

type Member = Awaited<ReturnType<typeof loadMembers>>[number];
export function MemberScreen({
  client,
  invitations,
  onCreate,
}: {
  client: OwnerBookClient;
  invitations: () => void;
  onCreate: () => void;
}) {
  const workspace = useWorkspace();
  const auth = useAuth();
  const business = workspace.active?.business;
  const owner = workspace.active?.membership.role === 'owner';
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState<Member | null>(null);
  const [role, setRole] = useState<BusinessRole>('staff');
  const [alias, setAlias] = useState('');
  const refresh = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      setMembers(await loadMembers(client, business.id));
    } catch (cause) {
      setError(safeErrorMessage(cause, 'Could not load members. Your access may have changed.'));
    } finally {
      setLoading(false);
    }
  }, [business, client]);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) return refresh();
      });
      return () => {
        cancelled = true;
      };
    }, [refresh]),
  );
  const mutate = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setChanging(null);
      setAlias('');
      await refresh();
      await workspace.refresh();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const rpc = async (
    fn: 'set_member_role' | 'remove_member' | 'leave_business' | 'set_member_display_name',
    args: Record<string, unknown>,
  ) => {
    // Each branch preserves the generated RPC argument contract.
    if (!business) throw new Error('Select a business first');
    const result =
      fn === 'set_member_role'
        ? await client.rpc(
            fn,
            args as { p_business_id: string; p_user_id: string; p_role: BusinessRole },
          )
        : fn === 'remove_member'
          ? await client.rpc(fn, args as { p_business_id: string; p_user_id: string })
          : fn === 'leave_business'
            ? await client.rpc(fn, { p_business_id: business.id })
            : await client.rpc(fn, {
                p_business_id: business.id,
                p_name: (args.p_name as string) || null,
              });
    if (result.error) throw result.error;
  };
  const confirm = (title: string, message: string, action: () => Promise<void>) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', style: 'destructive', onPress: () => void mutate(action) },
    ]);
  return (
    <Screen
      title="Team and permissions"
      subtitle="Permissions are enforced in PostgreSQL, not just hidden in the app. Only owners can change roles or remove members."
    >
      {!!error && <Notice error>{error}</Notice>}
      {loading ? (
        <Loading label="Loading team…" />
      ) : (
        members.map((member) => (
          <Card key={member.user_id}>
            <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '700' }}>
              {member.name}
              {member.user_id === auth.session?.user.id ? ' (you)' : ''}
            </Text>
            <Text>{ROLE_LABELS[member.role]}</Text>
            {owner && (
              <>
                <Button
                  title="Change role"
                  secondary
                  disabled={busy}
                  onPress={() => {
                    setChanging(member);
                    setRole(member.role);
                  }}
                />
                <Button
                  title="Remove member"
                  danger
                  disabled={busy || member.user_id === auth.session?.user.id}
                  onPress={() =>
                    confirm(
                      'Remove this member?',
                      'Their access ends immediately. Their historical records and audit history remain.',
                      () =>
                        rpc('remove_member', {
                          p_business_id: business!.id,
                          p_user_id: member.user_id,
                        }),
                    )
                  }
                />
              </>
            )}
          </Card>
        ))
      )}
      {changing && (
        <Card>
          <Text>Change role for {changing.name}</Text>
          {(Object.keys(ROLE_LABELS) as BusinessRole[]).map((item) => (
            <Button
              key={item}
              title={ROLE_LABELS[item]}
              secondary={item !== role}
              onPress={() => setRole(item)}
              disabled={busy}
            />
          ))}
          <Notice>
            Promoting to Owner grants full control. A business must retain at least one active
            owner.
          </Notice>
          <Button
            title="Confirm role change"
            busy={busy}
            onPress={() =>
              confirm('Change member role?', `Set ${changing.name} to ${ROLE_LABELS[role]}?`, () =>
                rpc('set_member_role', {
                  p_business_id: business!.id,
                  p_user_id: changing.user_id,
                  p_role: role,
                }),
              )
            }
          />
          <Button title="Cancel" secondary onPress={() => setChanging(null)} disabled={busy} />
        </Card>
      )}
      <Card>
        <Field
          label="My name in this business (blank uses profile)"
          value={alias}
          onChangeText={setAlias}
          maxLength={80}
        />
        <Button
          title="Save business display name"
          onPress={() => void mutate(() => rpc('set_member_display_name', { p_name: alias }))}
          busy={busy}
        />
      </Card>
      {workspace.canInvite && (
        <>
          <Button title="Invite member" onPress={onCreate} />
          <Button title="Manage invitations" secondary onPress={invitations} />
        </>
      )}
      <Button
        title="Refresh members"
        secondary
        onPress={() => void refresh()}
        disabled={busy || loading}
      />
      <Button
        title="Leave business"
        danger
        disabled={busy}
        onPress={() =>
          confirm(
            'Leave this business?',
            'You will lose access immediately. The last active owner cannot leave; transfer ownership first.',
            () => rpc('leave_business', {}),
          )
        }
      />
    </Screen>
  );
}
export function InvitationsScreen({ client }: { client: OwnerBookClient }) {
  const workspace = useWorkspace();
  const business = workspace.active?.business;
  const [rows, setRows] = useState<Invitation[]>([]);
  const [observedAt, setObservedAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!business) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: failure } = await client.rpc('list_invitations', {
        p_business_id: business.id,
      });
      if (failure) throw failure;
      setRows(data ?? []);
      setObservedAt(Date.now());
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [business, client]);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) return refresh();
      });
      return () => {
        cancelled = true;
      };
    }, [refresh]),
  );
  const revoke = (row: Invitation) =>
    Alert.alert('Revoke invitation?', 'This link will stop working immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Revoke',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            setBusy(true);
            setError(null);
            try {
              const { error: failure } = await client.rpc('revoke_invitation', {
                p_invitation_id: row.id,
              });
              if (failure) throw failure;
              await refresh();
            } catch (cause) {
              setError(safeErrorMessage(cause));
            } finally {
              setBusy(false);
            }
          })(),
      },
    ]);
  return (
    <Screen
      title="Invitations"
      subtitle="The latest 200 invitations. Raw tokens are never available here. Email-bound links are recommended."
    >
      {!!error && <Notice error>{error}</Notice>}
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Notice>No invitations yet.</Notice>
      ) : (
        rows.map((row) => (
          <Card key={row.id}>
            <Text>
              {ROLE_LABELS[row.role]} · {row.email ?? 'Anyone with the link'}
            </Text>
            <Text>
              {row.revoked_at
                ? 'Revoked'
                : row.accepted_at
                  ? 'Accepted'
                  : new Date(row.expires_at).getTime() <= observedAt
                    ? 'Expired'
                    : 'Pending'}
            </Text>
            <Text>Expires: {new Date(row.expires_at).toLocaleString()}</Text>
            {!row.revoked_at &&
              !row.accepted_at &&
              new Date(row.expires_at).getTime() > observedAt && (
                <Button title="Revoke" danger onPress={() => revoke(row)} disabled={busy} />
              )}
          </Card>
        ))
      )}
      <Button title="Refresh" secondary onPress={() => void refresh()} busy={loading} />
    </Screen>
  );
}
