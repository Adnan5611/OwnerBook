import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { EnvironmentResult } from '../config/environment';
import type { ConnectionState } from '../hooks/use-connection';

type Props = {
  environment: EnvironmentResult;
  reachable: boolean | null;
  connection: ConnectionState;
  onCheck: () => void;
};

const colors = {
  background: '#F3F6F4',
  ink: '#172E29',
  muted: '#586B64',
  green: '#17664E',
  border: '#DCE5DF',
  white: '#FFFFFF',
  amber: '#855514',
  red: '#A33332',
};

function SetupStep({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: string;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={styles.stepContent}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.body}>{children}</Text>
      </View>
    </View>
  );
}

export function FoundationScreen({ environment, reachable, connection, onCheck }: Props) {
  const { width, fontScale } = useWindowDimensions();
  const compact = width < 380 || fontScale > 1.3;
  const checking = connection.kind === 'checking';
  const result = connection.kind === 'checked' ? connection.result : null;
  const networkLabel = reachable === null ? 'Checking network' : reachable ? 'Online' : 'Offline';
  const status = !environment.ok
    ? 'Setup required'
    : checking
      ? 'Connecting'
      : result?.ok
        ? reachable === false
          ? 'Last check: connected'
          : 'Database connected'
        : result
          ? 'Connection needs attention'
          : 'Ready to connect';
  const statusColor = result?.ok
    ? colors.green
    : result || !environment.ok
      ? colors.amber
      : colors.muted;
  const disabled = !environment.ok || reachable === false || checking;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View style={[styles.header, compact && styles.headerCompact]}>
            <View style={styles.brand}>
              <View style={styles.logo}>
                <Text style={styles.logoText}>OB</Text>
              </View>
              <Text style={styles.wordmark}>OwnerBook</Text>
            </View>
            <View style={styles.networkPill}>
              <View
                style={[
                  styles.networkDot,
                  {
                    backgroundColor:
                      reachable === false ? colors.red : reachable ? colors.green : colors.amber,
                  },
                ]}
              />
              <Text style={styles.networkLabel}>{networkLabel}</Text>
            </View>
          </View>

          <Text style={styles.eyebrow}>ANDROID-FIRST · SETUP</Text>
          <Text style={styles.title}>Your business.{'\n'}In good order.</Text>
          <Text style={styles.subtitle}>
            A secure workspace for your books, stock, payroll and team. Connect your project to
            begin setting up OwnerBook.
          </Text>

          <View style={styles.card}>
            <View style={styles.cardHeading}>
              <Text style={styles.cardTitle}>Project connection</Text>
              <Text style={styles.phaseBadge}>Setup</Text>
            </View>
            <View style={styles.statusRow} accessibilityLiveRegion="polite">
              {checking ? (
                <ActivityIndicator color={colors.green} />
              ) : (
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              )}
              <Text style={[styles.status, { color: statusColor }]}>{status}</Text>
            </View>

            {!environment.ok ? (
              <>
                <Text style={styles.body}>
                  {environment.reason === 'missing'
                    ? 'Add your Supabase project URL and publishable key to the app environment, then restart Expo or rebuild.'
                    : 'The environment contains an invalid URL or key. Use an HTTPS project URL and a publishable key or legacy anon key. Never use a secret or service-role key.'}
                </Text>
                {environment.missing.map((name) => (
                  <View key={name} style={styles.codeBox}>
                    <Text selectable style={styles.code}>
                      {name}
                    </Text>
                  </View>
                ))}
              </>
            ) : (
              <Text style={styles.body}>
                {result?.ok
                  ? 'The app reached your PostgreSQL database and verified the OwnerBook schema. This is a live connection, not sample data.'
                  : result
                    ? result.message
                    : 'Run a live check against your Supabase database. No business records are read or created.'}
              </Text>
            )}

            {result?.ok && (
              <View style={styles.details}>
                <Text style={styles.detailLabel}>
                  Schema version {result.health.schema_version}
                </Text>
                <Text style={styles.detailText}>
                  Checked {new Date(result.checkedAt).toLocaleString()}
                </Text>
                <Text style={styles.detailText}>Database time (UTC)</Text>
                <Text selectable style={styles.codeSmall}>
                  {result.health.database_time}
                </Text>
              </View>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Check Supabase connection"
              accessibilityState={{ disabled, busy: checking }}
              disabled={disabled}
              onPress={onCheck}
              style={({ pressed }) => [
                styles.button,
                disabled && styles.buttonDisabled,
                pressed && !disabled && styles.buttonPressed,
              ]}
            >
              <Text style={[styles.buttonText, disabled && styles.buttonTextDisabled]}>
                {checking ? 'Checking connection…' : result ? 'Check again' : 'Check connection'}
              </Text>
            </Pressable>
            {reachable === false && (
              <Text style={styles.offlineNote}>
                You’re offline. The live check is unavailable; no data has been changed.
              </Text>
            )}
          </View>

          <View style={styles.setupSection}>
            <Text style={styles.sectionTitle}>Connect your workspace</Text>
            <SetupStep number="1" title="Create a Supabase project">
              Use your own project. No paid plan is required to start; free-plan limits and
              inactivity policies apply.
            </SetupStep>
            <SetupStep number="2" title="Apply the ordered migrations">
              Apply the version-controlled SQL using the Supabase CLI. See supabase/README.md in the
              source.
            </SetupStep>
            <SetupStep number="3" title="Add the public app configuration">
              Copy .env.example to .env, add the URL and publishable key, and restart Expo. Keep all
              secret keys off the device.
            </SetupStep>
          </View>

          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>Business setup — no demo finances</Text>
            <Text style={styles.body}>
              Once configured, sign in to manage your businesses and team. Sales, khata, inventory,
              payroll and chat will be enabled only as their database rules and tests are
              implemented.
            </Text>
          </View>
          <Text style={styles.footer}>
            Built for Android · Secure sessions · PostgreSQL source of truth
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, paddingVertical: 20, paddingHorizontal: 20 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 36,
  },
  headerCompact: { alignItems: 'flex-start', flexDirection: 'column', gap: 16 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: colors.white, fontSize: 16, fontWeight: '800', letterSpacing: -0.5 },
  wordmark: { color: colors.ink, fontSize: 22, fontWeight: '700', letterSpacing: -0.7 },
  networkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 20,
    backgroundColor: '#E6EDE8',
  },
  networkDot: { width: 6, height: 6, borderRadius: 3 },
  networkLabel: { fontSize: 12, color: colors.muted, fontWeight: '600' },
  eyebrow: {
    color: colors.green,
    fontWeight: '700',
    fontSize: 11,
    letterSpacing: 1.6,
    marginBottom: 12,
  },
  title: {
    fontSize: 40,
    lineHeight: 46,
    fontWeight: '700',
    letterSpacing: -1.7,
    color: colors.ink,
    marginBottom: 14,
  },
  subtitle: { color: colors.muted, fontSize: 16, lineHeight: 25, marginBottom: 26 },
  card: {
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeading: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: { fontSize: 18, fontWeight: '700', color: colors.ink },
  phaseBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.green,
    backgroundColor: '#EAF4EE',
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: 6,
    overflow: 'hidden',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
    marginBottom: 10,
    minHeight: 24,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  codeBox: { backgroundColor: colors.background, borderRadius: 8, padding: 12, marginTop: 10 },
  code: { fontFamily: 'monospace', fontSize: 11, color: colors.ink, flexWrap: 'wrap' },
  codeSmall: { fontFamily: 'monospace', fontSize: 12, color: colors.ink, marginTop: 3 },
  details: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14, marginTop: 16 },
  detailLabel: { color: colors.green, fontWeight: '700', fontSize: 13, marginBottom: 6 },
  detailText: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  button: {
    minHeight: 50,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 11,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 22,
  },
  buttonDisabled: { backgroundColor: '#E8EDE9' },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '700' },
  buttonTextDisabled: { color: '#718177' },
  offlineNote: { color: colors.amber, fontSize: 12, lineHeight: 19, marginTop: 12 },
  setupSection: { marginTop: 30 },
  sectionTitle: { color: colors.ink, fontSize: 19, fontWeight: '700', marginBottom: 20 },
  step: { flexDirection: 'row', gap: 14, marginBottom: 22 },
  stepNumber: {
    width: 30,
    height: 30,
    borderRadius: 10,
    backgroundColor: '#E2ECE5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: { color: colors.green, fontSize: 13, fontWeight: '700' },
  stepContent: { flex: 1 },
  stepTitle: { color: colors.ink, fontSize: 15, fontWeight: '600', marginBottom: 5 },
  notice: { backgroundColor: '#E8EEE9', padding: 18, borderRadius: 14, marginTop: 4 },
  noticeTitle: { color: colors.ink, fontWeight: '700', fontSize: 14, marginBottom: 7 },
  footer: {
    textAlign: 'center',
    color: colors.muted,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 26,
    marginBottom: 8,
  },
});
