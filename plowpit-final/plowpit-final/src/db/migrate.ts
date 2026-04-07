// =============================================================================
// src/db/migrate.ts
// 마이그레이션 실행기
// =============================================================================

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function runMigrations(): Promise<void> {
  const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      })
    : new Pool({
        host:     process.env.DB_HOST     ?? 'localhost',
        port:     parseInt(process.env.DB_PORT ?? '5432'),
        database: process.env.DB_NAME     ?? 'event_core',
        user:     process.env.DB_USER     ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'postgres',
      });

  const client = await pool.connect();

  try {
    // 마이그레이션 추적 테이블
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT        NOT NULL PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');

      const applied = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = $1`,
        [version]
      );

      if (applied.rows.length > 0) {
        console.log(`[Migration] 건너뜀: ${version}`);
        continue;
      }

      console.log(`[Migration] 실행 중: ${version}`);
      const sql = fs.readFileSync(path.join(migrationDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version) VALUES ($1)`,
          [version]
        );
        await client.query('COMMIT');
        console.log(`[Migration] 완료: ${version}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('[Migration] 모든 마이그레이션 완료');
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations().catch(err => {
  console.error('[Migration] 실패:', err);
  process.exit(1);
});
