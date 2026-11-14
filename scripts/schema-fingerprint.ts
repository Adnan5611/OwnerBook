import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPostgres } from './lib/pg-harness';

/**
 * Prints the OwnerBook schema fingerprint produced by a local native PostgreSQL
 * 17 server with every migration applied.
 *
 * Any SQL file returning one row can be fingerprinted: pass its path as the
 * first argument (for example scripts/sql/grant-audit.sql). The same text is run
 * against a hosted
 * Supabase project; matching digests prove the hosted schema is identical to the
 * one the local suites test. Usage: npm run fingerprint
 */
async function main(): Promise<void> {
  const file = process.argv[2] ?? 'scripts/sql/schema-fingerprint.sql';
  const sql = await readFile(join(process.cwd(), file), 'utf8');
  await withPostgres(
    async (harness) => {
      const result = await harness.admin.query(sql);
      // Marker so the JSON can be separated from the harness progress output.
      process.stdout.write(`FINGERPRINT_JSON ${JSON.stringify(result.rows[0])}\n`);
    },
    { summary: 'schema fingerprint printed' },
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
