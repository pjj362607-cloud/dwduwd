// =============================================================================
// src/db/client.ts
// DB 연결 풀 싱글톤
// =============================================================================

import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    if (process.env.DATABASE_URL) {
      // Neon / Railway — 연결 문자열 방식
      _pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 5_000,
      });
    } else {
      // 개별 환경변수 방식 (로컬 개발)
      _pool = new Pool({
        host:     process.env.DB_HOST     ?? 'localhost',
        port:     parseInt(process.env.DB_PORT ?? '5432'),
        database: process.env.DB_NAME     ?? 'event_core',
        user:     process.env.DB_USER     ?? 'postgres',
        password: process.env.DB_PASSWORD ?? 'postgres',
        max: 20,
        idleTimeoutMillis: 30_000,
      });
    }
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
