import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { AuthScreen } from '../src/screens/auth-screen';
import type { OwnerBookClient } from '../src/lib/supabase';

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);
const mockAuthState = {
  session: null as { user: { id: string } } | null,
  recovery: false,
  error: null as string | null,
  clearError: jest.fn(),
  finishRecovery: jest.fn(),
  signOut: jest.fn(async () => undefined),
};
const mockService = {
  signIn: jest.fn(),
  register: jest.fn(),
  requestRecovery: jest.fn(),
  completeRecovery: jest.fn(),
};
jest.mock('../src/providers/auth-provider', () => ({ useAuth: () => mockAuthState }));
jest.mock('../src/lib/auth-service', () => ({
  signIn: (...args: unknown[]) => mockService.signIn(...args),
  register: (...args: unknown[]) => mockService.register(...args),
  requestRecovery: (...args: unknown[]) => mockService.requestRecovery(...args),
  completeRecovery: (...args: unknown[]) => mockService.completeRecovery(...args),
}));
const client = {} as OwnerBookClient;
describe('native authentication UI', () => {
  beforeEach(() => {
    mockAuthState.session = null;
    mockAuthState.recovery = false;
    mockAuthState.error = null;
    Object.values(mockService).forEach((fn) => fn.mockResolvedValue(undefined));
  });
  it('renders credentials without fabricated login success', async () => {
    await render(<AuthScreen client={client} />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'my passphrase');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(mockService.signIn).toHaveBeenCalledWith(client, 'a@b.com', 'my passphrase'),
    );
  });
  it('offers registration, confirmation and recovery flows', async () => {
    await render(<AuthScreen client={client} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Create an account' }));
    expect(screen.getByLabelText('Confirm password')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Forgot password?' }));
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send recovery link' }));
    await waitFor(() => expect(screen.getByText(/If that account exists/)).toBeTruthy());
  });
  it('renders safe error messages and permits retry', async () => {
    mockService.signIn.mockRejectedValue({ code: 'invalid_credentials' });
    await render(<AuthScreen client={client} />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'a@b.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'wrong pass');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByText('Email or password is incorrect.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Sign in' }).props.accessibilityState.disabled).toBe(
      false,
    );
  });
  it('offers an explicit recovery escape without changing the password', async () => {
    mockAuthState.session = { user: { id: 'user' } };
    mockAuthState.recovery = true;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<AuthScreen client={client} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out of recovery' }));
    const local = alert.mock.calls[0]![2]!.find((button) => button.text === 'This device only')!;
    await act(async () => {
      local.onPress?.();
    });
    expect(mockAuthState.signOut).toHaveBeenCalledWith('local');
    expect(mockService.completeRecovery).not.toHaveBeenCalled();
    alert.mockRestore();
  });
  it('gates recovery and completes password reset', async () => {
    mockAuthState.session = { user: { id: 'user' } };
    mockAuthState.recovery = true;
    await render(<AuthScreen client={client} />);
    expect(screen.queryByLabelText('Email')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('New password'), 'new passphrase');
    await fireEvent.changeText(screen.getByLabelText('Confirm password'), 'new passphrase');
    await fireEvent.press(screen.getByRole('button', { name: 'Update password and sign out' }));
    await waitFor(() => expect(mockService.completeRecovery).toHaveBeenCalled());
    expect(mockAuthState.finishRecovery).toHaveBeenCalled();
  });
});
