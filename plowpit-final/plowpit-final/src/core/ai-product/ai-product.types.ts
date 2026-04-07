// =============================================================================
// src/core/ai-product/ai-product.types.ts
// AI 제품 도메인 타입 정의
//
// 기존 코어의 ObjectType을 확장한다.
// 기존: inquiry | quote | order | inventory | shipment | exception | task
// 추가: ai_config | ai_project | ai_installation | ai_runtime
// =============================================================================

// ── AI 제품 Object Type ───────────────────────────────────────────────────────
// 기존 ObjectType union에 추가되는 값들
// events.types.ts의 ObjectType을 직접 수정하지 않고 캐스팅으로 처리
export type AiObjectType =
  | 'ai_config'       // 주문 구성 (STANDARD/SEMI/CUSTOM 분류까지)
  | 'ai_project'      // CUSTOM 경로 프로젝트 체인
  | 'ai_installation' // 설치 → 연결 → 동의 체인
  | 'ai_runtime';     // 실행 상태

// ── AI 제품 이벤트명 (event_name 형식: object_action_result) ──────────────────
export const AI_EVENT_NAMES = {
  // ai_config 체인
  ORDER_CREATED:          'ai_config_order_created',
  ORDER_STANDARD_ROUTED:  'ai_config_standard_routed',
  ORDER_SEMI_VERIFIED:    'ai_config_semi_verified',
  ORDER_CUSTOM_ESCALATED: 'ai_config_custom_escalated',
  LICENSE_ISSUED:         'ai_config_license_issued',
  LICENSE_FAILED:         'ai_config_license_failed',
  PACKAGE_CREATED:        'ai_config_package_created',
  PACKAGE_FAILED:         'ai_config_package_failed',
  DELIVERY_COMPLETED:     'ai_config_delivery_completed',
  DELIVERY_FAILED:        'ai_config_delivery_failed',

  // ai_project 체인 (CUSTOM 경로)
  PROJECT_INTAKE:         'ai_project_intake_received',
  REQUIREMENT_DEFINED:    'ai_project_requirement_defined',
  QUOTE_CREATED:          'ai_project_quote_created',
  QUOTE_APPROVED:         'ai_project_quote_approved',
  QUOTE_REJECTED:         'ai_project_quote_rejected',
  PROJECT_CANCELLED:      'ai_project_cancelled',
  PROJECT_CONVERTED:      'ai_project_converted_to_order',

  // ai_installation 체인
  INSTALL_COMPLETED:      'ai_installation_completed',
  INSTALL_FAILED:         'ai_installation_failed',
  CONNECTION_SUCCESS:     'ai_installation_connection_success',
  CONNECTION_FAILED:      'ai_installation_connection_failed',
  API_KEY_INVALID:        'ai_installation_api_key_invalid',
  CONSENT_ACCEPTED:       'ai_installation_consent_accepted',
  CONSENT_DECLINED:       'ai_installation_consent_declined',

  // ai_runtime 체인
  RUNTIME_STARTED:        'ai_runtime_started',
  RUNTIME_FAILED:         'ai_runtime_failed',
  RUNTIME_STOPPED:        'ai_runtime_stopped',
  USAGE_SPIKE:            'ai_runtime_usage_spike',
} as const;

export type AiEventName = typeof AI_EVENT_NAMES[keyof typeof AI_EVENT_NAMES];

// ── EventName → NotificationLevel 매핑 ───────────────────────────────────────
// 기존 코어의 SeverityLevel과 다르다 (알림 우선순위 기준)
export type NotificationLevel = 'low' | 'medium' | 'high' | 'critical';

export const AI_EVENT_NOTIFICATION_LEVEL: Record<AiEventName, NotificationLevel> = {
  [AI_EVENT_NAMES.ORDER_CREATED]:          'high',
  [AI_EVENT_NAMES.ORDER_STANDARD_ROUTED]:  'medium',
  [AI_EVENT_NAMES.ORDER_SEMI_VERIFIED]:    'medium',
  [AI_EVENT_NAMES.ORDER_CUSTOM_ESCALATED]: 'high',
  [AI_EVENT_NAMES.LICENSE_ISSUED]:         'medium',
  [AI_EVENT_NAMES.LICENSE_FAILED]:         'high',
  [AI_EVENT_NAMES.PACKAGE_CREATED]:        'medium',
  [AI_EVENT_NAMES.PACKAGE_FAILED]:         'high',
  [AI_EVENT_NAMES.DELIVERY_COMPLETED]:     'medium',
  [AI_EVENT_NAMES.DELIVERY_FAILED]:        'high',
  [AI_EVENT_NAMES.PROJECT_INTAKE]:         'high',
  [AI_EVENT_NAMES.REQUIREMENT_DEFINED]:    'medium',
  [AI_EVENT_NAMES.QUOTE_CREATED]:          'medium',
  [AI_EVENT_NAMES.QUOTE_APPROVED]:         'high',
  [AI_EVENT_NAMES.QUOTE_REJECTED]:         'medium',
  [AI_EVENT_NAMES.PROJECT_CANCELLED]:      'high',
  [AI_EVENT_NAMES.PROJECT_CONVERTED]:      'high',
  [AI_EVENT_NAMES.INSTALL_COMPLETED]:      'medium',
  [AI_EVENT_NAMES.INSTALL_FAILED]:         'high',
  [AI_EVENT_NAMES.CONNECTION_SUCCESS]:     'medium',
  [AI_EVENT_NAMES.CONNECTION_FAILED]:      'high',
  [AI_EVENT_NAMES.API_KEY_INVALID]:        'high',
  [AI_EVENT_NAMES.CONSENT_ACCEPTED]:       'medium',
  [AI_EVENT_NAMES.CONSENT_DECLINED]:       'medium',
  [AI_EVENT_NAMES.RUNTIME_STARTED]:        'medium',
  [AI_EVENT_NAMES.RUNTIME_FAILED]:         'high',
  [AI_EVENT_NAMES.RUNTIME_STOPPED]:        'medium',
  [AI_EVENT_NAMES.USAGE_SPIKE]:            'high',
};

// ── 액션 정책 ─────────────────────────────────────────────────────────────────
export interface AiActionPolicy {
  realtime_notify: boolean;  // 텔레그램 즉시
  digest_notify:   boolean;  // 요약 포함
  auto_action:     AutoActionType | AutoActionType[] | null;
  ticket_required: boolean;
}

export type AutoActionType =
  | 'retry_license'
  | 'resend_delivery'
  | 'retry_connection'
  | 'prompt_reauth'
  | 'deactivate_api_key'
  | 'disable_collection'
  | 'restart_runtime'
  | 'switch_cost_cap';

export const AI_EVENT_ACTION_POLICY: Record<AiEventName, AiActionPolicy> = {
  [AI_EVENT_NAMES.ORDER_CREATED]:          { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.ORDER_STANDARD_ROUTED]:  { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.ORDER_SEMI_VERIFIED]:    { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.ORDER_CUSTOM_ESCALATED]: { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.LICENSE_ISSUED]:         { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.LICENSE_FAILED]:         { realtime_notify: true,  digest_notify: true,  auto_action: 'retry_license',                                   ticket_required: true  },
  [AI_EVENT_NAMES.PACKAGE_CREATED]:        { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.PACKAGE_FAILED]:         { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.DELIVERY_COMPLETED]:     { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.DELIVERY_FAILED]:        { realtime_notify: true,  digest_notify: true,  auto_action: 'resend_delivery',                                 ticket_required: true  },
  [AI_EVENT_NAMES.PROJECT_INTAKE]:         { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.REQUIREMENT_DEFINED]:    { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.QUOTE_CREATED]:          { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.QUOTE_APPROVED]:         { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.QUOTE_REJECTED]:         { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.PROJECT_CANCELLED]:      { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.PROJECT_CONVERTED]:      { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.INSTALL_COMPLETED]:      { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.INSTALL_FAILED]:         { realtime_notify: true,  digest_notify: true,  auto_action: null,                                              ticket_required: true  },
  [AI_EVENT_NAMES.CONNECTION_SUCCESS]:     { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.CONNECTION_FAILED]:      { realtime_notify: true,  digest_notify: true,  auto_action: ['retry_connection', 'prompt_reauth'],              ticket_required: true  },
  [AI_EVENT_NAMES.API_KEY_INVALID]:        { realtime_notify: true,  digest_notify: true,  auto_action: 'deactivate_api_key',                              ticket_required: true  },
  [AI_EVENT_NAMES.CONSENT_ACCEPTED]:       { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.CONSENT_DECLINED]:       { realtime_notify: false, digest_notify: true,  auto_action: 'disable_collection',                              ticket_required: false },
  [AI_EVENT_NAMES.RUNTIME_STARTED]:        { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.RUNTIME_FAILED]:         { realtime_notify: true,  digest_notify: true,  auto_action: 'restart_runtime',                                 ticket_required: true  },
  [AI_EVENT_NAMES.RUNTIME_STOPPED]:        { realtime_notify: false, digest_notify: true,  auto_action: null,                                              ticket_required: false },
  [AI_EVENT_NAMES.USAGE_SPIKE]:            { realtime_notify: true,  digest_notify: true,  auto_action: 'switch_cost_cap',                                 ticket_required: true  },
};

// ── AI 제품 Projection 상태 ───────────────────────────────────────────────────
export type AiConfigState =
  | 'configuring'
  | 'standard_ordered'
  | 'semi_pending_verification'
  | 'semi_ordered'
  | 'custom_escalated'
  | 'licensed'
  | 'packaged'
  | 'delivered'
  | 'closed_cancelled';

export type AiProjectState =
  | 'intake'
  | 'requirement_defined'
  | 'quoted'
  | 'approved'
  | 'converted'
  | 'closed_cancelled';

export type AiInstallationState =
  | 'installing'
  | 'installed'
  | 'connecting'
  | 'connected'
  | 'consent_pending'
  | 'consented'
  | 'connection_failed'
  | 'closed_deactivated';

export type AiRuntimeState =
  | 'starting'
  | 'running'
  | 'cost_cap'
  | 'stopped'
  | 'failed';
