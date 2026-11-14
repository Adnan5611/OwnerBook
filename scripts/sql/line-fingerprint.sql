-- Per-line fingerprints of the three schema categories that differ between a
-- local native-PostgreSQL run and a hosted Supabase project, used to locate the
-- exact differing objects instead of comparing whole-category digests.
--
-- Output: one text blob, one line per object, ordered deterministically.
with lines as (
  select 'fns' as cat,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid)
           || ')->' || pg_get_function_result(p.oid) || ':' || p.prosecdef::text || ':'
           || p.provolatile::text || ':' || coalesce(array_to_string(p.proconfig, ','), '-') as line
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname <> 'rls_auto_enable'
  union all
  select 'trg',
         event_object_table || '.' || trigger_name || ':' || action_timing || ':'
           || event_manipulation || ':' || action_orientation || ':' || action_statement
  from information_schema.triggers
  where trigger_schema = 'public'
  union all
  select 'idx', tablename || '.' || indexname || ':' || indexdef
  from pg_indexes
  where schemaname = 'public'
)
select count(*) as line_count,
       string_agg(
         cat || ' ' || left(encode(extensions.digest(convert_to(line, 'UTF8'), 'sha256'), 'hex'), 12)
           || ' ' || left(line, 38),
         E'\n' order by cat, line
       ) as lines
from lines
