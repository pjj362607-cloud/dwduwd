-- =============================================================================
-- Migration 002: Current State Projections (B층)
-- 원칙: current는 projection이다. event와 충돌 시 event 우선.
-- 모든 projection table은 event 반영 범위를 명시해야 한다.
-- =============================================================================

-- ── INQUIRY (문의) ──────────────────────────────────────────────────────────
CREATE TABLE inquiries (
  inquiry_id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  correlation_id          UUID,

  -- 업무 필드
  customer_name           TEXT,
  customer_id             UUID,
  raw_text                TEXT,
  parsed_items            JSONB         DEFAULT '[]',
  contact_info            JSONB         DEFAULT '{}',
  source_channel          TEXT,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'received',
  -- Inquiry states: received | insufficient_info | duplicate_suspected |
  --                 under_review | closed_cancelled | closed_merged

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT inquiries_pkey PRIMARY KEY (inquiry_id)
);

-- ── QUOTE (견적) ──────────────────────────────────────────────────────────
CREATE TABLE quotes (
  quote_id                UUID          NOT NULL DEFAULT gen_random_uuid(),
  inquiry_id              UUID,
  correlation_id          UUID,

  -- 업무 필드
  customer_id             UUID,
  items                   JSONB         DEFAULT '[]',
  total_amount            NUMERIC(18,2),
  due_date                DATE,
  notes                   TEXT,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'drafting',
  -- Quote states: drafting | approval_pending | approval_rejected |
  --               sent | order_pending | revision_requested |
  --               closed_cancelled

  -- Revision 추적 (overwrite 아님)
  current_revision_no     INTEGER       NOT NULL DEFAULT 1,

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT quotes_pkey PRIMARY KEY (quote_id)
);

-- ── ORDER (주문) ──────────────────────────────────────────────────────────
CREATE TABLE orders (
  order_id                UUID          NOT NULL DEFAULT gen_random_uuid(),
  quote_id                UUID,
  correlation_id          UUID,

  -- 업무 필드
  customer_id             UUID,
  items                   JSONB         DEFAULT '[]',
  total_amount            NUMERIC(18,2),
  requested_delivery_date DATE,
  notes                   TEXT,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'registration_pending',
  -- Order states: registration_pending | duplicate_suspected |
  --               registered | inventory_checking | inventory_insufficient |
  --               inventory_rechecking | on_hold |
  --               closed_cancelled | closed_merged

  -- Revision 추적
  current_revision_no     INTEGER       NOT NULL DEFAULT 1,

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT orders_pkey PRIMARY KEY (order_id)
);

-- ── INVENTORY_SNAPSHOTS (재고 판정) ──────────────────────────────────────
-- 단순 재고 수치 저장소가 아니라 재고 확인 이벤트를 바탕으로 한 판정 projection
CREATE TABLE inventory_snapshots (
  snapshot_id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  order_id                UUID,
  item_id                 UUID          NOT NULL,
  correlation_id          UUID,

  -- 재고 판정 결과
  available_qty           NUMERIC(18,3) NOT NULL DEFAULT 0,
  reserved_qty            NUMERIC(18,3) NOT NULL DEFAULT 0,
  judgement               TEXT,         -- sufficient | insufficient | partial
  checked_by              UUID,         -- InventoryReviewer

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'pending',

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT inventory_snapshots_pkey PRIMARY KEY (snapshot_id)
);

-- ── SHIPMENTS (출고) ──────────────────────────────────────────────────────
CREATE TABLE shipments (
  shipment_id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  order_id                UUID,
  parent_shipment_id      UUID,         -- 부분출고 parent-child
  correlation_id          UUID,

  -- 업무 필드
  items                   JSONB         DEFAULT '[]',
  scheduled_date          DATE,
  actual_date             DATE,
  destination             TEXT,
  carrier_info            JSONB         DEFAULT '{}',
  is_partial              BOOLEAN       NOT NULL DEFAULT FALSE,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'preparing',
  -- Shipment states: preparing | partial_dispatched | remainder_pending |
  --                  dispatch_instructed | delayed |
  --                  closed_completed | closed_cancelled

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT shipments_pkey PRIMARY KEY (shipment_id)
);

-- ── EXCEPTIONS (예외) ─────────────────────────────────────────────────────
-- 예외는 본 객체 상태값에 흡수하지 않는다. 별도 객체.
CREATE TABLE exceptions (
  exception_id            UUID          NOT NULL DEFAULT gen_random_uuid(),
  correlation_id          UUID,

  -- 본 객체 참조 (예외는 본 객체의 부속이 아니라 별도 운영 객체)
  target_object_type      object_type_enum NOT NULL,
  target_object_id        UUID          NOT NULL,
  target_event_id         UUID,         -- 예외를 유발한 이벤트

  -- 예외 분류
  exception_type          TEXT          NOT NULL,
  -- exception types: duplicate_input | revision_request | cancel_request |
  --   resubmit | partial_shipment | inventory_recheck | approval_rejected |
  --   due_date_change | external_system_resend | manual_override_attempt |
  --   unconfirmed_customer | item_code_mismatch | approval_missing |
  --   shipment_instruction_conflict

  severity                severity_enum NOT NULL DEFAULT 'medium',
  reason_code             TEXT,
  description             TEXT,

  -- 담당 역할
  assigned_role           TEXT,         -- ExceptionReviewer 등
  assigned_to             UUID,

  -- SLA
  sla_started_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  sla_due_at              TIMESTAMPTZ,

  -- AI 분류 추천 (참고용, 확정 아님)
  ai_suggested_type       TEXT,
  ai_suggested_priority   TEXT,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'created',
  -- Exception states: created | under_review | reprocess_requested |
  --                   merged | marked_separate |
  --                   closed_completed | closed_cancelled

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT exceptions_pkey PRIMARY KEY (exception_id)
);

-- ── TASKS (태스크) ────────────────────────────────────────────────────────
-- tasks 완료는 본 객체(quote, order, shipment, exception)의
-- 최종 상태 확정을 대체하지 않는다.
CREATE TABLE tasks (
  task_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  correlation_id          UUID,

  -- 참조 객체
  related_object_type     object_type_enum,
  related_object_id       UUID,

  -- 태스크 정보
  task_type               TEXT          NOT NULL,
  title                   TEXT          NOT NULL,
  description             TEXT,
  assigned_role           TEXT,
  assigned_to             UUID,

  -- 상태
  current_state           TEXT          NOT NULL DEFAULT 'pending',
  -- Task states: pending | in_progress | completed | cancelled

  due_at                  TIMESTAMPTZ,

  -- Projection 메타데이터 (필수)
  last_event_id           UUID,
  last_projected_event_id UUID,
  projection_version      INTEGER       NOT NULL DEFAULT 1,
  projected_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- 타임스탬프
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT tasks_pkey PRIMARY KEY (task_id)
);

-- ── 인덱스 ────────────────────────────────────────────────────────────────
CREATE INDEX idx_inquiries_state     ON inquiries (current_state);
CREATE INDEX idx_inquiries_corr      ON inquiries (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE INDEX idx_quotes_state        ON quotes (current_state);
CREATE INDEX idx_quotes_corr         ON quotes (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_quotes_inquiry      ON quotes (inquiry_id) WHERE inquiry_id IS NOT NULL;

CREATE INDEX idx_orders_state        ON orders (current_state);
CREATE INDEX idx_orders_corr         ON orders (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_orders_quote        ON orders (quote_id) WHERE quote_id IS NOT NULL;

CREATE INDEX idx_shipments_state     ON shipments (current_state);
CREATE INDEX idx_shipments_order     ON shipments (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_shipments_parent    ON shipments (parent_shipment_id) WHERE parent_shipment_id IS NOT NULL;

CREATE INDEX idx_exceptions_state    ON exceptions (current_state);
CREATE INDEX idx_exceptions_target   ON exceptions (target_object_type, target_object_id);
CREATE INDEX idx_exceptions_severity ON exceptions (severity, sla_started_at);

CREATE INDEX idx_tasks_state         ON tasks (current_state);
CREATE INDEX idx_tasks_related       ON tasks (related_object_type, related_object_id)
  WHERE related_object_id IS NOT NULL;

-- ── 코멘트 ────────────────────────────────────────────────────────────────
COMMENT ON TABLE inquiries  IS 'Current projection. 진실은 events. replay로 재생성 가능.';
COMMENT ON TABLE quotes     IS 'Current projection. current_revision_no는 overwrite가 아님.';
COMMENT ON TABLE orders     IS 'Current projection. 상태 직접 수정 금지.';
COMMENT ON TABLE shipments  IS 'Current projection. 부분출고는 parent_shipment_id로 추적.';
COMMENT ON TABLE exceptions IS '별도 운영 객체. 본 객체에 흡수 금지. ExceptionReviewer만 종료 가능.';
COMMENT ON TABLE tasks      IS 'tasks 완료는 본 객체 최종 상태 확정을 대체하지 않는다.';
COMMENT ON TABLE inventory_snapshots IS '재고 확인 이벤트 기반 판정 projection. 단순 수치 저장소 아님.';
