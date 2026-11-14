import { fireEvent, render, screen } from '@testing-library/react-native';
import { FoundationScreen } from '../src/components/FoundationScreen';
import type { EnvironmentResult } from '../src/config/environment';
import type { ConnectionState } from '../src/hooks/use-connection';

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

const configured: EnvironmentResult = {
  ok: true,
  configuration: { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' },
  missing: [],
};
const missing: EnvironmentResult = {
  ok: false,
  configuration: null,
  reason: 'missing',
  missing: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY'],
};

async function setup(
  environment = configured,
  reachable: boolean | null = true,
  connection: ConnectionState = { kind: 'idle' },
) {
  const onCheck = jest.fn();
  await render(
    <FoundationScreen
      environment={environment}
      reachable={reachable}
      connection={connection}
      onCheck={onCheck}
    />,
  );
  return onCheck;
}

describe('Android foundation screen', () => {
  it('shows real setup requirements, disables probing, and does not show demo finances', async () => {
    await setup(missing);
    expect(screen.getByText('Setup required')).toBeTruthy();
    expect(screen.getByText('EXPO_PUBLIC_SUPABASE_URL')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Supabase connection' })).toBeDisabled();
    expect(screen.queryByText(/Net profit|Cash balance|Total sales/)).toBeNull();
  });

  it('provides an actionable invalid-key message without displaying the key', async () => {
    await setup({ ok: false, configuration: null, reason: 'invalid', missing: [] });
    expect(screen.getByText(/Never use a secret or service-role key/)).toBeTruthy();
    expect(screen.queryByText(/sb_publishable/)).toBeNull();
  });

  it('invokes the actual check handler when configured', async () => {
    const onCheck = await setup();
    await fireEvent.press(screen.getByRole('button', { name: 'Check Supabase connection' }));
    expect(onCheck).toHaveBeenCalledTimes(1);
  });

  it('clearly communicates offline status and disables the live check', async () => {
    await setup(configured, false);
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(screen.getByText(/no data has been changed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Supabase connection' })).toBeDisabled();
  });

  it('announces loading and prevents duplicate requests', async () => {
    await setup(configured, true, { kind: 'checking' });
    expect(screen.getByText('Connecting')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check Supabase connection' })).toBeDisabled();
  });

  it('renders verified schema and database timestamp, not sample accounting values', async () => {
    await setup(configured, true, {
      kind: 'checked',
      result: {
        ok: true,
        health: { service: 'ownerbook', schema_version: 3, database_time: '2026-11-01T12:00:00Z' },
        checkedAt: '2026-11-01T12:00:01Z',
      },
    });
    expect(screen.getByText('Database connected')).toBeTruthy();
    expect(screen.getByText('Schema version 3')).toBeTruthy();
    expect(screen.getByText('2026-11-01T12:00:00Z')).toBeTruthy();
  });

  it('renders a recoverable server error', async () => {
    await setup(configured, true, {
      kind: 'checked',
      result: { ok: false, code: 'MISSING_SCHEMA', message: 'Apply the OwnerBook migration.' },
    });
    expect(screen.getByText('Connection needs attention')).toBeTruthy();
    expect(screen.getByText('Apply the OwnerBook migration.')).toBeTruthy();
    expect(screen.getByText('Check again')).toBeEnabled();
  });
});
