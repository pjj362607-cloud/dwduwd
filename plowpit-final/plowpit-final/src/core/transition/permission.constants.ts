// =============================================================================
// src/core/transition/permission.constants.ts
// System/AI 허용/금지 이벤트 상수 (pg 의존성 없음 - 테스트/검증용 독립 파일)
// =============================================================================

// ── Final Decision 이벤트 집합 ─────────────────────────────────────────────────
export const FINAL_DECISION_EVENTS = new Set<string>([
  'quote_approved',
  'quote_sent',
  'order_registered',
  'inventory_confirmed',
  'shipment_completed',
  'exception_closed_completed',
  'exception_closed_cancelled',
]);

// ── System 허용 이벤트 화이트리스트 ──────────────────────────────────────────
export const SYSTEM_ALLOWED_EVENTS = new Set<string>([
  'inquiry_classified_auto',
  'inquiry_duplicate_flagged',
  'inquiry_marked_insufficient',
  'order_draft_created',
  'inventory_check_started',
  'quote_draft_created',
  'quote_approval_required_flagged',
  'exception_created',
  'order_duplicate_flagged',
  'shipment_delay_flagged',
  'shipment_blocked_inventory_conflict',
  'shipment_remainder_pending',
  'task_created',
  'order_delay_risk_flagged',
]);

// ── AI 허용 이벤트 화이트리스트 ───────────────────────────────────────────────
export const AI_ALLOWED_EVENTS = new Set<string>([
  'inquiry_parsed_by_ai',
  'quote_draft_suggested_by_ai',
  'exception_type_suggested_by_ai',
  'inquiry_missing_fields_flagged',
  'order_delay_risk_flagged',
]);
