import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  let checks = 0;
  function check(condition: unknown, description: string) {
    assert.ok(condition, description);
    checks += 1;
    console.log(`  ✓ ${description}`);
  }

  try {
    // Minimal Supabase-owned roles, not a replacement for a live Supabase instance.
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create role outsider nologin;
      create schema auth;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    `);
    const directory = join(process.cwd(), 'supabase/migrations');
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    const sql = (
      await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
    ).join('\n');
    const foundation = await readFile(join(directory, '20261101000100_foundation.sql'), 'utf8');
    // Replay the foundation BEFORE later migrations: its health version is then
    // deliberately superseded by the latest schema version below.
    await db.exec(foundation);
    await db.exec(foundation);
    checks += 1;
    console.log('  ✓ Foundation migration can be reapplied');
    await db.exec(sql);
    checks += 1;
    console.log(`  ✓ ${files.length} migration(s) apply successfully`);

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role};`);
      const result = await db.query<{
        ownerbook_health: { service: string; schema_version: number; database_time: string };
      }>('select public.ownerbook_health();');
      await db.exec('reset role;');
      const health = result.rows[0]?.ownerbook_health;
      check(health?.service === 'ownerbook', `${role} can call the health RPC`);
      check(health?.schema_version === 3, `${role} receives the actual schema version`);
      check(
        typeof health?.database_time === 'string' &&
          Number.isFinite(Date.parse(health.database_time)),
        `${role} receives a database timestamp`,
      );
    }

    const metadata = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      `select prosecdef, proconfig from pg_proc where oid = 'public.ownerbook_health()'::regprocedure;`,
    );
    check(metadata.rows[0]?.prosecdef === false, 'Health RPC does not elevate caller privileges');
    check(
      metadata.rows[0]?.proconfig?.includes('search_path=""'),
      'Health RPC pins an empty search path',
    );

    const grants = await db.query<{ allowed: boolean }>(`
      select has_function_privilege('anon', 'public.ownerbook_health()', 'execute') as allowed;
    `);
    check(grants.rows[0]?.allowed === true, 'Anon execute grant is present');
    await db.exec('set role outsider;');
    await assert.rejects(db.query('select public.ownerbook_health()'), /permission denied/);
    await db.exec('reset role;');
    checks += 1;
    console.log('  ✓ Ungranted role cannot execute the health RPC');
    await db.exec('set role anon;');
    await assert.rejects(
      db.exec('create table private.escape_test (id integer)'),
      /permission denied/,
    );
    await db.exec('reset role;');
    checks += 1;
    console.log('  ✓ Anon cannot create objects in the private schema');
    console.log(
      `\n${checks} SQL checks passed in embedded PostgreSQL. Live Supabase is not verified.`,
    );
  } finally {
    await db.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
