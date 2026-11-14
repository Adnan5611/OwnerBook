-- Privilege audit for a deployed OwnerBook schema.
--
-- Run locally (npm run fingerprint -- scripts/sql/grant-audit.sql) and against a
-- hosted Supabase project. The two answers must match. Hosted Supabase installs
-- ALTER DEFAULT PRIVILEGES in public, so this is the check that proves new
-- OwnerBook tables are not silently exposed to anon/authenticated.
select
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated')
      and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) as client_write_grants,
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated')
      and g.privilege_type = 'SELECT'
  ) as client_select_grants,
  (select count(*) from information_schema.routine_privileges r
    where r.specific_schema = 'private'
      and r.grantee in ('anon', 'authenticated')
  ) as private_execute_grants,
  (select coalesce(
     string_agg(n.nspname || '=' || coalesce(n.nspacl::text, 'default'), ' | ' order by n.nspname),
     'none')
    from pg_namespace n
    where n.nspname in ('public', 'private')
  ) as schema_acls,
  (select count(*) from information_schema.routine_privileges r
    where r.specific_schema = 'public'
      and r.grantee in ('anon', 'authenticated')
      and r.privilege_type = 'EXECUTE'
  ) as public_execute_grants,
  (select count(*) from information_schema.routine_privileges r
    where r.specific_schema = 'public'
      and r.grantee = 'PUBLIC'
      and r.privilege_type = 'EXECUTE'
  ) as everyone_execute_grants,
  (select count(*) from information_schema.routine_privileges r
    where r.specific_schema = 'public'
      and r.grantee = 'service_role'
      and r.privilege_type = 'EXECUTE'
  ) as service_role_execute_grants,
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname <> 'rls_auto_enable'
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%'
  ) as security_definer_without_pinned_search_path,
  (select count(*) from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname <> 'rls_auto_enable' and p.prosecdef
  ) as security_definer_functions,
  (select coalesce(
     string_agg(
       d.defaclrole::regrole::text || '/' || d.defaclobjtype::text || '=' || d.defaclacl::text,
       ' | ' order by 1),
     'none')
    from pg_default_acl d
  ) as default_privileges,
  (select coalesce(
     string_agg(c.relname || '=' || c.relacl::text, ' | ' order by c.relname),
     'none')
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relacl is not null
  ) as tables_with_explicit_acl
