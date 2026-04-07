// =============================================================================
// src/core/event-store/events.types.ts
// 운영 코어 전체에서 사용하는 타입 정의
// =============================================================================

// ── ENUM 타입 ──────────────────────────────────────────────────────────────

export type ObjectType =
  | 'inquiry'
  | 'quote'
  | 'order'
  | 'inventory'
  | 'shipment'
  | 'exception'
  | 'task';

export type ActorType = 'user' | 'system' | 'ai';

export type SeverityLevel = 'low' | 'medium' | 'high' | 'blocking';

export type SourceChannel =
  | 'web'
  | 'api'
  | 'system'
  | 'email'
  | 'phone'
  | 'external_erp'
  | 'external_wms'
  | 'manual';

// ── 이벤트 레코드 (DB 저장 형태) ─────────────────────────────────────────────
export interface EventRecord {
  event_id: string;                      // UUID
  object_type: ObjectType;
  object_id: string;                     // UUID
  object_seq_no: number;                 // 단조 증가, occurred_at 순서 판단 금지
  event_name: string;                    // format: object_action_result
  from_state: string | null;
  to_state: string | null;
  actor_type: ActorType;
  actor_id: string;                      // UUID
  actor_role: string;
  decision_role: string | null;
  exception_closed_by_role: string | null;
  reason_code: string | null;
  payload_json: Record<string, unknown>;
  payload_schema_version: string;        // 필수
  severity: SeverityLevel | null;
  sla_started_at: Date | null;
  occurred_at: Date;
  recorded_at: Date;
  caused_by_event_id: string | null;     // UUID
  correlation_id: string | null;         // UUID
  revision_no: number;
  external_event_id: string | null;      // 강한 멱등성 키
  dedupe_key: string | null;             // 중복 의심 후보 비교용 (강제 동일성 키 아님)
  source_channel: SourceChannel;
  is_final_decision: boolean;            // AI/System은 true 불가
}

// ── appendEvent 입력 ──────────────────────────────────────────────────────────
export interface AppendEventInput {
  object_type: ObjectType;
  object_id: string;
  event_name: string;
  from_state?: string | null;
  to_state?: string | null;

  // 행위자 정보
  actor_type: ActorType;
  actor_id: string;
  actor_role: string;
  decision_role?: string | null;
  exception_closed_by_role?: string | null;

  // 비즈니스 맥락
  reason_code?: string | null;
  payload_json?: Record<string, unknown>;
  payload_schema_version: string;

  // 심각도 / SLA
  severity?: SeverityLevel | null;
  sla_started_at?: Date | null;

  // 시각 (기본값: NOW())
  occurred_at?: Date;

  // 인과 / 연관
  caused_by_event_id?: string | null;
  correlation_id?: string | null;
  revision_no?: number;

  // 멱등성
  external_event_id?: string | null;
  dedupe_key?: string | null;
  source_channel?: SourceChannel;

  // 최종 확정 여부
  is_final_decision?: boolean;
}

// ── appendEvent 결과 ──────────────────────────────────────────────────────────
export interface AppendEventResult {
  event_id: string;
  object_seq_no: number;
  recorded_at: Date;
}

// ── transitionObject 입력 ─────────────────────────────────────────────────────
export interface TransitionObjectInput {
  object_type: ObjectType;
  object_id: string;
  event_name: string;
  from_state: string;
  to_state: string;
  actor_type: ActorType;
  actor_id: string;
  actor_role: string;
  reason_code?: string | null;
  payload_json?: Record<string, unknown>;
  payload_schema_version: string;
  caused_by_event_id?: string | null;
  correlation_id?: string | null;
  revision_no?: number;
  external_event_id?: string | null;
  dedupe_key?: string | null;
  source_channel?: SourceChannel;
  is_final_decision?: boolean;
  severity?: SeverityLevel | null;
  sla_started_at?: Date | null;
  decision_role?: string | null;
  exception_closed_by_role?: string | null;
}

// ── 상태 전이 정의 ────────────────────────────────────────────────────────────
export interface TransitionDefinition {
  object_type: ObjectType;
  event_name: string;
  from_states: string[];   // 허용되는 출발 상태 목록
  to_state: string;
  allowed_roles: string[]; // 이 전이를 수행할 수 있는 역할
  is_final_decision: boolean;
  requires_reason: boolean;
  preconditions?: string[]; // 추가 전제조건 설명 (검증용)
}

// ── 권한 검증 결과 ─────────────────────────────────────────────────────────────
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

// ── 룰 타입 ──────────────────────────────────────────────────────────────────
export type RuleType = 'approval' | 'guardrail' | 'exception' | 'alert' | 'sla';

export interface RuleDefinition {
  rule_id: string;
  rule_version: number;
  is_active: boolean;
  scope_type: string;
  scope_id?: string | null;
  rule_type: RuleType;
  object_type: ObjectType;
  trigger_event: string;
  conditions: Record<string, unknown>;
  action: Record<string, unknown>;
  priority: number;
  stop_processing: boolean;
  reason_code?: string | null;
  severity?: SeverityLevel | null;
  creates_event_name?: string | null;
  effective_from: Date;
  effective_to?: Date | null;
  created_by?: string | null;
  approved_by?: string | null;
  notes?: string | null;
}

// ── 에러 타입 ─────────────────────────────────────────────────────────────────
export class EventCoreError extends Error {
  constructor(
    message: string,
    public readonly code: EventCoreErrorCode,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'EventCoreError';
  }
}

export enum EventCoreErrorCode {
  // 권한 에러
  UNAUTHORIZED_TRANSITION       = 'UNAUTHORIZED_TRANSITION',
  AI_FINAL_DECISION_FORBIDDEN   = 'AI_FINAL_DECISION_FORBIDDEN',
  SYSTEM_FINAL_DECISION_FORBIDDEN = 'SYSTEM_FINAL_DECISION_FORBIDDEN',

  // 상태 전이 에러
  INVALID_TRANSITION            = 'INVALID_TRANSITION',
  INVALID_FROM_STATE            = 'INVALID_FROM_STATE',
  OBJECT_ALREADY_CLOSED         = 'OBJECT_ALREADY_CLOSED',
  REOPEN_NOT_ALLOWED            = 'REOPEN_NOT_ALLOWED',

  // 스키마 에러
  MISSING_REQUIRED_FIELD        = 'MISSING_REQUIRED_FIELD',
  INVALID_SCHEMA_VERSION        = 'INVALID_SCHEMA_VERSION',
  INVALID_EVENT_NAME_FORMAT     = 'INVALID_EVENT_NAME_FORMAT',

  // 저장 에러
  SEQ_CONFLICT                  = 'SEQ_CONFLICT',
  DUPLICATE_EXTERNAL_EVENT      = 'DUPLICATE_EXTERNAL_EVENT',

  // 비즈니스 에러
  EXCEPTION_CLOSE_UNAUTHORIZED  = 'EXCEPTION_CLOSE_UNAUTHORIZED',
  DIRECT_UPDATE_FORBIDDEN       = 'DIRECT_UPDATE_FORBIDDEN',
}
