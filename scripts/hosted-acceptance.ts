import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryResult } from 'pg';
import { withPostgres } from './lib/pg-harness';

type Summary = { checks: string; passed: string; failed: string; results: string };

/**
 * Runs scripts/sql/hosted-acceptance.sql against the local native PostgreSQL 17
 * server so the SQL itself is proven before it is executed against a live
 * Supabase project. The same file is fetched and executed on the hosted side;
 * only the transport differs.
 *
 * Usage: npm run test:acceptance
 */
async function main(): Promise<void> {
  const sql = await readFile(join(process.cwd(), 'scripts/sql/hosted-acceptance.sql'), 'utf8');
  await withPostgres(
    async (harness) => {
      const executed = (await harness.admin.query(sql)) as unknown as
        QueryResult<Summary> | QueryResult<Summary>[];
      const last = Array.isArray(executed) ? executed[executed.length - 1] : executed;
      const summary = last?.rows[0];
      if (!summary) throw new Error('the acceptance run produced no summary row');
      let failures = 0;
      for (const line of summary.results.split('\n').filter((entry) => entry.length > 0)) {
        if (line.startsWith('PASS')) {
          harness.ok(true, line.replace(/^PASS\s*/, ''));
        } else {
          failures += 1;
          console.log(`  ✗ ${line}`);
        }
      }
      if (failures > 0) {
        console.log(`\n${failures} acceptance checks FAILED`);
        process.exitCode = 1;
      }
    },
    { summary: 'acceptance checks passed against native PostgreSQL' },
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
