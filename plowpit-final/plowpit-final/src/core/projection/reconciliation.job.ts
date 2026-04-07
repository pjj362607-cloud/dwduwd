// =============================================================================
// src/core/projection/reconciliation.job.ts
// 티켓 13: Projection Reconciliation Job
// 원칙:
//   - event 기준으로 current를 복구
//   - 수동 SQL로 current 보정 금지
//   - current만 고치고 event 무시 금지
//   - current/event 불일치 탐지 및 복구
//   - 특정 객체만 재투영 가능
//
// 진행 프로토콜 (출처: NemoClaw runner.py — PROGRESS/RUN_ID 패턴):
//   PROGRESS:<0-100>:<label>  → 진행 상황 보고
//   RUN_ID:<id>               → 실행 ID 발행
//   이 프로토콜을 유지하면 외부 모니터링/CLI에서 진행률 파싱 가능
// =============================================================================

import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  InquiryProjector,
  QuoteProjector,
  OrderProjector,
  ShipmentProjector,
  ExceptionProjector,
} from './projectors/index';
import { ObjectType } from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';

export interface ReconciliationResult {
  run_id: string;
  object_type: ObjectType;
  total_objects: number;
  inconsistent_found: number;
  replayed: number;
  errors: Array<{ object_id: string; error: string }>;
  duration_ms: number;
}

export interface InconsistencyReport {
  object_type: ObjectType;
  object_id: string;
  current_state_in_projection: string | null;
  expected_state_from_events: string | null;
  last_event_id_in_projection: string | null;
  latest_event_id_actual: string | null;
  mismatch_type: 'state_mismatch' | 'event_id_mismatch' | 'missing_projection';
}

// ── Projection 테이블 매핑 ─────────────────────────────────────────────────────
const PROJECTION_TABLE_MAP: Record<
  string,
  { table: string; idCol: string }
> = {
  inquiry:   { table: 'inquiries',  idCol: 'inquiry_id' },
  quote:     { table: 'quotes',     idCol: 'quote_id' },
  order:     { table: 'orders',     idCol: 'order_id' },
  shipment:  { table: 'shipments',  idCol: 'shipment_id' },
  exception: { table: 'exceptions', idCol: 'exception_id' },
};

// ── NemoClaw runner.py 프로토콜 유틸리티 ──────────────────────────────────────
// 출처: NemoClaw orchestrator/runner.py — log(), progress(), emit_run_id()

function emitRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const rid = `rc-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  console.log(`RUN_ID:${rid}`);
  return rid;
}

function emitProgress(pct: number, label: string): void {
  console.log(`PROGRESS:${pct}:${label}`);
}

export class ReconciliationJob {
  private readonly projectors: Map<ObjectType, {
    replay: (objectId: string) => Promise<void>;
  }>;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService,
    inquiryProjector: InquiryProjector,
    quoteProjector: QuoteProjector,
    orderProjector: OrderProjector,
    shipmentProjector: ShipmentProjector,
    exceptionProjector: ExceptionProjector
  ) {
    this.projectors = new Map([
      ['inquiry',   inquiryProjector],
      ['quote',     quoteProjector],
      ['order',     orderProjector],
      ['shipment',  shipmentProjector],
      ['exception', exceptionProjector],
    ]);
  }

  // ── 단일 객체 재투영 ─────────────────────────────────────────────────────────
  async replayObject(
    objectType: ObjectType,
    objectId: string
  ): Promise<void> {
    const projector = this.projectors.get(objectType);
    if (!projector) {
      throw new Error(`projector 미등록: ${objectType}`);
    }
    await projector.replay(objectId);
  }

  // ── 전체 object_type 재투영 (PROGRESS 프로토콜 포함) ──────────────────────────
  async replayAll(objectType: ObjectType): Promise<ReconciliationResult> {
    const runId = emitRunId();
    const start = Date.now();
    emitProgress(0, `${objectType} 재투영 시작`);

    const result: ReconciliationResult = {
      run_id: runId,
      object_type: objectType,
      total_objects: 0,
      inconsistent_found: 0,
      replayed: 0,
      errors: [],
      duration_ms: 0,
    };

    const objectIds = await this.pool.query<{ object_id: string }>(
      `SELECT DISTINCT object_id FROM events
       WHERE object_type = $1
       ORDER BY object_id`,
      [objectType]
    );

    result.total_objects = objectIds.rows.length;
    emitProgress(10, `${result.total_objects}개 객체 발견`);

    for (let i = 0; i < objectIds.rows.length; i++) {
      const { object_id } = objectIds.rows[i];
      const pct = Math.floor(10 + (i / result.total_objects) * 85);
      emitProgress(pct, `재투영 중: ${object_id.slice(0, 8)}...`);

      try {
        await this.replayObject(objectType, object_id);
        result.replayed++;
      } catch (error) {
        result.errors.push({
          object_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.duration_ms = Date.now() - start;
    emitProgress(100, `완료: ${result.replayed}개 재투영, ${result.errors.length}개 오류`);
    return result;
  }

  // ── 불일치 탐지 ──────────────────────────────────────────────────────────────
  async detectInconsistencies(
    objectType: ObjectType
  ): Promise<InconsistencyReport[]> {
    const mapping = PROJECTION_TABLE_MAP[objectType];
    if (!mapping) throw new Error(`projection 매핑 없음: ${objectType}`);

    const reports: InconsistencyReport[] = [];

    // 1. event는 있지만 projection이 없는 객체
    const missingProjections = await this.pool.query<{ object_id: string }>(
      `SELECT DISTINCT e.object_id
       FROM events e
       LEFT JOIN ${mapping.table} p ON p.${mapping.idCol} = e.object_id
       WHERE e.object_type = $1 AND p.${mapping.idCol} IS NULL`,
      [objectType]
    );

    for (const row of missingProjections.rows) {
      reports.push({
        object_type: objectType,
        object_id: row.object_id,
        current_state_in_projection: null,
        expected_state_from_events: null,
        last_event_id_in_projection: null,
        latest_event_id_actual: null,
        mismatch_type: 'missing_projection',
      });
    }

    // 2. last_projected_event_id가 최신 이벤트와 다른 객체
    const staleProjections = await this.pool.query<{
      object_id: string;
      current_state: string;
      last_projected_event_id: string | null;
      latest_event_id: string;
      latest_to_state: string | null;
    }>(
      `SELECT
         p.${mapping.idCol} AS object_id,
         p.current_state,
         p.last_projected_event_id,
         latest_e.event_id AS latest_event_id,
         latest_e.to_state AS latest_to_state
       FROM ${mapping.table} p
       JOIN LATERAL (
         SELECT event_id, to_state
         FROM events
         WHERE object_type = $1 AND object_id = p.${mapping.idCol}
         ORDER BY object_seq_no DESC
         LIMIT 1
       ) latest_e ON TRUE
       WHERE p.last_projected_event_id IS DISTINCT FROM latest_e.event_id`,
      [objectType]
    );

    for (const row of staleProjections.rows) {
      reports.push({
        object_type: objectType,
        object_id: row.object_id,
        current_state_in_projection: row.current_state,
        expected_state_from_events: row.latest_to_state,
        last_event_id_in_projection: row.last_projected_event_id,
        latest_event_id_actual: row.latest_event_id,
        mismatch_type:
          row.current_state !== row.latest_to_state
            ? 'state_mismatch'
            : 'event_id_mismatch',
      });
    }

    return reports;
  }

  // ── 불일치 감지 + 자동 재투영 (PROGRESS 프로토콜 포함) ────────────────────────
  async detectAndReconcile(objectType: ObjectType): Promise<ReconciliationResult> {
    const runId = emitRunId();
    const start = Date.now();
    emitProgress(0, `${objectType} 불일치 탐지 시작`);

    const inconsistencies = await this.detectInconsistencies(objectType);
    emitProgress(30, `불일치 ${inconsistencies.length}개 발견`);

    const result: ReconciliationResult = {
      run_id: runId,
      object_type: objectType,
      total_objects: inconsistencies.length,
      inconsistent_found: inconsistencies.length,
      replayed: 0,
      errors: [],
      duration_ms: 0,
    };

    for (let i = 0; i < inconsistencies.length; i++) {
      const { object_id } = inconsistencies[i];
      const pct = Math.floor(30 + (i / Math.max(inconsistencies.length, 1)) * 65);
      emitProgress(pct, `재투영: ${object_id.slice(0, 8)}...`);

      try {
        await this.replayObject(objectType, object_id);
        result.replayed++;
      } catch (error) {
        result.errors.push({
          object_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.duration_ms = Date.now() - start;
    emitProgress(100, `완료: ${result.replayed}개 재투영`);
    return result;
  }

  // ── seq_no 정합성 검증 ────────────────────────────────────────────────────────
  async detectSeqInconsistencies(objectType: ObjectType): Promise<Array<{
    object_id: string;
    counter_seq: number;
    max_event_seq: number;
  }>> {
    const result = await this.pool.query<{
      object_id: string;
      counter_seq: string;
      max_event_seq: string;
    }>(
      `SELECT
         c.object_id,
         c.last_seq_no AS counter_seq,
         MAX(e.object_seq_no) AS max_event_seq
       FROM object_seq_counters c
       LEFT JOIN events e
         ON e.object_type = c.object_type AND e.object_id = c.object_id
       WHERE c.object_type = $1
       GROUP BY c.object_id, c.last_seq_no
       HAVING c.last_seq_no != COALESCE(MAX(e.object_seq_no), 0)`,
      [objectType]
    );

    return result.rows.map((r) => ({
      object_id: r.object_id,
      counter_seq: parseInt(r.counter_seq, 10),
      max_event_seq: parseInt(r.max_event_seq ?? '0', 10),
    }));
  }
}


import { Pool } from 'pg';
import {
  InquiryProjector,
  QuoteProjector,
  OrderProjector,
  ShipmentProjector,
  ExceptionProjector,
} from './projectors/index';
import { ObjectType } from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';

export interface ReconciliationResult {
  object_type: ObjectType;
  total_objects: number;
  inconsistent_found: number;
  replayed: number;
  errors: Array<{ object_id: string; error: string }>;
  duration_ms: number;
}

export interface InconsistencyReport {
  object_type: ObjectType;
  object_id: string;
  current_state_in_projection: string | null;
  expected_state_from_events: string | null;
  last_event_id_in_projection: string | null;
  latest_event_id_actual: string | null;
  mismatch_type: 'state_mismatch' | 'event_id_mismatch' | 'missing_projection';
}

// ── Projection 테이블 매핑 ─────────────────────────────────────────────────────
const PROJECTION_TABLE_MAP: Record<
  string,
  { table: string; idCol: string }
> = {
  inquiry:   { table: 'inquiries',  idCol: 'inquiry_id' },
  quote:     { table: 'quotes',     idCol: 'quote_id' },
  order:     { table: 'orders',     idCol: 'order_id' },
  shipment:  { table: 'shipments',  idCol: 'shipment_id' },
  exception: { table: 'exceptions', idCol: 'exception_id' },
};

export class ReconciliationJob {
  private readonly projectors: Map<ObjectType, {
    replay: (objectId: string) => Promise<void>;
  }>;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService,
    inquiryProjector: InquiryProjector,
    quoteProjector: QuoteProjector,
    orderProjector: OrderProjector,
    shipmentProjector: ShipmentProjector,
    exceptionProjector: ExceptionProjector
  ) {
    this.projectors = new Map([
      ['inquiry',   inquiryProjector],
      ['quote',     quoteProjector],
      ['order',     orderProjector],
      ['shipment',  shipmentProjector],
      ['exception', exceptionProjector],
    ]);
  }

  // ── 단일 객체 재투영 ─────────────────────────────────────────────────────────
  /**
   * 특정 객체 하나를 event 기준으로 재투영.
   * 운영자가 수동 SQL 없이 복구 가능.
   */
  async replayObject(
    objectType: ObjectType,
    objectId: string
  ): Promise<void> {
    const projector = this.projectors.get(objectType);
    if (!projector) {
      throw new Error(`projector 미등록: ${objectType}`);
    }
    await projector.replay(objectId);
  }

  // ── 전체 object_type 재투영 ──────────────────────────────────────────────────
  /**
   * 특정 object_type의 모든 객체를 재투영.
   * 대량 복구 시 사용.
   */
  async replayAll(objectType: ObjectType): Promise<ReconciliationResult> {
    const start = Date.now();
    const result: ReconciliationResult = {
      object_type: objectType,
      total_objects: 0,
      inconsistent_found: 0,
      replayed: 0,
      errors: [],
      duration_ms: 0,
    };

    // events 테이블에서 해당 object_type의 모든 고유 object_id 조회
    const objectIds = await this.pool.query<{ object_id: string }>(
      `SELECT DISTINCT object_id FROM events
       WHERE object_type = $1
       ORDER BY object_id`,
      [objectType]
    );

    result.total_objects = objectIds.rows.length;

    for (const row of objectIds.rows) {
      try {
        await this.replayObject(objectType, row.object_id);
        result.replayed++;
      } catch (error) {
        result.errors.push({
          object_id: row.object_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.duration_ms = Date.now() - start;
    return result;
  }

  // ── 불일치 탐지 (재투영 없이 탐지만) ─────────────────────────────────────────
  /**
   * current projection과 events 간 불일치 탐지.
   * 탐지만 하고 수정하지 않음 (수동 SQL 보정 금지 원칙).
   * 수정은 replayObject() 또는 replayAll()로만.
   */
  async detectInconsistencies(
    objectType: ObjectType
  ): Promise<InconsistencyReport[]> {
    const mapping = PROJECTION_TABLE_MAP[objectType];
    if (!mapping) {
      throw new Error(`projection 매핑 없음: ${objectType}`);
    }

    const reports: InconsistencyReport[] = [];

    // ── 1. event는 있지만 projection이 없는 객체 ─────────────────────────
    const missingProjections = await this.pool.query<{ object_id: string }>(
      `
      SELECT DISTINCT e.object_id
      FROM events e
      LEFT JOIN ${mapping.table} p ON p.${mapping.idCol} = e.object_id
      WHERE e.object_type = $1
        AND p.${mapping.idCol} IS NULL
      `,
      [objectType]
    );

    for (const row of missingProjections.rows) {
      reports.push({
        object_type: objectType,
        object_id: row.object_id,
        current_state_in_projection: null,
        expected_state_from_events: null,
        last_event_id_in_projection: null,
        latest_event_id_actual: null,
        mismatch_type: 'missing_projection',
      });
    }

    // ── 2. last_projected_event_id가 최신 이벤트와 다른 객체 ─────────────
    const stalProjections = await this.pool.query<{
      object_id: string;
      current_state: string;
      last_projected_event_id: string | null;
      latest_event_id: string;
      latest_to_state: string | null;
    }>(
      `
      SELECT
        p.${mapping.idCol}        AS object_id,
        p.current_state,
        p.last_projected_event_id,
        latest_e.event_id         AS latest_event_id,
        latest_e.to_state         AS latest_to_state
      FROM ${mapping.table} p
      JOIN LATERAL (
        SELECT event_id, to_state
        FROM events
        WHERE object_type = $1 AND object_id = p.${mapping.idCol}
        ORDER BY object_seq_no DESC
        LIMIT 1
      ) latest_e ON TRUE
      WHERE p.last_projected_event_id IS DISTINCT FROM latest_e.event_id
      `,
      [objectType]
    );

    for (const row of stalProjections.rows) {
      const mismatchType =
        row.current_state !== row.latest_to_state
          ? 'state_mismatch'
          : 'event_id_mismatch';

      reports.push({
        object_type: objectType,
        object_id: row.object_id,
        current_state_in_projection: row.current_state,
        expected_state_from_events: row.latest_to_state,
        last_event_id_in_projection: row.last_projected_event_id,
        latest_event_id_actual: row.latest_event_id,
        mismatch_type: mismatchType,
      });
    }

    return reports;
  }

  // ── 불일치 감지 후 자동 재투영 ───────────────────────────────────────────────
  /**
   * 불일치 탐지 + 자동 재투영 통합 실행.
   * 운영자 개입 없이 복구 가능.
   */
  async detectAndReconcile(
    objectType: ObjectType
  ): Promise<ReconciliationResult> {
    const start = Date.now();
    const inconsistencies = await this.detectInconsistencies(objectType);

    const result: ReconciliationResult = {
      object_type: objectType,
      total_objects: inconsistencies.length,
      inconsistent_found: inconsistencies.length,
      replayed: 0,
      errors: [],
      duration_ms: 0,
    };

    for (const report of inconsistencies) {
      try {
        await this.replayObject(objectType, report.object_id);
        result.replayed++;
      } catch (error) {
        result.errors.push({
          object_id: report.object_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    result.duration_ms = Date.now() - start;
    return result;
  }

  // ── seq_no 정합성 검증 ────────────────────────────────────────────────────────
  /**
   * object_seq_counters와 events 테이블의 max seq_no 비교.
   * seq가 꼬인 객체 탐지.
   */
  async detectSeqInconsistencies(objectType: ObjectType): Promise<Array<{
    object_id: string;
    counter_seq: number;
    max_event_seq: number;
  }>> {
    const result = await this.pool.query<{
      object_id: string;
      counter_seq: string;
      max_event_seq: string;
    }>(
      `
      SELECT
        c.object_id,
        c.last_seq_no  AS counter_seq,
        MAX(e.object_seq_no) AS max_event_seq
      FROM object_seq_counters c
      LEFT JOIN events e
        ON e.object_type = c.object_type AND e.object_id = c.object_id
      WHERE c.object_type = $1
      GROUP BY c.object_id, c.last_seq_no
      HAVING c.last_seq_no != COALESCE(MAX(e.object_seq_no), 0)
      `,
      [objectType]
    );

    return result.rows.map((r) => ({
      object_id: r.object_id,
      counter_seq: parseInt(r.counter_seq, 10),
      max_event_seq: parseInt(r.max_event_seq ?? '0', 10),
    }));
  }
}
