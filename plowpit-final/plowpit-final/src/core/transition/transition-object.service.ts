// =============================================================================
// src/core/transition/transition-object.service.ts
// 티켓 7: transitionObject 서비스
// 티켓 8: System/AI 전이 한계 검증 (통합 구현)
// 원칙:
//   - 모든 상태 전이는 transitionObject만 통해 발생
//   - 전이 성공 시 appendEvent만 한다. current는 projector가 만든다.
//   - UI에서 current state 직접 수정 금지
//   - is_final_decision 오용 차단
//   - 상태 전이가 레지스트리 밖으로 못 나감
// =============================================================================

import { Pool } from 'pg';
import {
  TransitionObjectInput,
  AppendEventResult,
  EventCoreError,
  EventCoreErrorCode,
  ActorType,
} from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';
import { PermissionService, SYSTEM_ALLOWED_EVENTS, AI_ALLOWED_EVENTS } from './permission.service';
import { TransitionRegistry, TERMINAL_STATES } from './transition-registry';

// ── System이 절대 수행하면 안 되는 이벤트 (하드 블랙리스트) ──────────────────
const SYSTEM_FORBIDDEN_EVENTS = new Set<string>([
  'quote_approved',
  'quote_sent',
  'order_registered',
  'inventory_confirmed',
  'shipment_completed',
  'exception_closed_completed',
  'exception_closed_cancelled',
  // 승인 관련
  'quote_submitted_for_approval',
  // 모든 closed_* 이벤트
]);

// ── AI가 절대 수행하면 안 되는 이벤트 (하드 블랙리스트) ──────────────────────
const AI_FORBIDDEN_EVENTS = new Set<string>([
  'quote_approved',
  'quote_sent',
  'order_registered',
  'inventory_confirmed',
  'shipment_completed',
  'exception_closed_completed',
  'exception_closed_cancelled',
  'quote_submitted_for_approval',
  'order_draft_created',
]);

export class TransitionObjectService {
  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService,
    private readonly permissionService: PermissionService,
    private readonly transitionRegistry: TransitionRegistry
  ) {}

  /**
   * 상태 전이의 단일 진입점.
   *
   * 실행 순서:
   * 1. System/AI 하드 블랙리스트 검증 (티켓 8)
   * 2. is_final_decision 오용 검증
   * 3. 상태 전이 레지스트리 검증
   * 4. 현재 상태 조회 (DB에서 확인)
   * 5. from_state 검증
   * 6. 권한 검증
   * 7. reason_code 필수 여부 검증
   * 8. appendEvent 호출 (current 갱신은 projector가 담당)
   */
  async transition(input: TransitionObjectInput): Promise<AppendEventResult> {

    // ── 1. System/AI 하드 블랙리스트 (티켓 8) ────────────────────────────
    this.enforceSystemAILimit(input.actor_type, input.event_name);

    // ── 2. is_final_decision 오용 검증 ───────────────────────────────────
    // 레지스트리에 등록된 is_final_decision과 입력값이 일치해야 함
    const transitionDef = this.transitionRegistry.getTransition(
      input.object_type,
      input.event_name
    );

    if (input.is_final_decision === true && !transitionDef.is_final_decision) {
      throw new EventCoreError(
        `이벤트(${input.event_name})는 final decision 이벤트가 아님. ` +
        `is_final_decision = true 설정 불가.`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { event_name: input.event_name }
      );
    }

    // is_final_decision은 레지스트리 정의를 따름 (입력값 override 허용 안 함)
    const effectiveIsFinalDecision = transitionDef.is_final_decision;

    // ── 3. 현재 상태 조회 ─────────────────────────────────────────────────
    const currentState = await this.getCurrentState(
      input.object_type,
      input.object_id
    );

    // ── 4. 전이 유효성 검증 (레지스트리) ─────────────────────────────────
    this.transitionRegistry.validateTransition(
      input.object_type,
      input.event_name,
      currentState
    );

    // from_state 일치 검증 (입력값과 실제 DB 상태)
    if (input.from_state && currentState && input.from_state !== currentState) {
      throw new EventCoreError(
        `from_state 불일치. 입력: ${input.from_state}, 실제: ${currentState}`,
        EventCoreErrorCode.INVALID_FROM_STATE,
        { input_from_state: input.from_state, actual_state: currentState }
      );
    }

    // ── 5. 권한 검증 ──────────────────────────────────────────────────────
    await this.permissionService.checkTransitionPermission(
      {
        actor_type: input.actor_type,
        actor_id: input.actor_id,
        actor_role: input.actor_role,
      },
      input.object_type,
      input.event_name,
      effectiveIsFinalDecision,
      transitionDef.allowed_roles
    );

    // ── 6. reason_code 필수 여부 검증 ─────────────────────────────────────
    if (transitionDef.requires_reason && !input.reason_code) {
      throw new EventCoreError(
        `이벤트(${input.event_name})는 reason_code 필수`,
        EventCoreErrorCode.MISSING_REQUIRED_FIELD,
        { event_name: input.event_name }
      );
    }

    // ── 7. appendEvent 호출 ───────────────────────────────────────────────
    // transitionObject는 성공 시 appendEvent만 한다.
    // current projection 갱신은 projector가 담당.
    return await this.appendEventService.append({
      object_type: input.object_type,
      object_id: input.object_id,
      event_name: input.event_name,
      from_state: currentState,
      to_state: transitionDef.to_state,
      actor_type: input.actor_type,
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      decision_role: input.decision_role,
      exception_closed_by_role: input.exception_closed_by_role,
      reason_code: input.reason_code,
      payload_json: input.payload_json,
      payload_schema_version: input.payload_schema_version,
      severity: input.severity,
      sla_started_at: input.sla_started_at,
      caused_by_event_id: input.caused_by_event_id,
      correlation_id: input.correlation_id,
      revision_no: input.revision_no ?? 1,
      external_event_id: input.external_event_id,
      dedupe_key: input.dedupe_key,
      source_channel: input.source_channel ?? 'web',
      is_final_decision: effectiveIsFinalDecision,
    });
  }

  /**
   * 티켓 8: System/AI 하드 블랙리스트 강제 적용.
   * is_final_decision 여부와 무관하게 event_name으로 직접 차단.
   */
  private enforceSystemAILimit(actorType: ActorType, eventName: string): void {
    if (actorType === 'system') {
      if (SYSTEM_FORBIDDEN_EVENTS.has(eventName)) {
        throw new EventCoreError(
          `System actor는 이 이벤트를 수행할 수 없음: ${eventName}. ` +
          `System 금지 이벤트 목록: approval, shipment_complete, exception_close 등.`,
          EventCoreErrorCode.SYSTEM_FINAL_DECISION_FORBIDDEN,
          { event_name: eventName, forbidden_list: [...SYSTEM_FORBIDDEN_EVENTS] }
        );
      }
      // System 화이트리스트에 없으면 추가 경고 (퍼미션 레이어에서도 차단됨)
    }

    if (actorType === 'ai') {
      if (AI_FORBIDDEN_EVENTS.has(eventName)) {
        throw new EventCoreError(
          `AI actor는 이 이벤트를 수행할 수 없음: ${eventName}. ` +
          `AI는 파싱/초안/분류/플래그만 가능.`,
          EventCoreErrorCode.AI_FINAL_DECISION_FORBIDDEN,
          { event_name: eventName }
        );
      }

      // AI 화이트리스트에도 없으면 차단
      if (!AI_ALLOWED_EVENTS.has(eventName)) {
        throw new EventCoreError(
          `AI actor에게 허용되지 않은 이벤트: ${eventName}`,
          EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
          { event_name: eventName, allowed_events: [...AI_ALLOWED_EVENTS] }
        );
      }
    }
  }

  /**
   * 현재 상태 조회.
   * current projection 테이블에서 읽음.
   * projection이 없으면 (첫 생성) null 반환.
   */
  private async getCurrentState(
    objectType: string,
    objectId: string
  ): Promise<string | null> {
    const tableMap: Record<string, { table: string; idCol: string }> = {
      inquiry:   { table: 'inquiries',           idCol: 'inquiry_id' },
      quote:     { table: 'quotes',              idCol: 'quote_id' },
      order:     { table: 'orders',              idCol: 'order_id' },
      shipment:  { table: 'shipments',           idCol: 'shipment_id' },
      exception: { table: 'exceptions',          idCol: 'exception_id' },
      task:      { table: 'tasks',               idCol: 'task_id' },
      inventory: { table: 'inventory_snapshots', idCol: 'snapshot_id' },
    };

    const mapping = tableMap[objectType];
    if (!mapping) {
      throw new EventCoreError(
        `알 수 없는 object_type: ${objectType}`,
        EventCoreErrorCode.INVALID_TRANSITION
      );
    }

    const result = await this.pool.query<{ current_state: string }>(
      `SELECT current_state FROM ${mapping.table}
       WHERE ${mapping.idCol} = $1`,
      [objectId]
    );

    return result.rows[0]?.current_state ?? null;
  }

  /**
   * 직접 상태 변경 시도 감지 및 차단.
   * 외부에서 current table을 직접 수정하려는 경우 차단.
   * (실제로는 DB 트리거가 주 방어선이지만, 서비스 레이어에서도 방어)
   */
  assertNoDirectUpdate(): never {
    throw new EventCoreError(
      '직접 상태 수정 금지. transitionObject()를 사용하세요.',
      EventCoreErrorCode.DIRECT_UPDATE_FORBIDDEN
    );
  }
}
