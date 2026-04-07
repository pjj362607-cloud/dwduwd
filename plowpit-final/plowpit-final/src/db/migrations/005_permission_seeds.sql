-- =============================================================================
-- Migration 005: Permission Seeds
-- 권한 매트릭스 확정본 기반 초기 권한 데이터
-- 원칙: can_make_final_decision - AI/System은 항상 FALSE
-- =============================================================================

-- ── Intake 권한 ───────────────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('Intake', 'inquiry',   ARRAY['inquiry_received','inquiry_marked_insufficient','inquiry_duplicate_flagged','inquiry_review_started','inquiry_reopened','inquiry_cancelled','inquiry_merged'], TRUE, FALSE),
('Intake', 'exception', NULL, FALSE, FALSE);

-- ── Sales 권한 ────────────────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('Sales', 'quote',     ARRAY['quote_draft_created','quote_submitted_for_approval','quote_sent','quote_revision_requested','quote_cancelled','quote_reopened'], TRUE, FALSE),
('Sales', 'exception', NULL, FALSE, FALSE);

-- ── Approver 권한 ─────────────────────────────────────────────────────────────
-- Approver가 견적 최종 승인 권한 보유
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('Approver', 'quote',     ARRAY['quote_approved','quote_approval_rejected','quote_revision_requested','quote_cancelled'], TRUE, FALSE),
('Approver', 'order',     ARRAY['order_put_on_hold','order_hold_released','order_cancelled'], FALSE, FALSE),
('Approver', 'shipment',  ARRAY['shipment_cancelled'], FALSE, FALSE),
('Approver', 'exception', NULL, FALSE, FALSE);

-- ── OrderOps 권한 ─────────────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('OrderOps', 'order',     ARRAY['order_draft_created','order_duplicate_flagged','order_registered','order_inventory_check_started','order_inventory_recheck_requested','order_put_on_hold','order_hold_released','order_cancelled','order_merged'], TRUE, FALSE),
('OrderOps', 'exception', NULL, FALSE, FALSE);

-- ── InventoryReviewer 권한 ────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('InventoryReviewer', 'inventory', ARRAY['inventory_confirmed'], TRUE, FALSE),
('InventoryReviewer', 'order',     ARRAY['order_inventory_check_started','order_inventory_insufficient','order_inventory_recheck_requested'], FALSE, FALSE),
('InventoryReviewer', 'exception', NULL, FALSE, FALSE);

-- ── ShipmentOps 권한 ─────────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('ShipmentOps', 'shipment',  ARRAY['shipment_created','shipment_partial_dispatched','shipment_remainder_pending','shipment_dispatch_instructed','shipment_delay_flagged','shipment_completed','shipment_cancelled'], TRUE, FALSE),
('ShipmentOps', 'exception', NULL, FALSE, FALSE);

-- ── ExceptionReviewer 권한 ───────────────────────────────────────────────────
-- 예외 종료: ExceptionReviewer만 (업무 판단자와 예외 종료자 구분)
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('ExceptionReviewer', 'exception', ARRAY['exception_review_started','exception_reprocess_requested','exception_merged','exception_marked_separate','exception_closed_completed','exception_closed_cancelled'], TRUE, TRUE),
('ExceptionReviewer', 'inquiry',   ARRAY['inquiry_merged'], FALSE, FALSE),
('ExceptionReviewer', 'order',     ARRAY['order_merged'], FALSE, FALSE);

-- ── Admin 권한 ────────────────────────────────────────────────────────────────
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('Admin', 'inquiry',   NULL, TRUE, TRUE),
('Admin', 'quote',     NULL, TRUE, TRUE),
('Admin', 'order',     NULL, TRUE, TRUE),
('Admin', 'shipment',  NULL, TRUE, TRUE),
('Admin', 'exception', NULL, TRUE, TRUE),
('Admin', 'inventory', NULL, TRUE, TRUE),
('Admin', 'task',      NULL, TRUE, TRUE);

-- ── System 권한 (비최종, 자동 전이만) ────────────────────────────────────────
-- System: can_make_final_decision = FALSE (절대 원칙)
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('System', 'inquiry',   ARRAY['inquiry_received','inquiry_classified_auto','inquiry_duplicate_flagged','inquiry_marked_insufficient'], FALSE, FALSE),
('System', 'quote',     ARRAY['quote_draft_created','quote_approval_required_flagged'], FALSE, FALSE),
('System', 'order',     ARRAY['order_draft_created','order_duplicate_flagged','order_inventory_check_started','order_delay_risk_flagged'], FALSE, FALSE),
('System', 'shipment',  ARRAY['shipment_created','shipment_delay_flagged','shipment_remainder_pending','shipment_blocked_inventory_conflict'], FALSE, FALSE),
('System', 'exception', ARRAY['exception_created'], FALSE, FALSE),
('System', 'task',      ARRAY['task_created'], FALSE, FALSE);

-- ── AIAssist 권한 (파싱/초안/분류만, 최종 확정 절대 불가) ─────────────────────
-- AIAssist: can_make_final_decision = FALSE (절대 원칙)
INSERT INTO permissions (role_name, object_type, allowed_event_names, can_make_final_decision, can_close_exception) VALUES
('AIAssist', 'inquiry',   ARRAY['inquiry_parsed_by_ai','inquiry_missing_fields_flagged'], FALSE, FALSE),
('AIAssist', 'quote',     ARRAY['quote_draft_suggested_by_ai'], FALSE, FALSE),
('AIAssist', 'order',     ARRAY['order_delay_risk_flagged'], FALSE, FALSE),
('AIAssist', 'exception', ARRAY['exception_type_suggested_by_ai'], FALSE, FALSE);

COMMENT ON TABLE permissions IS
  'AI/System의 can_make_final_decision은 항상 FALSE. 이것은 운영 코어의 절대 원칙이다.';
