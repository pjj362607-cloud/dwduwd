// =============================================================================
// src/core/ai-product/ai-product-transitions.ts
//
// AI 제품 도메인의 상태 전이 정의.
// 기존 transition-registry.ts에 병합된다.
//
// 원칙:
//   - 기존 B2B 도메인(inquiry/quote/order/shipment)과 object_type으로 완전 분리
//   - AI/System은 is_final_decision: true 불가 (기존 코어 원칙 준수)
//   - 사람 권한자만 최종 결정
// =============================================================================

import { TransitionDefinition } from '../event-store/events.types';
import { AI_EVENT_NAMES } from './ai-product.types';

// ── ai_config 전이 (주문 구성 → 라이선스 → 패키지 → 전달) ────────────────────
export const AI_CONFIG_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.ORDER_CREATED,
    from_states:      [],
    to_state:         'configuring',
    allowed_roles:    ['Customer', 'Sales', 'System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.ORDER_STANDARD_ROUTED,
    from_states:      ['configuring'],
    to_state:         'standard_ordered',
    allowed_roles:    ['Customer', 'System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.ORDER_SEMI_VERIFIED,
    from_states:      ['configuring', 'semi_pending_verification'],
    to_state:         'semi_ordered',
    allowed_roles:    ['System', 'Sales'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.ORDER_CUSTOM_ESCALATED,
    from_states:      ['configuring', 'semi_pending_verification'],
    to_state:         'custom_escalated',
    allowed_roles:    ['System', 'Sales'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.LICENSE_ISSUED,
    from_states:      ['standard_ordered', 'semi_ordered'],
    to_state:         'licensed',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.LICENSE_FAILED,
    from_states:      ['standard_ordered', 'semi_ordered'],
    to_state:         'standard_ordered',   // 상태 유지 — 재시도 가능
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.PACKAGE_CREATED,
    from_states:      ['licensed'],
    to_state:         'packaged',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.PACKAGE_FAILED,
    from_states:      ['licensed'],
    to_state:         'licensed',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.DELIVERY_COMPLETED,
    from_states:      ['packaged'],
    to_state:         'delivered',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_config' as any,
    event_name:       AI_EVENT_NAMES.DELIVERY_FAILED,
    from_states:      ['packaged'],
    to_state:         'packaged',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
];

// ── ai_project 전이 (CUSTOM 경로) ────────────────────────────────────────────
export const AI_PROJECT_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.PROJECT_INTAKE,
    from_states:      [],
    to_state:         'intake',
    allowed_roles:    ['Customer', 'Sales'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.REQUIREMENT_DEFINED,
    from_states:      ['intake'],
    to_state:         'requirement_defined',
    allowed_roles:    ['Sales', 'ProjectManager'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.QUOTE_CREATED,
    from_states:      ['requirement_defined'],
    to_state:         'quoted',
    allowed_roles:    ['Sales'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.QUOTE_APPROVED,
    from_states:      ['quoted'],
    to_state:         'approved',
    allowed_roles:    ['Customer', 'Approver'],   // 사람 권한자만
    is_final_decision: true,
    requires_reason:  false,
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.QUOTE_REJECTED,
    from_states:      ['quoted'],
    to_state:         'quoted',
    allowed_roles:    ['Customer', 'Approver'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.PROJECT_CONVERTED,
    from_states:      ['approved'],
    to_state:         'converted',
    allowed_roles:    ['System', 'Sales'],
    is_final_decision: false,
    requires_reason:  false,
    preconditions:    ['converted 이후 ai_config 객체가 생성되고 ORDER_CREATED 이벤트 발행'],
  },
  {
    object_type:      'ai_project' as any,
    event_name:       AI_EVENT_NAMES.PROJECT_CANCELLED,
    from_states:      ['intake', 'requirement_defined', 'quoted', 'approved'],
    to_state:         'closed_cancelled',
    allowed_roles:    ['Customer', 'Sales', 'Admin'],
    is_final_decision: true,
    requires_reason:  true,
  },
];

// ── ai_installation 전이 ──────────────────────────────────────────────────────
export const AI_INSTALLATION_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.INSTALL_COMPLETED,
    from_states:      ['installing'],
    to_state:         'installed',
    allowed_roles:    ['System', 'TechOps'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.INSTALL_FAILED,
    from_states:      ['installing'],
    to_state:         'installing',
    allowed_roles:    ['System', 'TechOps'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.CONNECTION_SUCCESS,
    from_states:      ['installed', 'connecting'],
    to_state:         'connected',
    allowed_roles:    ['System', 'TechOps'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.CONNECTION_FAILED,
    from_states:      ['installed', 'connecting'],
    to_state:         'connection_failed',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.API_KEY_INVALID,
    from_states:      ['installed', 'connecting', 'connected'],
    to_state:         'closed_deactivated',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.CONSENT_ACCEPTED,
    from_states:      ['connected'],
    to_state:         'consented',
    allowed_roles:    ['Customer'],   // 반드시 고객이 선택
    is_final_decision: true,
    requires_reason:  false,
  },
  {
    object_type:      'ai_installation' as any,
    event_name:       AI_EVENT_NAMES.CONSENT_DECLINED,
    from_states:      ['connected', 'consent_pending'],
    to_state:         'connected',    // 동의 거절 시 연결 상태 유지, 수집만 중단
    allowed_roles:    ['Customer'],
    is_final_decision: true,
    requires_reason:  false,
  },
];

// ── ai_runtime 전이 ───────────────────────────────────────────────────────────
export const AI_RUNTIME_TRANSITIONS: TransitionDefinition[] = [
  {
    object_type:      'ai_runtime' as any,
    event_name:       AI_EVENT_NAMES.RUNTIME_STARTED,
    from_states:      [],
    to_state:         'running',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_runtime' as any,
    event_name:       AI_EVENT_NAMES.RUNTIME_FAILED,
    from_states:      ['running', 'starting'],
    to_state:         'failed',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
  {
    object_type:      'ai_runtime' as any,
    event_name:       AI_EVENT_NAMES.RUNTIME_STOPPED,
    from_states:      ['running', 'cost_cap'],
    to_state:         'stopped',
    allowed_roles:    ['Customer', 'Admin', 'System'],
    is_final_decision: false,
    requires_reason:  false,
  },
  {
    object_type:      'ai_runtime' as any,
    event_name:       AI_EVENT_NAMES.USAGE_SPIKE,
    from_states:      ['running'],
    to_state:         'cost_cap',
    allowed_roles:    ['System'],
    is_final_decision: false,
    requires_reason:  true,
  },
];

export const ALL_AI_TRANSITIONS: TransitionDefinition[] = [
  ...AI_CONFIG_TRANSITIONS,
  ...AI_PROJECT_TRANSITIONS,
  ...AI_INSTALLATION_TRANSITIONS,
  ...AI_RUNTIME_TRANSITIONS,
];
