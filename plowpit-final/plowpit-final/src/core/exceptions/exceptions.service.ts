// =============================================================================
// src/core/exceptions/exceptions.service.ts
// 티켓 9: Exceptions Core
// 티켓 10: Revision / Cancel / Reopen
// 원칙:
//   - 예외는 별도 객체. 본 객체에 흡수 금지.
//   - 예외 종료: ExceptionReviewer만
//   - 수정/취소/재개는 overwrite 없이 처리
//   - revision_no 증가, 기존 객체 ID 유지
//   - closed_* 상태 direct restore 금지
//   - 취소는 삭제가 아니라 이벤트
// =============================================================================

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  ObjectType,
  SeverityLevel,
  AppendEventResult,
  EventCoreError,
  EventCoreErrorCode,
} from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';
import { TransitionObjectService } from '../transition/transition-object.service';
import { PermissionService } from '../transition/permission.service';
import { TransitionRegistry } from '../transition/transition-registry';

// ── 예외 생성 입력 ─────────────────────────────────────────────────────────────
export interface CreateExceptionInput {
  target_object_type: ObjectType;
  target_object_id: string;
  target_event_id?: string;
  exception_type: ExceptionType;
  severity: SeverityLevel;
  reason_code?: string;
  description?: string;
  assigned_role?: string;
  assigned_to?: string;
  sla_due_at?: Date;
  correlation_id?: string;
  caused_by_event_id?: string;
  // 예외 생성 행위자
  actor_id: string;
  actor_role: string;
  actor_type: 'user' | 'system' | 'ai';
  // AI 분류 추천 (참고용)
  ai_suggested_type?: string;
  ai_suggested_priority?: string;
}

export type ExceptionType =
  | 'duplicate_input'
  | 'revision_request'
  | 'cancel_request'
  | 'resubmit'
  | 'partial_shipment'
  | 'inventory_recheck'
  | 'approval_rejected'
  | 'due_date_change'
  | 'external_system_resend'
  | 'manual_override_attempt'
  | 'unconfirmed_customer'
  | 'item_code_mismatch'
  | 'approval_missing'
  | 'shipment_instruction_conflict';

// ── SLA 기본값 (분 단위) ─────────────────────────────────────────────────────
const DEFAULT_SLA_MINUTES: Record<string, Record<SeverityLevel, number>> = {
  'manual_override_attempt':       { low: 60, medium: 30, high: 15, blocking: 5 },
  'approval_missing':              { low: 120, medium: 60, high: 30, blocking: 10 },
  'shipment_instruction_conflict': { low: 60, medium: 30, high: 15, blocking: 5 },
  'inventory_recheck':             { low: 240, medium: 120, high: 60, blocking: 15 },
  'default':                       { low: 480, medium: 240, high: 120, blocking: 30 },
};

export class ExceptionsService {
  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService,
    private readonly transitionObjectService: TransitionObjectService,
    private readonly permissionService: PermissionService
  ) {}

  // ── 예외 생성 ──────────────────────────────────────────────────────────────
  /**
   * 예외를 별도 객체로 생성.
   * target 객체와 참조 연결 포함.
   * 예외는 본 객체의 상태에 흡수되지 않는다.
   */
  async createException(
    input: CreateExceptionInput
  ): Promise<{ exception_id: string; event_result: AppendEventResult }> {

    const exceptionId = uuidv4();
    const slaMinutes =
      DEFAULT_SLA_MINUTES[input.exception_type]?.[input.severity] ??
      DEFAULT_SLA_MINUTES['default'][input.severity];
    const slaDueAt =
      input.sla_due_at ??
      new Date(Date.now() + slaMinutes * 60 * 1000);

    // ── 1. exception projection 레코드 생성 ───────────────────────────────
    await this.pool.query(
      `
      INSERT INTO exceptions (
        exception_id, correlation_id,
        target_object_type, target_object_id, target_event_id,
        exception_type, severity, reason_code, description,
        assigned_role, assigned_to,
        sla_started_at, sla_due_at,
        ai_suggested_type, ai_suggested_priority,
        current_state
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, NOW(), $12, $13, $14, 'created'
      )
      `,
      [
        exceptionId,
        input.correlation_id ?? null,
        input.target_object_type,
        input.target_object_id,
        input.target_event_id ?? null,
        input.exception_type,
        input.severity,
        input.reason_code ?? null,
        input.description ?? null,
        input.assigned_role ?? 'ExceptionReviewer',
        input.assigned_to ?? null,
        slaDueAt,
        input.ai_suggested_type ?? null,
        input.ai_suggested_priority ?? null,
      ]
    );

    // ── 2. exception_created 이벤트 append ────────────────────────────────
    const eventResult = await this.appendEventService.append({
      object_type: 'exception',
      object_id: exceptionId,
      event_name: 'exception_created',
      from_state: null,
      to_state: 'created',
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      reason_code: input.reason_code,
      payload_json: {
        exception_type: input.exception_type,
        target_object_type: input.target_object_type,
        target_object_id: input.target_object_id,
        target_event_id: input.target_event_id,
        description: input.description,
        ai_suggested_type: input.ai_suggested_type,
        sla_due_at: slaDueAt.toISOString(),
      },
      payload_schema_version: 'v1',
      severity: input.severity,
      sla_started_at: new Date(),
      correlation_id: input.correlation_id,
      caused_by_event_id: input.caused_by_event_id,
      is_final_decision: false,
      source_channel: 'system',
    });

    // ── 3. object_links로 본 객체와 참조 연결 ────────────────────────────
    await this.pool.query(
      `
      INSERT INTO object_links (
        source_object_type, source_object_id,
        target_object_type, target_object_id,
        link_type, created_by_event_id, correlation_id
      ) VALUES ($1, $2, $3, $4, 'target_to_exception', $5, $6)
      ON CONFLICT DO NOTHING
      `,
      [
        input.target_object_type,
        input.target_object_id,
        'exception',
        exceptionId,
        eventResult.event_id,
        input.correlation_id ?? null,
      ]
    );

    return { exception_id: exceptionId, event_result: eventResult };
  }

  // ── Revision (수정) ─────────────────────────────────────────────────────────
  /**
   * Quote/Order 수정.
   * 원칙: 삭제가 아니라 revision 증가. 원본 ID 유지.
   */
  async requestRevision(params: {
    object_type: 'quote' | 'order';
    object_id: string;
    actor_id: string;
    actor_role: string;
    reason_code: string;
    changes: Record<string, unknown>;
    correlation_id?: string;
    caused_by_event_id?: string;
  }): Promise<AppendEventResult> {

    // 현재 revision_no 조회
    const currentRevNo = await this.getCurrentRevisionNo(
      params.object_type,
      params.object_id
    );
    const newRevNo = currentRevNo + 1;

    const eventName =
      params.object_type === 'quote'
        ? 'quote_revision_requested'
        : 'order_revision_requested';

    return await this.transitionObjectService.transition({
      object_type: params.object_type,
      object_id: params.object_id,
      event_name: eventName,
      from_state: '',  // transitionObject 내부에서 실제 상태 조회
      to_state: 'revision_requested',
      actor_type: 'user',
      actor_id: params.actor_id,
      actor_role: params.actor_role,
      reason_code: params.reason_code,
      payload_json: { changes: params.changes, new_revision_no: newRevNo },
      payload_schema_version: 'v1',
      revision_no: newRevNo,
      correlation_id: params.correlation_id,
      caused_by_event_id: params.caused_by_event_id,
      is_final_decision: false,
    });
  }

  // ── Cancel (취소) ─────────────────────────────────────────────────────────
  /**
   * 객체 취소.
   * 원칙: 삭제가 아니라 취소 상태 전이 + 이벤트 기록.
   * closed_* direct restore 금지.
   */
  async cancel(params: {
    object_type: ObjectType;
    object_id: string;
    actor_id: string;
    actor_role: string;
    reason_code: string;
    correlation_id?: string;
    caused_by_event_id?: string;
  }): Promise<AppendEventResult> {

    const cancelEventMap: Partial<Record<ObjectType, string>> = {
      inquiry:   'inquiry_cancelled',
      quote:     'quote_cancelled',
      order:     'order_cancelled',
      shipment:  'shipment_cancelled',
      exception: 'exception_closed_cancelled',
    };

    const eventName = cancelEventMap[params.object_type];
    if (!eventName) {
      throw new EventCoreError(
        `취소 불가한 object_type: ${params.object_type}`,
        EventCoreErrorCode.INVALID_TRANSITION
      );
    }

    return await this.transitionObjectService.transition({
      object_type: params.object_type,
      object_id: params.object_id,
      event_name: eventName,
      from_state: '',
      to_state: 'closed_cancelled',
      actor_type: 'user',
      actor_id: params.actor_id,
      actor_role: params.actor_role,
      reason_code: params.reason_code,
      payload_json: {},
      payload_schema_version: 'v1',
      correlation_id: params.correlation_id,
      caused_by_event_id: params.caused_by_event_id,
      is_final_decision: true,
    });
  }

  // ── Reopen (재열기) ────────────────────────────────────────────────────────
  /**
   * 객체 재열기.
   * 원칙:
   *   - 하위 객체 영향이 없고 정정 비용이 낮을 때만 허용
   *   - 하위 객체가 생성되었거나 완료 영향이 있으면 신규 객체/별도 예외 우선
   *   - closed_* 상태 direct restore 금지 (이벤트로 처리)
   */
  async reopen(params: {
    object_type: ObjectType;
    object_id: string;
    actor_id: string;
    actor_role: string;
    reason_code: string;
    correlation_id?: string;
  }): Promise<AppendEventResult> {

    // reopen 전 하위 객체 존재 확인
    await this.assertNoChildObjects(params.object_type, params.object_id);

    const reopenEventMap: Partial<Record<ObjectType, string>> = {
      inquiry: 'inquiry_reopened',
      quote:   'quote_reopened',
    };

    const eventName = reopenEventMap[params.object_type];
    if (!eventName) {
      throw new EventCoreError(
        `재열기 불가한 object_type: ${params.object_type}. ` +
        `하위 객체가 생성된 경우 신규 객체 또는 별도 예외를 우선하세요.`,
        EventCoreErrorCode.REOPEN_NOT_ALLOWED,
        { object_type: params.object_type }
      );
    }

    return await this.transitionObjectService.transition({
      object_type: params.object_type,
      object_id: params.object_id,
      event_name: eventName,
      from_state: '',
      to_state: 'received',
      actor_type: 'user',
      actor_id: params.actor_id,
      actor_role: params.actor_role,
      reason_code: params.reason_code,
      payload_json: { reopen_reason: params.reason_code },
      payload_schema_version: 'v1',
      correlation_id: params.correlation_id,
      is_final_decision: false,
    });
  }

  // ── Exception 종료 ────────────────────────────────────────────────────────
  /**
   * 예외 종료.
   * ExceptionReviewer 또는 정책상 위임된 권한자만 가능.
   * 업무 판단자와 예외 종료자를 구분.
   */
  async closeException(params: {
    exception_id: string;
    actor_id: string;
    actor_role: string;
    resolution: 'completed' | 'cancelled';
    reason_code: string;
    resolution_notes?: string;
    correlation_id?: string;
  }): Promise<AppendEventResult> {

    // 예외 종료 권한 확인 (ExceptionReviewer만)
    await this.permissionService.checkExceptionClosePermission(
      params.actor_role,
      'exception'
    );

    const eventName =
      params.resolution === 'completed'
        ? 'exception_closed_completed'
        : 'exception_closed_cancelled';

    return await this.transitionObjectService.transition({
      object_type: 'exception',
      object_id: params.exception_id,
      event_name: eventName,
      from_state: '',
      to_state: `closed_${params.resolution}`,
      actor_type: 'user',
      actor_id: params.actor_id,
      actor_role: params.actor_role,
      exception_closed_by_role: params.actor_role,
      reason_code: params.reason_code,
      payload_json: { resolution_notes: params.resolution_notes },
      payload_schema_version: 'v1',
      correlation_id: params.correlation_id,
      is_final_decision: true,
    });
  }

  // ── 헬퍼 메서드 ───────────────────────────────────────────────────────────

  private async getCurrentRevisionNo(
    objectType: 'quote' | 'order',
    objectId: string
  ): Promise<number> {
    const tableMap = {
      quote: { table: 'quotes',  idCol: 'quote_id' },
      order: { table: 'orders',  idCol: 'order_id' },
    };
    const mapping = tableMap[objectType];

    const result = await this.pool.query<{ current_revision_no: number }>(
      `SELECT current_revision_no FROM ${mapping.table}
       WHERE ${mapping.idCol} = $1`,
      [objectId]
    );

    return result.rows[0]?.current_revision_no ?? 1;
  }

  /**
   * reopen 전 하위 객체 존재 확인.
   * 하위 객체가 있으면 reopen 차단.
   */
  private async assertNoChildObjects(
    objectType: ObjectType,
    objectId: string
  ): Promise<void> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM object_links
       WHERE source_object_type = $1
         AND source_object_id = $2
         AND link_type NOT IN ('target_to_exception')`,
      [objectType, objectId]
    );

    const count = parseInt(result.rows[0]?.count ?? '0', 10);
    if (count > 0) {
      throw new EventCoreError(
        `reopen 불가: 하위 객체가 존재함 (${count}개). ` +
        `신규 객체 생성 또는 별도 예외를 우선하세요.`,
        EventCoreErrorCode.REOPEN_NOT_ALLOWED,
        { object_type: objectType, object_id: objectId, child_count: count }
      );
    }
  }
}
