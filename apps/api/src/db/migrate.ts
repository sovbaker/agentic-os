import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from './client';
import { log } from '../obs/log';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Миграции, которые пропускаются, если расширения нет в этой инсталляции Postgres. */
const OPTIONAL: Record<string, { extension: string; degradation: string }> = {
  '002_vector.sql': {
    extension: 'vector',
    degradation: 'семантический поиск отключён, retrieval работает только структурно',
  },
};

async function hasExtension(name: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = $1) AS ok',
    [name]
  );
  return rows[0]?.ok ?? false;
}

export async function migrate(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name)
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const optional = OPTIONAL[file];
    if (optional && !(await hasExtension(optional.extension))) {
      log.warn(
        `миграция ${file} пропущена: расширение "${optional.extension}" недоступно — ${optional.degradation}`
      );
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      // Каждая миграция целиком в транзакции: половина применённой схемы
      // хуже, чем неприменённая.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.info(`миграция применена: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

/** Есть ли векторный поиск — от этого зависит стратегия retrieval. */
export async function vectorSearchAvailable(): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'fact' AND column_name = 'embedding'
     ) AS ok`
  );
  return rows[0]?.ok ?? false;
}
