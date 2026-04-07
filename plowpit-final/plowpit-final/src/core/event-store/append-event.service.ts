// =============================================================================
// src/core/event-store/append-event.service.ts
// 티켓 2: appendEvent 서비스
// 원칙:
//   - 모든 상태 변경의 단일 진입점
//   - appendEvent는 "이벤트 저장기"이지 "업무 판단기"가 아님
//   - 업무 판단은 transitionObject에서 수행
//   - 권한 우회 저장 금지
//   - current projection 갱신 로직 직접 포함 금지 (projector가 담당)
// =============================================================================

import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  AppendEventInput,
  AppendEventResult,
  EventRecord,
  EventCoreError,
  EventCoreErrorCode,
} from './events.types';
import { SeqAllocatorService } from './seq-allocator.service';
import { validateEventInput } from './event-schema.validator';
import { ProjectorDispatcher } from '../projection/projector.dispatcher';

export class AppendEventService {
  constructor(
    private readonly pool: Pool,
    private readonly seqAllocator: SeqAllocatorService,
    private readonly projectorDispatcher: ProjectorDispatcher
  ) {}

  /**
   * 이벤트를 append-only로 저장하는 단일 진입점.
   *
   * 보장:
   * 1. 스키마 검증 통과 후에만 저장
   * 2. seq_no 원자적 발급 (동시성 안전)
   * 3. 외부 이벤트 ID 멱등성 보장
   * 4. 저장 후 projector에 dispatch (비동기)
   * 5. current projection 갱신은 이 서비스가 직접 하지 않음
   */
  async append(input: AppendEventInput): Promise<AppendEventResult> {
    // ── 1. 스키마 검증 ─────────────────────────────────────────────────────
    validateEventInput(input);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // ── 2. 외부 이벤트 ID 멱등성 체크 ────────────────────────────────────
      if (input.external_event_id) {
        const existing = await this.checkExternalEventIdempotency(
          client,
          input.source_channel ?? 'web',
          input.external_event_id
        );
        if (existing) {
          await client.query('ROLLBACK');
          // 이미 처리된 이벤트: 원래 결과를 그대로 반환 (멱등성)
          return existing;
        }
      }

      // ── 3. seq_no 원자적 발급 ─────────────────────────────────────────────
      const seqNo = await this.seqAllocator.allocateNext(
        client,
        input.object_type,
        input.object_id
      );

      // ── 4. 이벤트 레코드 구성 ─────────────────────────────────────────────
      const eventId = uuidv4();
      const now = new Date();
      const occurredAt = input.occurred_at ?? now;

      const eventRecord: Omit<EventRecord, 'recorded_at'> = {
        event_id: eventId,
        object_type: input.object_type,
        object_id: input.object_id,
        object_seq_no: seqNo,
        event_name: input.event_name,
        from_state: input.from_state ?? null,
        to_state: input.to_state ?? null,
        actor_type: input.actor_type,
        actor_id: input.actor_id,
        actor_role: input.actor_role,
        decision_role: input.decision_role ?? null,
        exception_closed_by_role: input.exception_closed_by_role ?? null,
        reason_code: input.reason_code ?? null,
        payload_json: input.payload_json ?? {},
        payload_schema_version: input.payload_schema_version,
        severity: input.severity ?? null,
        sla_started_at: input.sla_started_at ?? null,
        occurred_at: occurredAt,
        caused_by_event_id: input.caused_by_event_id ?? null,
        correlation_id: input.correlation_id ?? null,
        revision_no: input.revision_no ?? 1,
        external_event_id: input.external_event_id ?? null,
        dedupe_key: input.dedupe_key ?? null,
        source_channel: input.source_channel ?? 'web',
        is_final_decision: input.is_final_decision ?? false,
      };

      // ── 5. DB INSERT ──────────────────────────────────────────────────────
      const insertResult = await client.query<{ recorded_at: Date }>(
        `
        INSERT INTO events (
          event_id, object_type, object_id, object_seq_no,
          event_name, from_state, to_state,
          actor_type, actor_id, actor_role,
          decision_role, exception_closed_by_role,
          reason_code, payload_json, payload_schema_version,
          severity, sla_started_at,
          occurred_at, recorded_at,
          caused_by_event_id, correlation_id, revision_no,
          external_event_id, dedupe_key, source_channel,
          is_final_decision
        ) VALUES (
          $1,  $2,  $3,  $4,
          $5,  $6,  $7,
          $8,  $9,  $10,
          $11, $12,
          $13, $14, $15,
          $16, $17,
          $18, NOW(),
          $19, $20, $21,
          $22, $23, $24,
          $25
        )
        RETURNING recorded_at
        `,
        [
          eventRecord.event_id,
          eventRecord.object_type,
          eventRecord.object_id,
          eventRecord.object_seq_no,
          eventRecord.event_name,
          eventRecord.from_state,
          eventRecord.to_state,
          eventRecord.actor_type,
          eventRecord.actor_id,
          eventRecord.actor_role,
          eventRecord.decision_role,
          eventRecord.exception_closed_by_role,
          eventRecord.reason_code,
          JSON.stringify(eventRecord.payload_json),
          eventRecord.payload_schema_version,
          eventRecord.severity,
          eventRecord.sla_started_at,
          eventRecord.occurred_at,
          eventRecord.caused_by_event_id,
          eventRecord.correlation_id,
          eventRecord.revision_no,
          eventRecord.external_event_id,
          eventRecord.dedupe_key,
          eventRecord.source_channel,
          eventRecord.is_final_decision,
        ]
      );

      await client.query('COMMIT');

      const result: AppendEventResult = {
        event_id: eventId,
        object_seq_no: seqNo,
        recorded_at: insertResult.rows[0].recorded_at,
      };

      // ── 6. Projector 비동기 dispatch ─────────────────────────────────────
      // current projection 갱신은 projector가 처리.
      // appendEvent는 저장 후 dispatch만 한다 (직접 갱신 금지).
      const fullEvent: EventRecord = {
        ...eventRecord,
        recorded_at: result.recorded_at,
      };
      this.projectorDispatcher.dispatch(fullEvent).catch((err) => {
        // projector 실패는 appendEvent 결과에 영향 없음
        // reconciliation job이 나중에 복구
        console.error('[ProjectorDispatcher] dispatch 실패:', err);
      });

      return result;
    } catch (error) {
      await client.query('ROLLBACK');

      // 외부 이벤트 ID 중복 (unique constraint violation)
      if (
        error instanceof Error &&
        error.message.includes('events_external_id_unique')
      ) {
        throw new EventCoreError(
          `이미 처리된 외부 이벤트입니다: ${input.external_event_id}`,
          EventCoreErrorCode.DUPLICATE_EXTERNAL_EVENT,
          { external_event_id: input.external_event_id }
        );
      }

      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 외부 이벤트 ID 멱등성 확인.
   * 이미 저장된 이벤트가 있으면 해당 결과 반환 (재처리 방지).
   */
  private async checkExternalEventIdempotency(
    client: PoolClient,
    sourceChannel: string,
    externalEventId: string
  ): Promise<AppendEventResult | null> {
    const result = await client.query<{
      event_id: string;
      object_seq_no: string;
      recorded_at: Date;
    }>(
      `SELECT event_id, object_seq_no, recorded_at
       FROM events
       WHERE source_channel = $1 AND external_event_id = $2
       LIMIT 1`,
      [sourceChannel, externalEventId]
    );

    if (!result.rows[0]) return null;

    return {
      event_id: result.rows[0].event_id,
      object_seq_no: parseInt(result.rows[0].object_seq_no, 10),
      recorded_at: result.rows[0].recorded_at,
    };
  }

  /**
   * 객체의 전체 이벤트 이력 조회 (replay용).
   * seq_no 오름차순으로 반환.
   */
  async getEventHistory(
    objectType: string,
    objectId: string,
    fromSeqNo = 1
  ): Promise<EventRecord[]> {
    const result = await this.pool.query<EventRecord>(
      `SELECT * FROM events
       WHERE object_type = $1 AND object_id = $2
         AND object_seq_no >= $3
       ORDER BY object_seq_no ASC`,
      [objectType, objectId, fromSeqNo]
    );
    return result.rows;
  }
}
