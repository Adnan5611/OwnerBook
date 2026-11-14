import { Text, View, StyleSheet } from 'react-native';
import { useNetwork } from '../hooks/use-network';

/**
 * Shown on every financial screen. Being offline must be visible and must never
 * pretend a record was saved. Phase 3 is online-only: reads and writes need the
 * server, and the queued offline outbox arrives in Phase 7.
 */
export function OfflineBanner() {
  const { connected } = useNetwork();
  if (connected !== false) return null;
  return (
    <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Text style={styles.title}>Offline</Text>
      <Text style={styles.message}>
        OwnerBook needs a connection to read and save financial records. Nothing was changed on this
        device while offline, and nothing is queued silently.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    gap: 3,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#F0C9A8',
    backgroundColor: '#FDF3E8',
  },
  title: { fontSize: 14, fontWeight: '700', color: '#8A5A1E' },
  message: { fontSize: 12, lineHeight: 17, color: '#8A5A1E' },
});
