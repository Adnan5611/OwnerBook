-- OwnerBook foundation. Apply through Supabase CLI or the project's SQL editor.
-- Business tables and their RLS policies are introduced with their feature migrations.
begin;

create schema if not exists extensions;
create schema if not exists private;
revoke all on schema private from public;
-- Direct access is intentionally not granted to anon or authenticated.
comment on schema private is 'OwnerBook server-side helpers; no direct client access.';

-- Public, non-sensitive diagnostic endpoint. It exposes no business records,
-- counts, user identifiers, secrets, or configuration. SECURITY INVOKER is explicit.
create or replace function public.ownerbook_health()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'service', 'ownerbook',
    'schema_version', 1,
    'database_time', statement_timestamp()
  );
$$;

revoke all on function public.ownerbook_health() from public;
grant execute on function public.ownerbook_health() to anon, authenticated;
comment on function public.ownerbook_health() is
  'Non-sensitive connectivity and schema-version probe for the mobile application.';

commit;
