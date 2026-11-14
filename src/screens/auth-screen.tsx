import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button, Card, Field, Notice, Screen, colors } from '../components/ui';
import { useAuth } from '../providers/auth-provider';
import type { OwnerBookClient } from '../lib/supabase';
import { completeRecovery, register, requestRecovery, signIn } from '../lib/auth-service';
import { safeErrorMessage } from '../lib/errors';

export function AuthScreen({ client }: { client: OwnerBookClient }) {
  const auth = useAuth();
  const [mode, setMode] = useState<'signin' | 'register' | 'recover'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recovery = auth.session && auth.recovery;
  const switchMode = (next: typeof mode) => {
    setMode(next);
    setPassword('');
    setConfirmation('');
    setError(null);
    setMessage(null);
    auth.clearError();
  };
  const exitRecovery = async (scope: 'global' | 'local') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signOut(scope);
      setPassword('');
      setConfirmation('');
    } catch {
      setError(
        'Could not revoke all sessions. Check your connection or remove this device’s session.',
      );
    } finally {
      setBusy(false);
    }
  };
  const confirmExitRecovery = () =>
    Alert.alert(
      'Leave password recovery?',
      'Your password will not be changed. All devices revokes the recovery session; this device only removes its local session.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'This device only', onPress: () => void exitRecovery('local') },
        { text: 'All devices', style: 'destructive', onPress: () => void exitRecovery('global') },
      ],
    );
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    auth.clearError();
    try {
      if (recovery) {
        await completeRecovery(client, password, confirmation);
        setPassword('');
        setConfirmation('');
        auth.finishRecovery();
        setMessage(
          'Password updated and recovery session revoked. Sign in with your new password.',
        );
      } else if (mode === 'signin') {
        await signIn(client, email, password);
        setPassword('');
      } else if (mode === 'register') {
        await register(client, email, password, confirmation, name);
        setPassword('');
        setConfirmation('');
        setMessage(
          'If this email can be registered, a confirmation link will arrive. Confirm your email, then sign in. Check spam as well.',
        );
      } else {
        await requestRecovery(client, email);
        setMessage(
          'If that account exists, a recovery link will arrive. Open it on this device. The link expires and can be used once.',
        );
      }
    } catch (cause) {
      setError(safeErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen
      title={recovery ? 'Set a new password' : 'OwnerBook'}
      subtitle={
        recovery
          ? 'Your recovery link opened a temporary session. Update your password to finish; all sessions will then be signed out.'
          : 'Your business. In good order. Secure accounts and persistent business records for your team.'
      }
    >
      {!!auth.error && <Notice>{auth.error}</Notice>}
      {!!message && <Notice>{message}</Notice>}
      <Card>
        {!recovery && (
          <Text style={{ color: colors.ink, fontSize: 21, fontWeight: '700' }}>
            {mode === 'signin'
              ? 'Sign in'
              : mode === 'register'
                ? 'Create account'
                : 'Recover account'}
          </Text>
        )}
        {!recovery && (
          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
          />
        )}
        {!recovery && mode === 'register' && (
          <Field
            label="Display name"
            value={name}
            onChangeText={setName}
            autoComplete="name"
            maxLength={80}
          />
        )}
        {(recovery || mode !== 'recover') && (
          <Field
            label={recovery ? 'New password' : 'Password'}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={recovery || mode === 'register' ? 'new-password' : 'current-password'}
            maxLength={72}
          />
        )}
        {(recovery || mode === 'register') && (
          <>
            <Field
              label="Confirm password"
              value={confirmation}
              onChangeText={setConfirmation}
              secureTextEntry
              autoComplete="new-password"
              maxLength={72}
            />
            <Text style={{ color: colors.muted, fontSize: 13 }}>
              At least 10 characters; no more than 72 UTF-8 bytes. A long, unique passphrase is
              recommended.
            </Text>
          </>
        )}
        {!!error && <Notice error>{error}</Notice>}
        <Button
          title={
            recovery
              ? 'Update password and sign out'
              : mode === 'signin'
                ? 'Sign in'
                : mode === 'register'
                  ? 'Create account'
                  : 'Send recovery link'
          }
          busy={busy}
          onPress={() => void submit()}
        />
        {recovery && (
          <Button
            secondary
            title="Sign out of recovery"
            disabled={busy}
            onPress={confirmExitRecovery}
          />
        )}
        {!recovery && (
          <>
            <Button
              secondary
              title={mode === 'signin' ? 'Create an account' : 'Back to sign in'}
              disabled={busy}
              onPress={() => switchMode(mode === 'signin' ? 'register' : 'signin')}
            />
            {mode !== 'recover' && (
              <Button
                secondary
                title="Forgot password?"
                disabled={busy}
                onPress={() => switchMode('recover')}
              />
            )}
          </>
        )}
      </Card>
      <Notice>
        Authentication and business changes require a connection. No offline financial queue is
        enabled yet. Never share your password or recovery link.
      </Notice>
    </Screen>
  );
}
