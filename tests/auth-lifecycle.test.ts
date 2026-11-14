import { AppState, type AppStateStatus } from 'react-native';
import { observeAuthLifecycle } from '../src/lib/supabase';

describe('mobile auth session lifecycle', () => {
  it('starts refresh when active, pauses in background, and removes its listener', () => {
    const auth = {
      startAutoRefresh: jest.fn().mockResolvedValue(undefined),
      stopAutoRefresh: jest.fn().mockResolvedValue(undefined),
    };
    const remove = jest.fn();
    let listener: ((state: AppStateStatus) => void) | undefined;
    const add = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
      listener = callback;
      return { remove };
    });
    const previousState = AppState.currentState;
    AppState.currentState = 'active';
    try {
      const dispose = observeAuthLifecycle(auth);
      expect(auth.startAutoRefresh).toHaveBeenCalledTimes(1);
      listener?.('background');
      expect(auth.stopAutoRefresh).toHaveBeenCalledTimes(1);
      listener?.('active');
      expect(auth.startAutoRefresh).toHaveBeenCalledTimes(2);
      dispose();
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
      AppState.currentState = previousState;
    }
  });
});
