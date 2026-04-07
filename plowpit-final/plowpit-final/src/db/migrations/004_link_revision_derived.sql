-- =============================================================================
-- Migration 004: Link / Revision / Derived Tables (D층)
-- =============================================================================

-- ── OBJECT_LINKS (객체 간 명시적 참조 관계) ─────────────────────────────────
-- correlation_id는 흐름 묶음용, object_links는 명시적 참조용.
-- 둘은 대체되지 않는다.
CREATE TABLE object_links (
  link_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  source_object_type      object_type_enum NOT NULL,
  source_object_id        UUID          NOT NULL,
  target_object_type      object_type_enum NOT NULL,
  target_object_id        UUID          NOT NULL,
  link_type               TEXT          NOT NULL,
  -- link_type: inquiry_to_quote | quote_to_order | order_to_shipment |
  --            shipment_to_exception | order_to_exception | merged_into |
  --            split_from | revision_of

  created_by_event_id     UUID,
  correlation_id          UUID,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT object_links_pkey PRIMARY KEY (link_id),
  CONSTRAINT object_links_unique
    UNIQUE (source_object_type, source_object_id,
            target_object_type, target_object_id, link_type)
);

-- ── QUOTE_REVISIONS (견적 revision 스냅샷) ─────────────────────────────────
-- 기본 원칙: revision 이력은 events에서 재생성.
-- 조건부 추가:
--   - revision별 snapshot 조회 요구가 잦은 경우
--   - revision diff 비교가 잦은 경우
--   - replay 성능이 부족한 경우
CREATE TABLE quote_revisions (
  revision_id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  quote_id                UUID          NOT NULL,
  revision_no             INTEGER       NOT NULL,
  caused_by_event_id      UUID          NOT NULL,

  -- 해당 revision 시점의 snapshot
  snapshot_items          JSONB         DEFAULT '[]',
  snapshot_total_amount   NUMERIC(18,2),
  snapshot_due_date       DATE,
  snapshot_notes          TEXT,

  revised_by              UUID,
  revision_reason         TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT quote_revisions_pkey PRIMARY KEY (revision_id),
  CONSTRAINT quote_revisions_unique UNIQUE (quote_id, revision_no)
);

-- ── ORDER_REVISIONS (주문 revision 스냅샷) ─────────────────────────────────
-- 조건부 추가 (위 quote_revisions와 동일 기준)
CREATE TABLE order_revisions (
  revision_id             UUID          NOT NULL DEFAULT gen_random_uuid(),
  order_id                UUID          NOT NULL,
  revision_no             INTEGER       NOT NULL,
  caused_by_event_id      UUID          NOT NULL,

  snapshot_items          JSONB         DEFAULT '[]',
  snapshot_total_amount   NUMERIC(18,2),
  snapshot_delivery_date  DATE,
  snapshot_notes          TEXT,

  revised_by              UUID,
  revision_reason         TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT order_revisions_pkey PRIMARY KEY (revision_id),
  CONSTRAINT order_revisions_unique UNIQUE (order_id, revision_no)
);

-- ── SHIPMENT_SPLITS (부분출고 분할 추적) ─────────────────────────────────────
-- 부분 출고는 예외가 아니라 정식 상태. parent-child 구조.
CREATE TABLE shipment_splits (
  split_id                UUID          NOT NULL DEFAULT gen_random_uuid(),
  parent_shipment_id      UUID          NOT NULL,
  child_shipment_id       UUID          NOT NULL,
  split_event_id          UUID          NOT NULL,

  -- 분할 내용
  split_items             JSONB         DEFAULT '[]',
  remainder_items         JSONB         DEFAULT '[]',

  split_reason            TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT shipment_splits_pkey PRIMARY KEY (split_id),
  CONSTRAINT shipment_splits_unique UNIQUE (parent_shipment_id, child_shipment_id)
);

-- ── DEDUPE_CANDIDATES (중복 의심 후보) ───────────────────────────────────────
-- dedupe_key는 중복 의심 후보 비교용. 강제 동일성 키가 아님.
-- dedupe hit 시 즉시 확정하지 않고 후보/예외로 남긴다.
CREATE TABLE dedupe_candidates (
  candidate_id            UUID          NOT NULL DEFAULT gen_random_uuid(),
  object_type             object_type_enum NOT NULL,

  -- 원본 이벤트 / 객체
  original_event_id       UUID          NOT NULL,
  original_object_id      UUID          NOT NULL,

  -- 중복 의심 이벤트 / 객체
  suspect_event_id        UUID          NOT NULL,
  suspect_object_id       UUID,

  -- 중복 판단 근거
  dedupe_key              TEXT,
  match_score             NUMERIC(5,4), -- 0~1 유사도
  match_fields            JSONB         DEFAULT '{}',

  -- 처리 상태
  status                  TEXT          NOT NULL DEFAULT 'pending',
  -- status: pending | confirmed_duplicate | confirmed_distinct |
  --         merged | escalated_to_exception

  resolved_by             UUID,
  resolved_at             TIMESTAMPTZ,
  resolution_event_id     UUID,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT dedupe_candidates_pkey PRIMARY KEY (candidate_id)
);

-- ── 인덱스 ────────────────────────────────────────────────────────────────
CREATE INDEX idx_object_links_source ON object_links (source_object_type, source_object_id);
CREATE INDEX idx_object_links_target ON object_links (target_object_type, target_object_id);
CREATE INDEX idx_object_links_corr   ON object_links (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE INDEX idx_quote_revisions_quote  ON quote_revisions (quote_id, revision_no DESC);
CREATE INDEX idx_order_revisions_order  ON order_revisions (order_id, revision_no DESC);
CREATE INDEX idx_shipment_splits_parent ON shipment_splits (parent_shipment_id);

CREATE INDEX idx_dedupe_candidates_key    ON dedupe_candidates (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_dedupe_candidates_status ON dedupe_candidates (status) WHERE status = 'pending';

-- ── 코멘트 ────────────────────────────────────────────────────────────────
COMMENT ON TABLE object_links      IS 'correlation_id와 대체 불가. 명시적 참조 관계만.';
COMMENT ON TABLE dedupe_candidates IS 'dedupe_key는 unique truth가 아님. 후보 비교용.';
COMMENT ON TABLE shipment_splits   IS '부분출고는 예외가 아니라 정식 상태. parent-child 구조.';
