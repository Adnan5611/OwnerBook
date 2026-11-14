-- Deterministic fingerprint of the OwnerBook schema.
--
-- The same text is executed against the local native-PostgreSQL harness
-- (npm run fingerprint) and against a hosted Supabase project, so the two
-- digests can be compared. Equal digests mean equal schemas.
--
-- Every category is ordered by the sha256 hex of each line rather than by the
-- line itself: hex is plain ASCII, so the order is identical under the C
-- collation the local harness uses and the en_US.UTF-8 collation hosted
-- Supabase uses. Ordering by text would make the digest collation-dependent and
-- the comparison useless.
--
-- Deliberately excluded, because they differ between environments for reasons
-- unrelated to the migrations:
--   * objects outside public/private (auth.uid() is a stub locally),
--   * public.rls_auto_enable (a hosted Supabase event trigger function),
--   * extension availability,
--   * grants to roles other than anon/authenticated/service_role/PUBLIC.
with col_lines as (
  select table_name || '.' || column_name || ':' || coalesce(udt_name, '-')
           || ':' || coalesce(numeric_precision::text, '-')
           || ':' || coalesce(numeric_scale::text, '-')
           || ':' || is_nullable || ':' || coalesce(column_default, '-') as line
  from information_schema.columns
  where table_schema = 'public'
),
fn_lines as (
  select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
           || ')->' || pg_get_function_result(p.oid) || ':' || p.prosecdef::text || ':'
           || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ','), '-') as line
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname <> 'rls_auto_enable'
),
pol_lines as (
  select tablename || '.' || policyname || ':' || cmd || ':' || array_to_string(roles, ',')
           || ':' || coalesce(qual, '-') || ':' || coalesce(with_check, '-') as line
  from pg_policies
  where schemaname = 'public'
),
trg_lines as (
  select event_object_table || '.' || trigger_name || ':' || action_timing || ':'
           || event_manipulation || ':' || action_orientation || ':' || action_statement as line
  from information_schema.triggers
  where trigger_schema = 'public'
),
idx_lines as (
  select tablename || '.' || indexname || ':' || indexdef as line
  from pg_indexes
  where schemaname = 'public'
),
rls_lines as (
  select c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text as line
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
),
acl_lines as (
  select n.nspname || '.' || c.relname || ':' || coalesce(c.relacl::text, 'default') as line
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'S')
),
nsp_lines as (
  select n.nspname || ':' || coalesce(n.nspacl::text, 'default') as line
  from pg_namespace n
  where n.nspname = 'private'
),
tg_lines as (
  select table_name || ':' || grantee || ':' || privilege_type as line
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
),
fg_lines as (
  select specific_schema || '.' || routine_name || ':' || grantee || ':' || privilege_type as line
  from information_schema.routine_privileges
  where specific_schema in ('public', 'private')
    and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and routine_name <> 'rls_auto_enable'
),
digested as (
  select 'cols' as cat, line from col_lines
  union all select 'fns', line from fn_lines
  union all select 'pol', line from pol_lines
  union all select 'trg', line from trg_lines
  union all select 'idx', line from idx_lines
  union all select 'rls', line from rls_lines
  union all select 'acl', line from acl_lines
  union all select 'nsp', line from nsp_lines
  union all select 'tg', line from tg_lines
  union all select 'fg', line from fg_lines
),
per_cat as (
  select cat,
         count(*) as line_count,
         string_agg(line, E'\n'
           order by encode(extensions.digest(convert_to(line, 'UTF8'), 'sha256'), 'hex')) as body
  from digested
  group by cat
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
  (select string_agg(cat || '=' || line_count || ':'
      || left(encode(extensions.digest(convert_to(body, 'UTF8'), 'sha256'), 'hex'), 16),
      ' ' order by cat)
     from per_cat) as digests
