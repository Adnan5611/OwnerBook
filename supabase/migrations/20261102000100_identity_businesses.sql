-- OwnerBook Phase 2: identity, tenancy, invitations and database-enforced roles.
-- Apply after the foundation migration. No financial tables or demo records.
begin;

create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to authenticated;
grant usage on schema private to authenticated;

create type public.business_role as enum ('owner', 'co_owner', 'manager', 'accountant', 'staff');

create table public.currencies (
  code text primary key check (code ~ '^[A-Z]{3}$'),
  name text not null,
  minor_units smallint not null check (minor_units in (0, 2, 3))
);
insert into public.currencies (code, name, minor_units) values
  ('PKR', 'Pakistani rupee', 2), ('USD', 'US dollar', 2),
  ('EUR', 'Euro', 2), ('GBP', 'Pound sterling', 2),
  ('AED', 'UAE dirham', 2), ('SAR', 'Saudi riyal', 2),
  ('INR', 'Indian rupee', 2), ('BDT', 'Bangladeshi taka', 2),
  ('CAD', 'Canadian dollar', 2), ('AUD', 'Australian dollar', 2),
  ('JPY', 'Japanese yen', 0), ('KWD', 'Kuwaiti dinar', 3);
alter table public.currencies enable row level security;
create policy currencies_read on public.currencies for select to authenticated using (true);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  currency text not null references public.currencies(code),
  timezone text not null check (char_length(timezone) between 1 and 100),
  co_owners_can_invite boolean not null default false,
  created_by uuid not null references public.profiles(id) on delete restrict,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  role public.business_role not null,
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 80),
  invited_by uuid references public.profiles(id) on delete restrict,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index business_members_user_idx on public.business_members(user_id, removed_at);
create index business_members_active_role_idx on public.business_members(business_id, role) where removed_at is null;

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  role public.business_role not null check (role <> 'owner'),
  email text check (email is null or (char_length(email) <= 254 and email = lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  invited_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (accepted_at is null or revoked_at is null),
  check (accepted_at is null or accepted_by is not null),
  check (accepted_by is null or accepted_at is not null)
);
create index invitations_business_idx on public.invitations(business_id, created_at desc);
create index invitations_pending_idx on public.invitations(business_id, expires_at) where accepted_at is null and revoked_at is null;

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text not null check (char_length(entity_type) between 1 and 60),
  entity_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_business_time_idx on public.audit_logs(business_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs(business_id, entity_type, entity_id);

-- Helpers are DEFINER only to avoid recursive RLS on membership/profile reads.
-- They return booleans, pin search_path, and are not granted to anon/public.
create function private.is_member(p_business_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid() and removed_at is null
  );
$$;
create function private.has_role(p_business_id uuid, p_roles public.business_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members
    where business_id = p_business_id and user_id = auth.uid()
      and removed_at is null and role = any(p_roles)
  );
$$;
create function private.shares_business(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = auth.uid() or exists (
    select 1 from public.business_members mine
    join public.business_members theirs on theirs.business_id = mine.business_id
    where mine.user_id = auth.uid() and mine.removed_at is null
      and theirs.user_id = p_user_id and theirs.removed_at is null
  );
$$;
revoke all on function private.is_member(uuid) from public, anon;
revoke all on function private.has_role(uuid, public.business_role[]) from public, anon;
revoke all on function private.shares_business(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, public.business_role[]) to authenticated;
grant execute on function private.shares_business(uuid) to authenticated;

create function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger businesses_touch before update on public.businesses for each row execute function private.touch_updated_at();
create trigger members_touch before update on public.business_members for each row execute function private.touch_updated_at();

create function private.prevent_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Audit records are immutable' using errcode = '42501';
end;
$$;
create trigger audit_immutable before update or delete on public.audit_logs
for each row execute function private.prevent_audit_mutation();

create function private.add_audit(p_business_id uuid, p_action text, p_entity_type text, p_entity_id uuid, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs(business_id, actor_id, action, entity_type, entity_id, details)
  values (p_business_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_details);
$$;
revoke all on function private.add_audit(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- Deferred: ownership can be transferred/demoted in one transaction, but NEVER
-- can a transaction commit a business without an active owner.
create function private.require_active_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid;
begin
  v_business_id := coalesce(new.business_id, old.business_id);
  if not exists (
    select 1 from public.business_members
    where business_id = v_business_id and role = 'owner' and removed_at is null
  ) then
    raise exception 'A business must retain an active owner' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger member_owner_required
after insert or update or delete on public.business_members
deferrable initially deferred for each row execute function private.require_active_owner();
revoke all on function private.require_active_owner() from public, anon, authenticated;

-- Validate IANA timezone names against PostgreSQL's authoritative zone catalog.
create function private.validate_timezone(p_timezone text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone);
$$;
revoke all on function private.validate_timezone(text) from public, anon, authenticated;

create function private.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name)
  values (new.id, coalesce(nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 80), ''), 'Member'));
  return new;
end;
$$;
revoke all on function private.on_auth_user_created() from public, anon, authenticated;
create trigger ownerbook_create_profile after insert on auth.users
for each row execute function private.on_auth_user_created();
insert into public.profiles(id, display_name)
select id, coalesce(nullif(left(btrim(raw_user_meta_data ->> 'display_name'), 80), ''), 'Member')
from auth.users on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_read on public.profiles for select to authenticated
using (private.shares_business(id));
create policy profiles_update_own on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());
create policy businesses_read on public.businesses for select to authenticated
using (private.is_member(id));
-- Removed members retain only their OWN membership row, not the tenant directory.
create policy members_read on public.business_members for select to authenticated
using (user_id = auth.uid() or private.is_member(business_id));
create policy audit_owner_read on public.audit_logs for select to authenticated
using (private.has_role(business_id, array['owner','co_owner']::public.business_role[]));
-- Invitations have NO client policy. Token hashes and invitee emails are accessible
-- only through the narrow RPCs below. No direct financial/membership writes.

revoke all on public.profiles, public.businesses, public.business_members, public.invitations, public.audit_logs, public.currencies from anon, authenticated;
grant select on public.currencies to authenticated;
grant select on public.profiles, public.businesses, public.business_members to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.audit_logs to authenticated;

-- All SECURITY DEFINER RPCs below have a fixed empty search path, authenticate
-- auth.uid(), validate business/role ownership, and are granted only to authenticated.
create function public.create_business(p_name text, p_currency text default 'PKR', p_timezone text default 'UTC')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_id uuid; v_name text := btrim(p_name);
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if v_name is null or char_length(v_name) not between 1 and 120 then
    raise exception 'Business name must be 1–120 characters' using errcode = '22023';
  end if;
  if not private.validate_timezone(p_timezone) then raise exception 'Invalid timezone' using errcode = '22023'; end if;
  if not exists (select 1 from public.currencies where code = p_currency) then
    raise exception 'Unsupported currency' using errcode = '22023';
  end if;
  insert into public.businesses(name, currency, timezone, created_by)
    values (v_name, p_currency, p_timezone, v_actor) returning id into v_id;
  insert into public.business_members(business_id, user_id, role) values (v_id, v_actor, 'owner');
  perform private.add_audit(v_id, 'business.created', 'business', v_id,
    jsonb_build_object('name', v_name, 'currency', p_currency, 'timezone', p_timezone));
  return v_id;
end;
$$;

create function public.update_business_settings(p_business_id uuid, p_name text, p_currency text, p_timezone text, p_co_owners_can_invite boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_name text := btrim(p_name); v_before jsonb;
begin
  perform id from public.businesses where id = p_business_id for update;
  if not found or not private.has_role(p_business_id, array['owner']::public.business_role[]) then
    raise exception 'Owner permission required' using errcode = '42501';
  end if;
  if v_name is null or char_length(v_name) not between 1 and 120 then
    raise exception 'Business name must be 1–120 characters' using errcode = '22023';
  end if;
  if not private.validate_timezone(p_timezone) or not exists (select 1 from public.currencies where code = p_currency) then
    raise exception 'Invalid timezone or currency' using errcode = '22023';
  end if;
  if p_co_owners_can_invite is null then raise exception 'Invalid invitation setting' using errcode = '22023'; end if;
  select to_jsonb(b) - 'updated_at' into v_before from public.businesses b where id = p_business_id;
  -- Phase 3 adds a financial-activity guard before currency changes are permitted.
  update public.businesses set name = v_name, currency = p_currency, timezone = p_timezone,
    co_owners_can_invite = p_co_owners_can_invite where id = p_business_id;
  perform private.add_audit(p_business_id, 'business.settings_changed', 'business', p_business_id,
    jsonb_build_object('before', v_before, 'after', jsonb_build_object('name', v_name, 'currency', p_currency,
      'timezone', p_timezone, 'co_owners_can_invite', p_co_owners_can_invite), 'actor', v_actor));
end;
$$;

create function public.archive_business(p_business_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform id from public.businesses where id = p_business_id for update;
  if not found or not private.has_role(p_business_id, array['owner']::public.business_role[]) then
    raise exception 'Owner permission required' using errcode = '42501';
  end if;
  if p_archived is null then raise exception 'Invalid archive setting' using errcode = '22023'; end if;
  update public.businesses set archived_at = case when p_archived then coalesce(archived_at, now()) else null end
    where id = p_business_id;
  perform private.add_audit(p_business_id, case when p_archived then 'business.archived' else 'business.restored' end,
    'business', p_business_id, '{}'::jsonb);
end;
$$;

create function public.set_member_role(p_business_id uuid, p_user_id uuid, p_role public.business_role)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform id from public.businesses where id = p_business_id for update;
  if not found or not private.has_role(p_business_id, array['owner']::public.business_role[]) then
    raise exception 'Owner permission required' using errcode = '42501';
  end if;
  if p_role is null then raise exception 'Role required' using errcode = '22023'; end if;
  update public.business_members set role = p_role
    where business_id = p_business_id and user_id = p_user_id and removed_at is null;
  if not found then raise exception 'Active member not found' using errcode = 'P0002'; end if;
  perform private.add_audit(p_business_id, 'member.role_changed', 'member', p_user_id,
    jsonb_build_object('role', p_role));
end;
$$;

create function public.remove_member(p_business_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform id from public.businesses where id = p_business_id for update;
  if not found or not private.has_role(p_business_id, array['owner']::public.business_role[]) then
    raise exception 'Owner permission required' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then raise exception 'Use leave business for your own membership' using errcode = '22023'; end if;
  update public.business_members set removed_at = now()
    where business_id = p_business_id and user_id = p_user_id and removed_at is null;
  if not found then raise exception 'Active member not found' using errcode = 'P0002'; end if;
  perform private.add_audit(p_business_id, 'member.removed', 'member', p_user_id, '{}'::jsonb);
end;
$$;

create function public.leave_business(p_business_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  perform id from public.businesses where id = p_business_id for update;
  if not private.is_member(p_business_id) then raise exception 'Membership required' using errcode = '42501'; end if;
  update public.business_members set removed_at = now() where business_id = p_business_id and user_id = v_actor and removed_at is null;
  perform private.add_audit(p_business_id, 'member.left', 'member', v_actor, '{}'::jsonb);
end;
$$;

create function public.set_member_display_name(p_business_id uuid, p_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_name text := nullif(btrim(p_name), '');
begin
  perform id from public.businesses where id = p_business_id for update;
  if not private.is_member(p_business_id) then raise exception 'Membership required' using errcode = '42501'; end if;
  if v_name is not null and char_length(v_name) > 80 then raise exception 'Display name is too long' using errcode = '22023'; end if;
  update public.business_members set display_name = v_name where business_id = p_business_id and user_id = v_actor and removed_at is null;
  perform private.add_audit(p_business_id, 'member.name_changed', 'member', v_actor, jsonb_build_object('display_name', v_name));
end;
$$;

create function public.create_invitation(p_business_id uuid, p_role public.business_role, p_email text default null, p_expires_hours integer default 168)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_email text := nullif(lower(btrim(p_email)), '');
  v_token text := encode(extensions.gen_random_bytes(32), 'hex'); v_id uuid; v_expires timestamptz; v_allowed boolean;
begin
  perform id from public.businesses where id = p_business_id for update;
  if v_actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select private.has_role(p_business_id, array['owner']::public.business_role[])
    or (private.has_role(p_business_id, array['co_owner']::public.business_role[]) and co_owners_can_invite)
    into v_allowed from public.businesses where id = p_business_id and archived_at is null;
  if not coalesce(v_allowed, false) then raise exception 'Invitation permission required' using errcode = '42501'; end if;
  if p_role is null or p_role = 'owner' then raise exception 'Invitations cannot grant ownership' using errcode = '22023'; end if;
  if p_expires_hours is null or p_expires_hours not between 1 and 720 then raise exception 'Expiry must be 1–720 hours' using errcode = '22023'; end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
    raise exception 'Invalid email' using errcode = '22023';
  end if;
  if (select count(*) from public.invitations where business_id = p_business_id and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'Too many pending invitations' using errcode = '22023';
  end if;
  v_expires := now() + make_interval(hours => p_expires_hours);
  insert into public.invitations(business_id, role, email, token_hash, invited_by, expires_at)
    values (p_business_id, p_role, v_email, extensions.digest(v_token, 'sha256'), v_actor, v_expires)
    returning id into v_id;
  perform private.add_audit(p_business_id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'expires_at', v_expires));
  -- Raw token appears only in this response. Never audit/log the token or its hash.
  return jsonb_build_object('invitation_id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

create function public.list_invitations(p_business_id uuid)
returns table(id uuid, role public.business_role, email text, expires_at timestamptz,
  accepted_at timestamptz, revoked_at timestamptz, created_at timestamptz, invited_by uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not private.has_role(p_business_id, array['owner']::public.business_role[])
    and not (private.has_role(p_business_id, array['co_owner']::public.business_role[])
      and exists (select 1 from public.businesses where id = p_business_id and co_owners_can_invite)) then
    raise exception 'Invitation permission required' using errcode = '42501';
  end if;
  return query select i.id, i.role, i.email, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, i.invited_by
    from public.invitations i where i.business_id = list_invitations.p_business_id
    and (private.has_role(p_business_id, array['owner']::public.business_role[]) or i.invited_by = auth.uid())
    order by i.created_at desc limit 200;
end;
$$;

create function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_business_id uuid; v_allowed boolean;
begin
  select business_id into v_business_id from public.invitations where id = p_invitation_id;
  if not found then raise exception 'Invitation not found' using errcode = '42501'; end if;
  perform id from public.businesses where id = v_business_id for update;
  select private.has_role(v_business_id, array['owner']::public.business_role[])
    or (private.has_role(v_business_id, array['co_owner']::public.business_role[])
      and exists (select 1 from public.businesses where id = v_business_id and co_owners_can_invite)
      and exists (select 1 from public.invitations where id = p_invitation_id and invited_by = auth.uid()))
    into v_allowed;
  if not v_allowed then raise exception 'Invitation permission required' using errcode = '42501'; end if;
  update public.invitations set revoked_at = now()
    where id = p_invitation_id and accepted_at is null and revoked_at is null;
  if not found then raise exception 'Invitation is no longer pending' using errcode = '22023'; end if;
  perform private.add_audit(v_business_id, 'invitation.revoked', 'invitation', p_invitation_id, '{}'::jsonb);
end;
$$;

-- Token possession is the credential. Optional email binding additionally requires
-- the authenticated, confirmed email to match. Preview exposes no tenant directory.
create function private.valid_invitation(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select i.id from public.invitations i join public.businesses b on b.id = i.business_id
  where p_token ~ '^[0-9a-f]{64}$'
    and i.token_hash = extensions.digest(p_token, 'sha256')
    and i.accepted_at is null and i.revoked_at is null and i.expires_at > now() and b.archived_at is null;
$$;
revoke all on function private.valid_invitation(text) from public, anon, authenticated;

create function public.preview_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_invite public.invitations; v_name text; v_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  v_id := private.valid_invitation(p_token);
  if v_id is null then raise exception 'Invitation is invalid or expired' using errcode = '42501'; end if;
  select * into v_invite from public.invitations where id = v_id;
  select name into v_name from public.businesses where id = v_invite.business_id;
  if v_invite.email is not null then
    select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
    if v_email is distinct from v_invite.email then raise exception 'This invitation is bound to a different email' using errcode = '42501'; end if;
  end if;
  return jsonb_build_object('business_id', v_invite.business_id, 'business_name', v_name,
    'role', v_invite.role, 'expires_at', v_invite.expires_at);
end;
$$;

create function public.accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_id uuid; v_invite public.invitations; v_business_id uuid; v_email text;
begin
  if v_actor is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'Invalid invitation' using errcode = '42501'; end if;
  select business_id into v_business_id from public.invitations where token_hash = extensions.digest(p_token, 'sha256');
  if not found then raise exception 'Invitation is invalid or expired' using errcode = '42501'; end if;
  -- Same business-first lock order as revocation and membership changes.
  perform id from public.businesses where id = v_business_id for update;
  select * into v_invite from public.invitations where id = (
    select id from public.invitations where token_hash = extensions.digest(p_token, 'sha256')
  ) for update;
  if v_invite.accepted_at is not null or v_invite.revoked_at is not null or v_invite.expires_at <= now()
    or exists (select 1 from public.businesses where id = v_business_id and archived_at is not null) then
    raise exception 'Invitation is invalid or expired' using errcode = '42501';
  end if;
  if v_invite.email is not null then
    select lower(email) into v_email from auth.users where id = v_actor and email_confirmed_at is not null;
    if v_email is distinct from v_invite.email then raise exception 'This invitation is bound to a different email' using errcode = '42501'; end if;
  end if;
  if exists (select 1 from public.business_members where business_id = v_business_id and user_id = v_actor and removed_at is null) then
    raise exception 'You are already a member of this business' using errcode = '22023';
  end if;
  insert into public.business_members(business_id, user_id, role, invited_by)
    values (v_business_id, v_actor, v_invite.role, v_invite.invited_by)
    on conflict (business_id, user_id) do update set role = excluded.role,
      invited_by = excluded.invited_by, removed_at = null, display_name = null;
  update public.invitations set accepted_at = now(), accepted_by = v_actor where id = v_invite.id;
  perform private.add_audit(v_business_id, 'invitation.accepted', 'invitation', v_invite.id,
    jsonb_build_object('member_id', v_actor, 'role', v_invite.role));
  return v_business_id;
end;
$$;

-- Explicit execute grants; no anonymous business/invitation RPC access.
revoke all on function public.create_business(text,text,text) from public, anon;
revoke all on function public.update_business_settings(uuid,text,text,text,boolean) from public, anon;
revoke all on function public.archive_business(uuid,boolean) from public, anon;
revoke all on function public.set_member_role(uuid,uuid,public.business_role) from public, anon;
revoke all on function public.remove_member(uuid,uuid) from public, anon;
revoke all on function public.leave_business(uuid) from public, anon;
revoke all on function public.set_member_display_name(uuid,text) from public, anon;
revoke all on function public.create_invitation(uuid,public.business_role,text,integer) from public, anon;
revoke all on function public.list_invitations(uuid) from public, anon;
revoke all on function public.revoke_invitation(uuid) from public, anon;
revoke all on function public.preview_invitation(text) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.create_business(text,text,text) to authenticated;
grant execute on function public.update_business_settings(uuid,text,text,text,boolean) to authenticated;
grant execute on function public.archive_business(uuid,boolean) to authenticated;
grant execute on function public.set_member_role(uuid,uuid,public.business_role) to authenticated;
grant execute on function public.remove_member(uuid,uuid) to authenticated;
grant execute on function public.leave_business(uuid) to authenticated;
grant execute on function public.set_member_display_name(uuid,text) to authenticated;
grant execute on function public.create_invitation(uuid,public.business_role,text,integer) to authenticated;
grant execute on function public.list_invitations(uuid) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.preview_invitation(text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;

create or replace function public.ownerbook_health()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('service', 'ownerbook', 'schema_version', 2, 'database_time', statement_timestamp());
$$;

commit;
