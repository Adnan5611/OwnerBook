import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * Shared harness for the native-PostgreSQL suites.
 *
 * This is a real PostgreSQL 17 server with the real migrations applied and the
 * real Supabase role layout (`anon`, `authenticated`, `service_role`) plus a
 * minimal `auth.uid()` implementation driven by the JWT claim. It is NOT a live
 * Supabase project: GoTrue, PostgREST, Realtime and Storage still require hosted
 * verification, and every report says so.
 */
export type Harness = {
  admin: Client;
  port: number;
  password: string;
  checks: number;
  /** Records a passing assertion. */
  ok(value: unknown, label: string): void;
  /** Asserts deep equality and records a passing assertion. */
  equal(actual: unknown, expected: unknown, label: string): void;
  /** Asserts the statement is rejected with one of the app's permission/validation codes. */
  denied(client: Client, sql: string, params: unknown[], label: string): Promise<void>;
  /** Asserts the statement is rejected with a specific SQLSTATE. */
  deniedWith(
    client: Client,
    sql: string,
    params: unknown[],
    code: string,
    label: string,
  ): Promise<void>;
  /** Asserts a write affected no rows (RLS filtered it out). */
  noRows(client: Client, sql: string, params: unknown[], label: string): Promise<void>;
  /** Opens a connection acting as an authenticated user (`request.jwt.claim.sub`). */
  actor(userId?: string): Promise<Client>;
  /** Inserts an auth user, which fires the profile-creation trigger. */
  createUser(handle: string, options?: { confirmed?: boolean }): Promise<string>;
};

// Deliberately the same allowlist the Phase 2 suite has always used. Anything
// else (a unique violation, a cast error, a check-constraint failure) must be
// asserted explicitly with deniedWith(), so a wrong error is never "denied".
const PERMISSION_CODES = ['42501', '23514', '22023', 'P0002'];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function withPostgres(
  run: (harness: Harness) => Promise<void>,
  options: { summary: string },
): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), '.pg-test-'));
  const port = await freePort();
  const password = randomUUID();
  const pg = new EmbeddedPostgres({
    databaseDir: directory,
    user: 'postgres',
    password,
    port,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => {},
    onError: () => {},
  });
  const connections: Client[] = [];
  let admin: Client | undefined;
  let started = false;
  const harness: Harness = {
    admin: undefined as unknown as Client,
    port,
    password,
    checks: 0,
    ok(value, label) {
      assert.ok(value, label);
      harness.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    equal(actual, expected, label) {
      assert.equal(actual, expected, label);
      harness.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    async denied(client, sql, params, label) {
      await assert.rejects(
        client.query(sql, params),
        (error: unknown) => {
          const code = (error as { code?: string }).code;
          return PERMISSION_CODES.includes(code ?? '');
        },
        label,
      );
      harness.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    async deniedWith(client, sql, params, code, label) {
      await assert.rejects(
        client.query(sql, params),
        (error: unknown) => {
          return (error as { code?: string }).code === code;
        },
        label,
      );
      harness.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    async noRows(client, sql, params, label) {
      const result = await client.query(`${sql} returning 1 as changed`, params);
      assert.equal(result.rowCount, 0, label);
      harness.checks += 1;
      console.log(`  ✓ ${label}`);
    },
    async actor(userId) {
      const client = new Client({
        host: '127.0.0.1',
        port,
        database: 'postgres',
        user: 'postgres',
        password,
      });
      await client.connect();
      await client.query('set role authenticated');
      await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? '']);
      connections.push(client);
      return client;
    },
    async createUser(handle, opts) {
      const id = randomUUID();
      await harness.admin.query(
        'insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values ($1,$2,$3,$4)',
        [
          id,
          `${handle}@example.test`,
          opts?.confirmed === false ? null : new Date(),
          JSON.stringify({ display_name: handle }),
        ],
      );
      return id;
    },
  };
  try {
    // Hosted Supabase runs UTF8. The default sandbox locale is POSIX/C, which
    // makes initdb create a SQL_ASCII cluster where char_length() counts bytes
    // instead of characters, so validation limits would be tested against a
    // different encoding than production. C.utf8 is the closest available match
    // (en_US.UTF-8 cannot be generated in this sandbox).
    process.env.LC_ALL = 'C.utf8';
    process.env.LANG = 'C.utf8';
    await pg.initialise();
    await pg.start();
    started = true;
    admin = new Client({
      host: '127.0.0.1',
      port,
      database: 'postgres',
      user: 'postgres',
      password,
    });
    await admin.connect();
    harness.admin = admin;
    const locale = await admin.query(
      `select pg_encoding_to_char(encoding) as encoding, datcollate
         from pg_database where datname = current_database()`,
    );
    assert.equal(
      locale.rows[0]?.encoding,
      'UTF8',
      `test database must use UTF8 like hosted Supabase, got ${String(locale.rows[0]?.encoding)}`,
    );
    assert.equal(
      locale.rows[0]?.datcollate,
      'C.utf8',
      `test database collation changed, got ${String(locale.rows[0]?.datcollate)}`,
    );
    await admin.query(`
      create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
    `);
    const migrationDir = join(process.cwd(), 'supabase/migrations');
    for (const file of (await readdir(migrationDir))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      await admin.query(await readFile(join(migrationDir, file), 'utf8'));
    }
    harness.ok(true, 'All migrations apply on native PostgreSQL 17');
    await run(harness);
    console.log(`\n${harness.checks} ${options.summary}`);
  } finally {
    for (const client of connections) await client.end().catch(() => {});
    await admin?.end().catch(() => {});
    if (started) await pg.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
