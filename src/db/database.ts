import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function connectDatabase(options: { url?: string; directory?: string; memory?: boolean } = {}): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 5 });
    return {
      query: (sql, params) => pool.query(sql, params),
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work({ query: (sql, params) => client.query(sql, params) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  const directory = options.memory ? undefined : options.directory ?? '.faultline/data';
  if (directory) await mkdir(directory, { recursive: true });
  const db = new PGlite(directory);
  await db.waitReady;
  return {
    query: (sql, params) => db.query(sql, params),
    transaction: work => db.transaction(tx => work({ query: (sql, params) => tx.query(sql, params) })),
    close: () => db.close(),
  };
}
