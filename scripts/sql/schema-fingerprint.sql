-- Deterministic fingerprint of the OwnerBook schema.
--
-- The same text is executed against the local native-PostgreSQL harness
-- (scripts/schema-fingerprint.ts) and against a hosted Supabase project, so the
-- two digests can be compared. Equal digests mean equal schemas.
--
-- Deliberately excluded, because they differ between environments for reasons
-- unrelated to the migrations:
--   * objects outside public/private (auth.uid() is a stub locally),
--   * public.rls_auto_enable (a hosted Supabase event trigger function),
--   * extension availability,
--   * grants to roles other than anon/authenticated/service_role.
with cols as (
  select string_agg(
           table_name || '.' || column_name || ':' || coalesce(udt_name, '-')
             || ':' || coalesce(numeric_precision::text, '-')
             || ':' || coalesce(numeric_scale::text, '-')
             || ':' || is_nullable || ':' || coalesce(column_default, '-'),
           E'\n' order by table_name, column_name
         ) as s
  from information_schema.columns
  where table_schema = 'public'
),
fns as (
  select string_agg(
           n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
             || ')->' || pg_get_function_result(p.oid) || ':' || p.prosecdef::text || ':' || p.provolatile::text
             || ':' || coalesce(array_to_string(p.proconfig, ','), '-'),
           E'\n' order by 1
         ) as s
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname <> 'rls_auto_enable'
),
pol as (
  select string_agg(
           tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
             || ':' || coalesce(qual, '-') || ':' || coalesce(with_check, '-'),
           E'\n' order by 1
         ) as s
  from pg_policies
  where schemaname = 'public'
),
trg as (
  select string_agg(
           event_object_table || '.' || trigger_name || ':' || action_timing || ':'
             || event_manipulation || ':' || action_orientation || ':' || action_statement,
           E'\n' order by 1
         ) as s
  from information_schema.triggers
  where trigger_schema = 'public'
),
idx as (
  select string_agg(tablename || '.' || indexname || ':' || indexdef, E'\n' order by 1) as s
  from pg_indexes
  where schemaname = 'public'
),
rls as (
  select string_agg(c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text,
                    E'\n' order by 1) as s
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
tgr as (
  select string_agg(
           n.nspname || '.' || c.relname || ':' || pg_catalog.array_to_string(c.relacl, ','),
           E'\n' order by 1
         ) as s
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'S')
),
tg as (
  select string_agg(table_name || ':' || grantee || ':' || privilege_type, E'\n' order by 1) as s
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
),
fg as (
  select string_agg(specific_schema || '.' || routine_name || ':' || grantee || ':' || privilege_type,
                    E'\n' order by 1) as s
  from information_schema.routine_privileges
  where specific_schema in ('public', 'private')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
),
sg as (
  select string_agg(object_schema || ':' || grantee || ':' || privilege_type, E'\n' order by 1) as s
  from information_schema.role_usage_grants
  where object_type = 'SCHEMA'
    and object_schema in ('public', 'private')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
)
select
  (select count(*) from information_schema.tables where table_schema = 'public') as tables,
  (select count(*) from information_schema.columns where table_schema = 'public') as columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname <> 'rls_auto_enable') as public_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private') as private_functions,
  (select count(*) from pg_policies where schemaname = 'public') as policies,
  (select count(*) from information_schema.triggers where trigger_schema = 'public') as trigger_events,
  (select count(*) from pg_indexes where schemaname = 'public') as indexes,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity) as tables_without_rls,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and data_type in ('double precision', 'real')) as float_columns,
  (select public.ownerbook_health() ->> 'schema_version') as schema_version,
  left(encode(extensions.digest(convert_to(coalesce((select s from cols), ''), 'UTF8'), 'sha256'), 'hex'), 16) as cols_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from fns), ''), 'UTF8'), 'sha256'), 'hex'), 16) as fns_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from pol), ''), 'UTF8'), 'sha256'), 'hex'), 16) as pol_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from trg), ''), 'UTF8'), 'sha256'), 'hex'), 16) as trg_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from idx), ''), 'UTF8'), 'sha256'), 'hex'), 16) as idx_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from rls), ''), 'UTF8'), 'sha256'), 'hex'), 16) as rls_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from tgr), ''), 'UTF8'), 'sha256'), 'hex'), 16) as tgr_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from tg), ''), 'UTF8'), 'sha256'), 'hex'), 16) as tg_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from fg), ''), 'UTF8'), 'sha256'), 'hex'), 16) as fg_sha,
  left(encode(extensions.digest(convert_to(coalesce((select s from sg), ''), 'UTF8'), 'sha256'), 'hex'), 16) as sg_sha
