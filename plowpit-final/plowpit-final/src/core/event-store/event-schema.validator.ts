// =============================================================================
// src/core/event-store/event-schema.validator.ts
// 이벤트 입력 스키마 검증
// 원칙: invalid schema 저장 거부. 필수 필드 누락 시 실패.
// =============================================================================

import {
  AppendEventInput,
  EventCoreError,
  EventCoreErrorCode,
  ActorType,
  ObjectType,
  SourceChannel,
  SeverityLevel,
} from './events.types';

// ── 유효 값 집합 ─────────────────────────────────────────────────────────────
const VALID_OBJECT_TYPES = new Set<ObjectType>([
  'inquiry', 'quote', 'order', 'inventory', 'shipment', 'exception', 'task',
]);

const VALID_ACTOR_TYPES = new Set<ActorType>(['user', 'system', 'ai']);

const VALID_CHANNELS = new Set<SourceChannel>([
  'web', 'api', 'system', 'email', 'phone', 'external_erp', 'external_wms', 'manual',
]);

const VALID_SEVERITIES = new Set<SeverityLevel>([
  'low', 'medium', 'high', 'blocking',
]);

// 이벤트 이름 형식: object_action_result (소문자, 언더스코어, 최소 2개 토큰)
// 예: quote_revision_requested, order_marked_duplicate, shipment_completed
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/;

// UUID 형식 (간단 검증)
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// payload_schema_version 형식: semver 또는 날짜 기반 (v1.0, v1, 2024-01 등)
const SCHEMA_VERSION_PATTERN = /^v?\d+(\.\d+)*(-[\w.]+)?$|^\d{4}-\d{2}(-\d{2})?$/;

/**
 * AppendEventInput 전체 검증.
 * 실패 시 EventCoreError throw.
 */
export function validateEventInput(input: AppendEventInput): void {
  const errors: string[] = [];

  // ── 필수 필드 존재 확인 ────────────────────────────────────────────────────
  if (!input.object_type) errors.push('object_type 필수');
  if (!input.object_id)   errors.push('object_id 필수');
  if (!input.event_name)  errors.push('event_name 필수');
  if (!input.actor_type)  errors.push('actor_type 필수');
  if (!input.actor_id)    errors.push('actor_id 필수');
  if (!input.actor_role)  errors.push('actor_role 필수');
  if (!input.payload_schema_version) errors.push('payload_schema_version 필수');

  // 조기 반환 (기본 필드 없으면 나머지 검증 의미 없음)
  if (errors.length > 0) {
    throw new EventCoreError(
      `이벤트 스키마 검증 실패: ${errors.join(', ')}`,
      EventCoreErrorCode.MISSING_REQUIRED_FIELD,
      { errors }
    );
  }

  // ── 타입 검증 ────────────────────────────────────────────────────────────
  if (!VALID_OBJECT_TYPES.has(input.object_type)) {
    errors.push(`유효하지 않은 object_type: ${input.object_type}`);
  }

  if (!VALID_ACTOR_TYPES.has(input.actor_type)) {
    errors.push(`유효하지 않은 actor_type: ${input.actor_type}`);
  }

  if (input.source_channel && !VALID_CHANNELS.has(input.source_channel)) {
    errors.push(`유효하지 않은 source_channel: ${input.source_channel}`);
  }

  if (input.severity && !VALID_SEVERITIES.has(input.severity)) {
    errors.push(`유효하지 않은 severity: ${input.severity}`);
  }

  // ── UUID 형식 검증 ────────────────────────────────────────────────────────
  if (!UUID_PATTERN.test(input.object_id)) {
    errors.push(`object_id가 UUID 형식이 아님: ${input.object_id}`);
  }

  if (!UUID_PATTERN.test(input.actor_id)) {
    errors.push(`actor_id가 UUID 형식이 아님: ${input.actor_id}`);
  }

  if (input.caused_by_event_id && !UUID_PATTERN.test(input.caused_by_event_id)) {
    errors.push(`caused_by_event_id가 UUID 형식이 아님: ${input.caused_by_event_id}`);
  }

  if (input.correlation_id && !UUID_PATTERN.test(input.correlation_id)) {
    errors.push(`correlation_id가 UUID 형식이 아님: ${input.correlation_id}`);
  }

  // ── event_name 형식 검증 ──────────────────────────────────────────────────
  // 형식: object_action_result (소문자 언더스코어, 최소 2개 단어)
  // 주의: event_name의 접두어(object)가 저장 대상 object_type과 반드시 일치할
  //       필요는 없다. 예: 'quote_draft_suggested_by_ai'는 inquiry 객체에 저장 가능.
  //       이벤트 이름은 이벤트의 의미(무슨 일이 생겼는가)를 표현하며,
  //       저장 위치(object_type)와 독립적으로 명명될 수 있다.
  if (!EVENT_NAME_PATTERN.test(input.event_name)) {
    errors.push(
      `event_name 형식 오류 (object_action_result 형식 필요): ${input.event_name}`
    );
  }

  // ── payload_schema_version 형식 ───────────────────────────────────────────
  if (!SCHEMA_VERSION_PATTERN.test(input.payload_schema_version)) {
    errors.push(
      `payload_schema_version 형식 오류: ${input.payload_schema_version} ` +
      `(예: v1, v1.0, 2024-01)`
    );
  }

  // ── revision_no 범위 ──────────────────────────────────────────────────────
  if (input.revision_no !== undefined && input.revision_no < 1) {
    errors.push(`revision_no는 1 이상이어야 함: ${input.revision_no}`);
  }

  // ── is_final_decision 검증 ────────────────────────────────────────────────
  // AI/System actor는 is_final_decision = true 불가 (즉시 전용 에러코드로 throw)
  if (input.is_final_decision === true) {
    if (input.actor_type === 'ai') {
      throw new EventCoreError(
        `AI actor는 is_final_decision = true 불가: ${input.event_name}`,
        EventCoreErrorCode.AI_FINAL_DECISION_FORBIDDEN,
        { event_name: input.event_name, actor_type: input.actor_type }
      );
    }
    if (input.actor_type === 'system') {
      throw new EventCoreError(
        `System actor는 is_final_decision = true 불가: ${input.event_name}`,
        EventCoreErrorCode.SYSTEM_FINAL_DECISION_FORBIDDEN,
        { event_name: input.event_name, actor_type: input.actor_type }
      );
    }
  }

  // ── payload_json 타입 검증 ────────────────────────────────────────────────
  if (
    input.payload_json !== undefined &&
    (typeof input.payload_json !== 'object' ||
      Array.isArray(input.payload_json) ||
      input.payload_json === null)
  ) {
    errors.push('payload_json은 객체여야 함 (배열, null 불가)');
  }

  // ── 최종 에러 처리 ────────────────────────────────────────────────────────
  if (errors.length > 0) {
    throw new EventCoreError(
      `이벤트 스키마 검증 실패: ${errors.join('; ')}`,
      EventCoreErrorCode.MISSING_REQUIRED_FIELD,
      { errors }
    );
  }
}

/**
 * event_name이 표준 형식인지만 빠르게 확인 (전체 검증 없이).
 */
export function isValidEventName(eventName: string): boolean {
  return EVENT_NAME_PATTERN.test(eventName);
}
