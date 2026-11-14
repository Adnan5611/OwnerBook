import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Never render exception messages: native storage/network errors may contain sensitive details. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Intentionally do not send financial data, session data or exception payloads to a logger.
  }

  override render() {
    if (this.state.failed) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Let’s try that again</Text>
          <Text style={styles.body}>
            OwnerBook couldn’t open this screen. Your database records and pending operations have
            not been deleted by this error.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => this.setState({ failed: false })}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 28, backgroundColor: '#F3F6F4' },
  title: { fontSize: 26, fontWeight: '700', color: '#172E29', marginBottom: 12 },
  body: { fontSize: 16, lineHeight: 25, color: '#586B64' },
  button: {
    marginTop: 24,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#17664E',
    alignItems: 'center',
  },
  pressed: { opacity: 0.8 },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
});
