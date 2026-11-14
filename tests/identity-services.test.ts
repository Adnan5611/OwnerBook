import {
  register,
  requestRecovery,
  completeRecovery,
  consumeAuthLink,
  signIn,
} from '../src/lib/auth-service';
import {
  acceptInvitation,
  createBusiness,
  createInvitation,
  loadWorkspace,
  previewInvitation,
  saveProfile,
} from '../src/lib/business-service';
import type { OwnerBookClient } from '../src/lib/supabase';
jest.mock('expo-linking', () => ({ createURL: (path: string) => `ownerbook://${path}` }));

describe('authentication service', () => {
  const auth = {
    signInWithPassword: jest.fn(),
    signUp: jest.fn(),
    resetPasswordForEmail: jest.fn(),
    updateUser: jest.fn(),
    signOut: jest.fn(),
    exchangeCodeForSession: jest.fn(),
    verifyOtp: jest.fn(),
    setSession: jest.fn(),
  };
  const client = { auth } as unknown as OwnerBookClient;
  beforeEach(() => {
    Object.values(auth).forEach((fn) => fn.mockResolvedValue({ data: {}, error: null }));
  });
  it('signs in using normalized email and does not alter password whitespace', async () => {
    await signIn(client, ' A@B.COM ', ' password ');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: ' password ',
    });
  });
  it('rejects invalid registration before calling the network', async () => {
    await expect(
      register(client, 'bad', 'long passphrase', 'long passphrase', 'Ali'),
    ).rejects.toMatchObject({ code: 'OWNERBOOK_VALIDATION' });
    await expect(register(client, 'a@b.com', 'short', 'short', 'Ali')).rejects.toBeTruthy();
    expect(auth.signUp).not.toHaveBeenCalled();
  });
  it('sets a native confirmation redirect and profile metadata', async () => {
    await register(client, 'a@b.com', 'long passphrase', 'long passphrase', ' Ali ');
    expect(auth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: {
          data: { display_name: 'Ali' },
          emailRedirectTo: 'ownerbook://auth/confirmation',
        },
      }),
    );
  });
  it('uses an exact recovery redirect', async () => {
    await requestRecovery(client, 'a@b.com');
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.com', {
      redirectTo: 'ownerbook://auth/recovery',
    });
  });
  it('revokes recovery sessions after updating password', async () => {
    await completeRecovery(client, 'new passphrase', 'new passphrase');
    expect(auth.updateUser).toHaveBeenCalledWith({ password: 'new passphrase' });
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' });
  });
  it('does not sign out if password update failed', async () => {
    auth.updateUser.mockResolvedValue({ error: { code: 'weak_password' } });
    await expect(completeRecovery(client, 'new passphrase', 'new passphrase')).rejects.toBeTruthy();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it('exchanges PKCE codes only for app callbacks', async () => {
    expect(await consumeAuthLink(client, 'https://evil.test/auth/recovery?code=bad')).toBeNull();
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(await consumeAuthLink(client, 'ownerbook://auth/recovery?code=good')).toBe('recovery');
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('good');
  });
  it('surfaces auth errors without creating a success state', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { code: 'invalid_credentials' } });
    await expect(signIn(client, 'a@b.com', 'password')).rejects.toBeTruthy();
  });
});
describe('business and invitation service', () => {
  const rpc = jest.fn();
  const single = jest.fn();
  const eq = jest.fn();
  const select = jest.fn();
  const update = jest.fn();
  const from = jest.fn();
  const client = { rpc, from } as unknown as OwnerBookClient;
  beforeEach(() => {
    rpc.mockResolvedValue({ data: null, error: null });
    single.mockResolvedValue({ data: { id: 'user' }, error: null });
    eq.mockReturnValue({ single });
    select.mockReturnValue({ eq });
    update.mockReturnValue({ select });
    from.mockReturnValue({ update });
  });
  it('validates business name before RPC', async () => {
    await expect(createBusiness(client, ' ', 'PKR', 'UTC')).rejects.toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('calls owner-protected database creation RPC with normalized fields', async () => {
    await createBusiness(client, ' Ali Stores ', 'PKR', 'Asia/Karachi');
    expect(rpc).toHaveBeenCalledWith('create_business', {
      p_name: 'Ali Stores',
      p_currency: 'PKR',
      p_timezone: 'Asia/Karachi',
    });
  });
  it('refuses to issue ownership invitations', async () => {
    await expect(createInvitation(client, 'biz', 'owner', '', 24)).rejects.toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('normalizes optional invite email', async () => {
    rpc.mockResolvedValue({ data: { token: 'a'.repeat(64) }, error: null });
    await createInvitation(client, 'biz', 'staff', ' A@B.COM ', 24);
    expect(rpc).toHaveBeenCalledWith('create_invitation', {
      p_business_id: 'biz',
      p_role: 'staff',
      p_email: 'a@b.com',
      p_expires_hours: 24,
    });
  });
  it('rejects malformed server-generated invitation tokens', async () => {
    rpc.mockResolvedValue({ data: { token: 'bad' }, error: null });
    await expect(createInvitation(client, 'biz', 'staff', '', 24)).rejects.toMatchObject({
      code: 'OWNERBOOK_VALIDATION',
    });
  });
  it('never sends a full invite URL to the preview/accept RPC', async () => {
    const token = 'a'.repeat(64);
    rpc.mockResolvedValue({ data: { business_id: 'biz' }, error: null });
    await previewInvitation(client, `ownerbook://invite?token=${token}`);
    expect(rpc).toHaveBeenLastCalledWith('preview_invitation', { p_token: token });
    await acceptInvitation(client, token);
    expect(rpc).toHaveBeenLastCalledWith('accept_invitation', { p_token: token });
  });
  it('requires a changed row when saving profile (RLS must not silently succeed)', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    await expect(saveProfile(client, 'user', 'Ali')).rejects.toBeTruthy();
    expect(update).toHaveBeenCalledWith({ display_name: 'Ali' });
  });
  it('propagates workspace failures instead of returning fake records', async () => {
    const failure = { data: null, error: { code: 'network' } };
    const query = {
      select: jest.fn(),
      order: jest.fn(),
      eq: jest.fn(),
      is: jest.fn(),
      single: jest.fn(),
    };
    query.select.mockReturnValue(query);
    query.order.mockResolvedValue(failure);
    query.eq.mockReturnValue(query);
    query.is.mockResolvedValue(failure);
    query.single.mockResolvedValue(failure);
    from.mockReturnValue(query);
    await expect(loadWorkspace(client, 'user')).rejects.toBeTruthy();
  });
});
