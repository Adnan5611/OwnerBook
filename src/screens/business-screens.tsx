import { useState } from 'react';
import { Alert, Text } from 'react-native';
import * as Linking from 'expo-linking';
import { Button, Card, Field, KeyValue, Loading, Notice, Screen, colors } from '../components/ui';
import { useWorkspace } from '../providers/workspace-provider';
import type { OwnerBookClient } from '../lib/supabase';
import {
  acceptInvitation,
  createBusiness,
  createInvitation,
  previewInvitation,
  saveBusinessSettings,
} from '../lib/business-service';
import { safeErrorMessage } from '../lib/errors';
import { ASSIGNABLE_ROLES, ROLE_LABELS } from '../lib/validation';
import type { BusinessRole, CreatedInvitation, InvitationPreview } from '../types/database';

function deviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
export function BusinessForm({
  client,
  settings,
  onDone,
}: {
  client: OwnerBookClient;
  settings?: boolean;
  onDone: () => void;
}) {
  const workspace = useWorkspace();
  const current = workspace.active?.business;
  const [name, setName] = useState(current?.name ?? '');
  const [currency, setCurrency] = useState(current?.currency ?? 'PKR');
  const [timezone, setTimezone] = useState(current?.timezone ?? deviceTimezone());
  const [delegate, setDelegate] = useState(current?.co_owners_can_invite ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (settings && current) {
        await saveBusinessSettings(client, { ...current, name, currency, timezone }, delegate);
        await workspace.refresh();
      } else {
        const id = await createBusiness(client, name, currency, timezone);
        const updated = await workspace.refresh();
        await workspace.select(id, updated);
      }
      onDone();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      title={settings ? 'Business settings' : 'Create a business'}
      subtitle="Your business is a separate, protected workspace. Only members you invite can access it."
    >
      <Card>
        <Field
          label="Business name"
          value={name}
          onChangeText={setName}
          maxLength={120}
          autoCapitalize="words"
        />
        <Field
          label="IANA timezone"
          value={timezone}
          onChangeText={setTimezone}
          maxLength={100}
          placeholder="Asia/Karachi"
        />
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Use an IANA name such as Asia/Karachi or UTC. Database timestamps remain UTC.
        </Text>
        <Text style={{ color: colors.ink, fontWeight: '700' }}>Currency</Text>
        {workspace.currencies.map((item) => (
          <Button
            key={item.code}
            secondary={currency !== item.code}
            title={`${item.code} — ${item.name}`}
            disabled={busy}
            onPress={() => setCurrency(item.code)}
          />
        ))}
        {settings && (
          <Button
            secondary
            title={`Co-owner invitations: ${delegate ? 'allowed' : 'disabled'}`}
            onPress={() => setDelegate(!delegate)}
            disabled={busy}
          />
        )}
        <Notice>
          Currency can be chosen before financial operations begin. Phase 3 will lock it once
          transactions exist; existing amounts will never be silently converted.
        </Notice>
        {!!error && <Notice error>{error}</Notice>}
        <Button
          title={settings ? 'Save settings' : 'Create business'}
          onPress={() => void submit()}
          busy={busy}
        />
        <Button secondary title="Cancel" onPress={onDone} disabled={busy} />
      </Card>
    </Screen>
  );
}
export function BusinessPicker({
  onCreate,
  onJoin,
  onOpen,
}: {
  onCreate: () => void;
  onJoin: () => void;
  onOpen?: () => void;
}) {
  const workspace = useWorkspace();
  return (
    <Screen
      title={workspace.memberships.length ? 'Your businesses' : 'Start your workspace'}
      subtitle="Create a business or accept an invitation. Each business keeps its own members and records."
    >
      {workspace.loading && <Loading label="Loading memberships…" />}
      {!!workspace.error && <Notice error>{workspace.error}</Notice>}
      {!workspace.loading &&
        workspace.memberships.map((item) => (
          <Card key={item.business.id}>
            <Text
              accessibilityRole="header"
              style={{ fontSize: 20, fontWeight: '700', color: colors.ink }}
            >
              {item.business.name}
            </Text>
            <Text style={{ color: colors.muted }}>
              {ROLE_LABELS[item.membership.role]} · {item.business.currency}
              {item.business.archived_at ? ' · Archived' : ''}
            </Text>
            <Button
              title="Open business"
              onPress={() => {
                void workspace.select(item.business.id).then(() => onOpen?.());
              }}
            />
          </Card>
        ))}
      <Button title="Create business" onPress={onCreate} />
      <Button title="Join with invitation" secondary onPress={onJoin} />
      <Button
        title="Refresh"
        secondary
        onPress={() => void workspace.refresh()}
        busy={workspace.loading}
      />
    </Screen>
  );
}
export function InvitationScreen({
  client,
  initialToken,
  onJoined,
}: {
  client: OwnerBookClient;
  initialToken?: string;
  onJoined?: () => void;
}) {
  const workspace = useWorkspace();
  const [input, setInput] = useState(initialToken ?? '');
  const [result, setResult] = useState<{ preview: InvitationPreview; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await previewInvitation(client, input));
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const accept = async () => {
    if (!result || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await acceptInvitation(client, result.token);
      const updated = await workspace.refresh();
      await workspace.select(id, updated);
      setInput('');
      setResult(null);
      onJoined?.();
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      title="Join a business"
      subtitle="Sign in with the invited email, then paste the invitation link or code. A code is single-use and expires. Never share it publicly."
    >
      <Card>
        <Field
          label="Invitation link or code"
          value={input}
          onChangeText={(value) => {
            setInput(value);
            setResult(null);
          }}
          multiline
          maxLength={4096}
        />
        {!!error && <Notice error>{error}</Notice>}
        <Button title="Check invitation" onPress={() => void preview()} busy={busy} />
        {result && (
          <>
            <KeyValue label="Business" value={result.preview.business_name} />
            <KeyValue label="Your role" value={ROLE_LABELS[result.preview.role]} />
            <KeyValue label="Expires (UTC)" value={result.preview.expires_at} />
            <Button title="Accept and join" onPress={() => void accept()} busy={busy} />
          </>
        )}
      </Card>
    </Screen>
  );
}
export function CreateInvitationScreen({ client }: { client: OwnerBookClient }) {
  const workspace = useWorkspace();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BusinessRole>('staff');
  const [hours, setHours] = useState(168);
  const [created, setCreated] = useState<
    (CreatedInvitation & { email: string; role: BusinessRole; businessName: string }) | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!workspace.active || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const invitation = await createInvitation(
        client,
        workspace.active.business.id,
        role,
        email,
        hours,
      );
      // Freeze the sharing metadata with the token. Editing the form afterwards
      // must not mislabel an already-issued role/email-bound credential.
      setCreated({
        ...invitation,
        email: email.trim(),
        role,
        businessName: workspace.active.business.name,
      });
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!workspace.canInvite)
    return (
      <Screen title="Invitations">
        <Notice error>Your current role cannot create invitations.</Notice>
      </Screen>
    );
  return (
    <Screen
      title="Invite a team member"
      subtitle="Only share the generated link with the intended person. Email delivery is not automated; use the Android share sheet."
    >
      <Card>
        <Field
          label="Invitee email (optional but recommended)"
          value={email}
          onChangeText={setEmail}
          editable={!created && !busy}
          keyboardType="email-address"
          maxLength={254}
        />
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Binding an email prevents another account from using the link. A blank email creates a
          bearer invitation: anyone signed in with the link can join.
        </Text>
        <Text style={{ color: colors.ink, fontWeight: '700' }}>Role</Text>
        {ASSIGNABLE_ROLES.map((item) => (
          <Button
            key={item}
            title={ROLE_LABELS[item]}
            secondary={role !== item}
            onPress={() => setRole(item)}
            disabled={busy || !!created}
          />
        ))}
        <Field
          label="Expires after (hours, 1–720)"
          value={String(hours)}
          onChangeText={(value) => setHours(Number(value))}
          editable={!created && !busy}
          keyboardType="number-pad"
          maxLength={3}
        />
        {!!error && <Notice error>{error}</Notice>}
        <Button
          title="Generate secure invitation"
          onPress={() => void submit()}
          busy={busy}
          disabled={!!created}
        />
        {created && (
          <>
            <Notice>
              This link is shown only now. It is not stored in preferences or audit logs. It can be
              revoked from the invitations list.
            </Notice>
            <Text selectable style={{ color: colors.ink }}>
              {Linking.createURL(`invite?token=${created.token}`)}
            </Text>
            <Button
              title="Share invitation"
              onPress={() => {
                void Linking.openURL(
                  `mailto:${encodeURIComponent(created.email)}?subject=${encodeURIComponent('Your OwnerBook invitation')}&body=${encodeURIComponent(`Join ${created.businessName} as ${ROLE_LABELS[created.role]}:\n${Linking.createURL(`invite?token=${created.token}`)}\nExpires: ${created.expires_at}`)}`,
                ).catch(() =>
                  setError('No email app is available. Select and copy the invitation link above.'),
                );
              }}
            />
            <Button
              secondary
              title="Done — clear link"
              onPress={() => {
                setCreated(null);
                setEmail('');
              }}
            />
          </>
        )}
      </Card>
    </Screen>
  );
}
export function ArchiveBusiness({ client }: { client: OwnerBookClient }) {
  const workspace = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const business = workspace.active?.business;
  const submit = () => {
    if (!business) return;
    Alert.alert(
      business.archived_at ? 'Restore business?' : 'Archive business?',
      'Archived businesses remain visible for history. Invitations cannot be created or accepted while archived. No records are deleted.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: business.archived_at ? 'Restore' : 'Archive',
          style: business.archived_at ? 'default' : 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await client
                  .rpc('archive_business', {
                    p_business_id: business.id,
                    p_archived: !business.archived_at,
                  })
                  .then(({ error: failure }) => {
                    if (failure) throw failure;
                  });
                await workspace.refresh();
              } catch (cause) {
                setError(safeErrorMessage(cause));
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };
  return (
    <Card>
      <Text style={{ color: colors.muted }}>
        Archiving is reversible and retains the audit trail.
      </Text>
      {!!error && <Notice error>{error}</Notice>}
      <Button
        title={business?.archived_at ? 'Restore business' : 'Archive business'}
        secondary
        onPress={submit}
        busy={busy}
      />
    </Card>
  );
}
