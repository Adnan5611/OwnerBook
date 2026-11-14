import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Notice } from './ui';

type Flash = { notify: (message: string) => void };

const FlashContext = createContext<Flash>({ notify: () => undefined });

export function useFlash(): Flash {
  return useContext(FlashContext);
}

/**
 * A short confirmation that survives going back to the previous screen, used
 * after a financial record is saved. It reports what the server stored (amount
 * and new balance), never an optimistic guess, and it does not block touches.
 */
export function FlashProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const notify = useCallback((text: string) => setMessage(text), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 7000);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <FlashContext.Provider value={{ notify }}>
      {children}
      {message ? (
        <View pointerEvents="none" style={styles.flash} accessibilityRole="status">
          <Notice>{message}</Notice>
        </View>
      ) : null}
    </FlashContext.Provider>
  );
}

const styles = StyleSheet.create({
  flash: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 76,
    zIndex: 10,
  },
});
