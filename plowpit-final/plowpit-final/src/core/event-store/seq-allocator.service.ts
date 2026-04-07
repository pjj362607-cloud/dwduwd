// =============================================================================
// src/core/event-store/seq-allocator.service.ts
// 티켓 3: object_seq_no 발급기
// 원칙: 같은 객체 내부 단조 증가. occurred_at만으로 순서 판단 금지.
//       동시성 충돌 방지. 재시도 중복 저장 방지.
// =============================================================================

import { Pool, PoolClient } from 'pg';
import { ObjectType, EventCoreError, EventCoreErrorCode } from './events.types';

export class SeqAllocatorService {
  constructor(private readonly pool: Pool) {}

  /**
   * 지정 객체의 다음 seq_no를 원자적으로 발급.
   * DB 레벨 atomic increment로 동시성 충돌 방지.
   * 반드시 트랜잭션 내에서 호출해야 한다.
   *
   * @param client - 현재 트랜잭션의 PoolClient (트랜잭션 외부 호출 불가)
   * @param objectType
   * @param objectId
   * @returns 새로 발급된 seq_no
   */
  async allocateNext(
    client: PoolClient,
    objectType: ObjectType,
    objectId: string
  ): Promise<number> {
    // INSERT ... ON CONFLICT DO UPDATE (upsert + atomic increment)
    // SELECT FOR UPDATE는 row-level lock으로 동시성 보장
    const result = await client.query<{ last_seq_no: string }>(
      `
      INSERT INTO object_seq_counters (object_type, object_id, last_seq_no, updated_at)
      VALUES ($1, $2, 1, NOW())
      ON CONFLICT (object_type, object_id)
      DO UPDATE SET
        last_seq_no = object_seq_counters.last_seq_no + 1,
        updated_at  = NOW()
      RETURNING last_seq_no
      `,
      [objectType, objectId]
    );

    if (!result.rows[0]) {
      throw new EventCoreError(
        `seq_no 발급 실패: ${objectType}:${objectId}`,
        EventCoreErrorCode.SEQ_CONFLICT
      );
    }

    return parseInt(result.rows[0].last_seq_no, 10);
  }

  /**
   * 객체의 현재 마지막 seq_no 조회 (읽기 전용, 트랜잭션 불필요).
   */
  async getCurrentSeq(
    objectType: ObjectType,
    objectId: string
  ): Promise<number> {
    const result = await this.pool.query<{ last_seq_no: string }>(
      `SELECT last_seq_no FROM object_seq_counters
       WHERE object_type = $1 AND object_id = $2`,
      [objectType, objectId]
    );

    return result.rows[0] ? parseInt(result.rows[0].last_seq_no, 10) : 0;
  }

  /**
   * replay 시 seq_no 정합성 검증.
   * DB 카운터와 events 테이블의 MAX seq_no가 일치하는지 확인.
   */
  async validateSeqConsistency(
    objectType: ObjectType,
    objectId: string
  ): Promise<{ consistent: boolean; counterSeq: number; maxEventSeq: number }> {
    const client = await this.pool.connect();
    try {
      const [counterResult, maxResult] = await Promise.all([
        client.query<{ last_seq_no: string }>(
          `SELECT last_seq_no FROM object_seq_counters
           WHERE object_type = $1 AND object_id = $2`,
          [objectType, objectId]
        ),
        client.query<{ max_seq: string | null }>(
          `SELECT MAX(object_seq_no) AS max_seq FROM events
           WHERE object_type = $1 AND object_id = $2`,
          [objectType, objectId]
        ),
      ]);

      const counterSeq = counterResult.rows[0]
        ? parseInt(counterResult.rows[0].last_seq_no, 10)
        : 0;
      const maxEventSeq = maxResult.rows[0]?.max_seq
        ? parseInt(maxResult.rows[0].max_seq, 10)
        : 0;

      return {
        consistent: counterSeq === maxEventSeq,
        counterSeq,
        maxEventSeq,
      };
    } finally {
      client.release();
    }
  }
}
