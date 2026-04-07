// =============================================================================
// src/core/transition/transition-registry.ts
// 티켓 6: 상태 전이 레지스트리
// 원칙:
//   - 허용 전이를 코드에 고정
//   - 상태표 밖 전이는 모두 차단
//   - 객체 경계를 넘는 상태 전이 금지
//   - Quote 상태에서 Order 상태로 넘어가는 식 혼합 금지
//   - closed_* 종결 상태 규칙 반영
//   - reopen 허용 범위 반영
// =============================================================================

import {
  ObjectType,
  TransitionDefinition,
  EventCoreError,
  EventCoreErrorCode,
} from '../event-store/events.types';

// =============================================================================
// INQUIRY 전이 정의
// states: received | insufficient_info | duplicate_suspected |
//         under_review | closed_cancelled | closed_merged
// =============================================================================
const INQUIRY_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type: 'inquiry',
    event_name: 'inquiry_received',
    from_states: [],           // 최초 진입 (System 자동)
    to_state: 'received',
    allowed_roles: ['Intake', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_marked_insufficient',
    from_states: ['received', 'under_review'],
    to_state: 'insufficient_info',
    allowed_roles: ['Intake', 'System'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_duplicate_flagged',
    from_states: ['received', 'insufficient_info', 'under_review'],
    to_state: 'duplicate_suspected',
    allowed_roles: ['Intake', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_review_started',
    from_states: ['received', 'insufficient_info'],
    to_state: 'under_review',
    allowed_roles: ['Intake'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_reopened',
    from_states: ['insufficient_info'],  // reopen: 하위 객체 없을 때만
    to_state: 'received',
    allowed_roles: ['Intake'],
    is_final_decision: false,
    requires_reason: true,
    preconditions: ['하위 quote 객체가 생성되지 않은 경우에만 허용'],
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_cancelled',
    from_states: ['received', 'insufficient_info', 'under_review', 'duplicate_suspected'],
    to_state: 'closed_cancelled',
    allowed_roles: ['Intake', 'Admin'],
    is_final_decision: true,
    requires_reason: true,
  },
  {
    object_type: 'inquiry',
    event_name: 'inquiry_merged',
    from_states: ['received', 'duplicate_suspected', 'under_review'],
    to_state: 'closed_merged',
    allowed_roles: ['Intake', 'ExceptionReviewer'],
    is_final_decision: true,
    requires_reason: true,
  },
];

// =============================================================================
// QUOTE 전이 정의
// states: drafting | approval_pending | approval_rejected |
//         sent | order_pending | revision_requested | closed_cancelled
// 주의: Quote 상태 안에 Order 상태 혼합 금지
// =============================================================================
const QUOTE_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type: 'quote',
    event_name: 'quote_draft_created',
    from_states: [],           // 최초 생성
    to_state: 'drafting',
    allowed_roles: ['Sales', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'quote',
    event_name: 'quote_submitted_for_approval',
    from_states: ['drafting', 'revision_requested', 'approval_rejected'],
    to_state: 'approval_pending',
    allowed_roles: ['Sales'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'quote',
    event_name: 'quote_approved',
    from_states: ['approval_pending'],
    to_state: 'sent',
    allowed_roles: ['Approver'],
    is_final_decision: true,    // 사업적 최종 확정
    requires_reason: false,
  },
  {
    object_type: 'quote',
    event_name: 'quote_approval_rejected',
    from_states: ['approval_pending'],
    to_state: 'approval_rejected',
    allowed_roles: ['Approver'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'quote',
    event_name: 'quote_sent',
    from_states: ['drafting'],   // 무승인 고객: Sales가 직접 발송
    to_state: 'sent',
    allowed_roles: ['Sales'],
    is_final_decision: true,
    requires_reason: false,
  },
  {
    object_type: 'quote',
    event_name: 'quote_revision_requested',
    from_states: ['sent', 'approval_pending', 'approval_rejected'],
    to_state: 'revision_requested',
    allowed_roles: ['Sales', 'Approver', 'Intake'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'quote',
    event_name: 'quote_order_pending',
    from_states: ['sent'],
    to_state: 'order_pending',
    allowed_roles: ['Sales', 'OrderOps'],
    is_final_decision: false,
    requires_reason: false,
    preconditions: ['Order 생성은 별도 order_draft_created 이벤트로 처리'],
  },
  {
    object_type: 'quote',
    event_name: 'quote_cancelled',
    from_states: ['drafting', 'approval_pending', 'approval_rejected',
                  'sent', 'revision_requested', 'order_pending'],
    to_state: 'closed_cancelled',
    allowed_roles: ['Sales', 'Approver', 'Admin'],
    is_final_decision: true,
    requires_reason: true,
  },
  // Reopen: 하위 객체(Order)가 없고 정정 비용이 낮을 때만
  {
    object_type: 'quote',
    event_name: 'quote_reopened',
    from_states: ['approval_rejected'],
    to_state: 'drafting',
    allowed_roles: ['Sales'],
    is_final_decision: false,
    requires_reason: true,
    preconditions: ['하위 Order가 생성되지 않은 경우에만 허용'],
  },
];

// =============================================================================
// ORDER 전이 정의
// states: registration_pending | duplicate_suspected | registered |
//         inventory_checking | inventory_insufficient | inventory_rechecking |
//         on_hold | closed_cancelled | closed_merged
// =============================================================================
const ORDER_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type: 'order',
    event_name: 'order_draft_created',
    from_states: [],
    to_state: 'registration_pending',
    allowed_roles: ['OrderOps', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'order',
    event_name: 'order_duplicate_flagged',
    from_states: ['registration_pending'],
    to_state: 'duplicate_suspected',
    allowed_roles: ['OrderOps', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'order',
    event_name: 'order_registered',
    from_states: ['registration_pending', 'duplicate_suspected'],
    to_state: 'registered',
    allowed_roles: ['OrderOps'],
    is_final_decision: true,
    requires_reason: false,
  },
  {
    object_type: 'order',
    event_name: 'order_inventory_check_started',
    from_states: ['registered'],
    to_state: 'inventory_checking',
    allowed_roles: ['OrderOps', 'InventoryReviewer', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'order',
    event_name: 'order_inventory_insufficient',
    from_states: ['inventory_checking', 'inventory_rechecking'],
    to_state: 'inventory_insufficient',
    allowed_roles: ['InventoryReviewer'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'order',
    event_name: 'order_inventory_recheck_requested',
    from_states: ['inventory_insufficient', 'inventory_checking'],
    to_state: 'inventory_rechecking',
    allowed_roles: ['InventoryReviewer', 'OrderOps'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'order',
    event_name: 'order_put_on_hold',
    from_states: ['registered', 'inventory_checking', 'inventory_insufficient',
                  'inventory_rechecking'],
    to_state: 'on_hold',
    allowed_roles: ['OrderOps', 'Approver'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'order',
    event_name: 'order_hold_released',
    from_states: ['on_hold'],
    to_state: 'registered',
    allowed_roles: ['OrderOps', 'Approver'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'order',
    event_name: 'order_cancelled',
    from_states: ['registration_pending', 'duplicate_suspected', 'registered',
                  'inventory_checking', 'inventory_insufficient',
                  'inventory_rechecking', 'on_hold'],
    to_state: 'closed_cancelled',
    allowed_roles: ['OrderOps', 'Approver', 'Admin'],
    is_final_decision: true,
    requires_reason: true,
  },
  {
    object_type: 'order',
    event_name: 'order_merged',
    from_states: ['registration_pending', 'duplicate_suspected'],
    to_state: 'closed_merged',
    allowed_roles: ['OrderOps', 'ExceptionReviewer'],
    is_final_decision: true,
    requires_reason: true,
  },
];

// =============================================================================
// SHIPMENT 전이 정의
// states: preparing | partial_dispatched | remainder_pending |
//         dispatch_instructed | delayed |
//         closed_completed | closed_cancelled
// 주의: 부분출고는 예외가 아니라 정식 상태
//       Shipment 완료 후 반품은 Shipment 상태가 아니라 새 Exception 생성
// =============================================================================
const SHIPMENT_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type: 'shipment',
    event_name: 'shipment_created',
    from_states: [],
    to_state: 'preparing',
    allowed_roles: ['ShipmentOps', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_partial_dispatched',
    from_states: ['preparing'],
    to_state: 'partial_dispatched',
    allowed_roles: ['ShipmentOps'],
    is_final_decision: false,
    requires_reason: true,
    preconditions: ['잔량은 remainder_pending 상태의 child shipment로 분할'],
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_remainder_pending',
    from_states: ['partial_dispatched'],
    to_state: 'remainder_pending',
    allowed_roles: ['ShipmentOps', 'System'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_dispatch_instructed',
    from_states: ['preparing', 'remainder_pending'],
    to_state: 'dispatch_instructed',
    allowed_roles: ['ShipmentOps'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_delay_flagged',
    from_states: ['preparing', 'dispatch_instructed', 'remainder_pending'],
    to_state: 'delayed',
    allowed_roles: ['ShipmentOps', 'System'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_completed',
    from_states: ['dispatch_instructed', 'partial_dispatched'],
    to_state: 'closed_completed',
    allowed_roles: ['ShipmentOps'],
    is_final_decision: true,
    requires_reason: false,
  },
  {
    object_type: 'shipment',
    event_name: 'shipment_cancelled',
    from_states: ['preparing', 'dispatch_instructed', 'delayed', 'remainder_pending'],
    to_state: 'closed_cancelled',
    allowed_roles: ['ShipmentOps', 'Approver', 'Admin'],
    is_final_decision: true,
    requires_reason: true,
  },
];

// =============================================================================
// EXCEPTION 전이 정의
// states: created | under_review | reprocess_requested |
//         merged | marked_separate |
//         closed_completed | closed_cancelled
// 예외 종료: ExceptionReviewer 또는 정책상 위임된 권한자만
// =============================================================================
const EXCEPTION_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type: 'exception',
    event_name: 'exception_created',
    from_states: [],
    to_state: 'created',
    allowed_roles: ['System', 'Intake', 'Sales', 'OrderOps',
                    'ShipmentOps', 'InventoryReviewer'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'exception',
    event_name: 'exception_review_started',
    from_states: ['created'],
    to_state: 'under_review',
    allowed_roles: ['ExceptionReviewer'],
    is_final_decision: false,
    requires_reason: false,
  },
  {
    object_type: 'exception',
    event_name: 'exception_reprocess_requested',
    from_states: ['created', 'under_review'],
    to_state: 'reprocess_requested',
    allowed_roles: ['ExceptionReviewer'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'exception',
    event_name: 'exception_merged',
    from_states: ['created', 'under_review'],
    to_state: 'merged',
    allowed_roles: ['ExceptionReviewer'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'exception',
    event_name: 'exception_marked_separate',
    from_states: ['created', 'under_review'],
    to_state: 'marked_separate',
    allowed_roles: ['ExceptionReviewer'],
    is_final_decision: false,
    requires_reason: true,
  },
  {
    object_type: 'exception',
    event_name: 'exception_closed_completed',
    from_states: ['created', 'under_review', 'reprocess_requested',
                  'merged', 'marked_separate'],
    to_state: 'closed_completed',
    allowed_roles: ['ExceptionReviewer'],  // ExceptionReviewer만 종료 가능
    is_final_decision: true,
    requires_reason: true,
  },
  {
    object_type: 'exception',
    event_name: 'exception_closed_cancelled',
    from_states: ['created', 'under_review'],
    to_state: 'closed_cancelled',
    allowed_roles: ['ExceptionReviewer', 'Admin'],
    is_final_decision: true,
    requires_reason: true,
  },
];

// ── 레지스트리 구성 ─────────────────────────────────────────────────────────────
const ALL_TRANSITIONS: TransitionDefinition[] = [
  ...INQUIRY_TRANSITIONS,
  ...QUOTE_TRANSITIONS,
  ...ORDER_TRANSITIONS,
  ...SHIPMENT_TRANSITIONS,
  ...EXCEPTION_TRANSITIONS,
];

// 빠른 조회를 위한 맵 구성: "objectType:eventName" → TransitionDefinition
const TRANSITION_MAP = new Map<string, TransitionDefinition>();
for (const t of ALL_TRANSITIONS) {
  TRANSITION_MAP.set(`${t.object_type}:${t.event_name}`, t);
}

// ── 종결 상태 집합 ────────────────────────────────────────────────────────────
export const TERMINAL_STATES = new Set<string>([
  'closed_completed',
  'closed_cancelled',
  'closed_merged',
]);

// =============================================================================
// TransitionRegistry 클래스
// =============================================================================
export class TransitionRegistry {

  /**
   * 전이 정의 조회.
   * 등록되지 않은 전이: 즉시 에러.
   */
  getTransition(
    objectType: ObjectType,
    eventName: string
  ): TransitionDefinition {
    const key = `${objectType}:${eventName}`;
    const definition = TRANSITION_MAP.get(key);

    if (!definition) {
      throw new EventCoreError(
        `등록되지 않은 전이: ${objectType}:${eventName}. ` +
        `상태 전이 레지스트리에 없는 전이는 허용되지 않음.`,
        EventCoreErrorCode.INVALID_TRANSITION,
        { object_type: objectType, event_name: eventName }
      );
    }

    return definition;
  }

  /**
   * 전이 유효성 검증.
   * from_state가 허용 목록에 없으면 에러.
   */
  validateTransition(
    objectType: ObjectType,
    eventName: string,
    currentState: string | null
  ): TransitionDefinition {
    const definition = this.getTransition(objectType, eventName);

    // 최초 진입 이벤트 (from_states = [])
    if (definition.from_states.length === 0) {
      if (currentState !== null) {
        throw new EventCoreError(
          `이벤트(${eventName})는 최초 생성 시에만 허용됨. 현재 상태: ${currentState}`,
          EventCoreErrorCode.INVALID_FROM_STATE,
          { event_name: eventName, current_state: currentState }
        );
      }
      return definition;
    }

    // 종결 상태에서는 reopen 이벤트를 제외하고 대부분의 전이 불가
    if (currentState && TERMINAL_STATES.has(currentState)) {
      // 종결 상태에서의 전이는 허용 from_states에 명시된 경우만 허용
      // (현재 레지스트리에서는 없지만, 향후 확장 대비)
      if (!definition.from_states.includes(currentState)) {
        throw new EventCoreError(
          `종결 상태(${currentState})에서 전이 불가: ${eventName}`,
          EventCoreErrorCode.OBJECT_ALREADY_CLOSED,
          { current_state: currentState, event_name: eventName }
        );
      }
    }

    if (
      currentState !== null &&
      !definition.from_states.includes(currentState)
    ) {
      throw new EventCoreError(
        `전이 불가: ${currentState} → ${definition.to_state} (이벤트: ${eventName}). ` +
        `허용된 출발 상태: ${definition.from_states.join(', ')}`,
        EventCoreErrorCode.INVALID_FROM_STATE,
        {
          event_name: eventName,
          current_state: currentState,
          allowed_from_states: definition.from_states,
          to_state: definition.to_state,
        }
      );
    }

    return definition;
  }

  /**
   * 특정 객체 유형의 모든 전이 목록 반환 (관리/문서화용).
   */
  getTransitionsForObjectType(objectType: ObjectType): TransitionDefinition[] {
    return ALL_TRANSITIONS.filter((t) => t.object_type === objectType);
  }

  /**
   * 현재 상태에서 가능한 전이 목록 반환.
   */
  getAvailableTransitions(
    objectType: ObjectType,
    currentState: string | null
  ): TransitionDefinition[] {
    return ALL_TRANSITIONS.filter(
      (t) =>
        t.object_type === objectType &&
        (currentState === null
          ? t.from_states.length === 0
          : t.from_states.includes(currentState))
    );
  }

  isTerminalState(state: string): boolean {
    return TERMINAL_STATES.has(state);
  }

  /**
   * 외부 도메인(AI 제품 등)의 전이를 일괄 등록.
   * 기존 B2B 전이와 충돌하지 않도록 object_type 분리 필수.
   */
  registerAll(transitions: TransitionDefinition[]): void {
    for (const t of transitions) {
      const key = `${t.object_type}:${t.event_name}`;
      TRANSITION_MAP.set(key, t);
      ALL_TRANSITIONS.push(t);
    }
  }
}
