-- =============================================================================
-- Migration 001: Canonical Event Store
-- 티켓 1: Events Schema 구축
-- 원칙: events가 진실이다. append-only. direct update 금지.
-- =============================================================================

-- --------------------------------
-- ENUM: 객체 유형
-- --------------------------------
CREATE TYPE object_type_enum AS ENUM (
  'inquiry',
  'quote',
  'order',
  'inventory',
  'shipment',
  'exception',
  'task'
);

-- --------------------------------
-- ENUM: 행위자 유형
-- --------------------------------
CREATE TYPE actor_type_enum AS ENUM (
  'user',
  'system',
  'ai'
);

-- --------------------------------
-- ENUM: 심각도
-- --------------------------------
CREATE TYPE severity_enum AS ENUM (
  'low',
  'medium',
  'high',
  'blocking'
);

-- --------------------------------
-- ENUM: 소스 채널
-- --------------------------------
CREATE TYPE source_channel_enum AS ENUM (
  'web',
  'api',
  'system',
  'email',
  'phone',
  'external_erp',
  'external_wms',
  'manual'
);

-- =============================================================================
-- CANONICAL EVENT STORE
-- append-only: DELETE와 UPDATE는 row-level security 또는 trigger로 차단
-- =============================================================================
CREATE TABLE events (
  -- ── 식별자 ──────────────────────────────────────────
  event_id                UUID          NOT NULL DEFAULT gen_random_uuid(),

  -- ── 객체 참조 ─────────────────────────────────────
  object_type             object_type_enum NOT NULL,
  object_id               UUID          NOT NULL,
  -- 같은 객체 내부 단조 증가. occurred_at만으로 순서 판단 금지.
  object_seq_no           BIGINT        NOT NULL,

  -- ── 이벤트 식별 ───────────────────────────────────
  -- 형식: object_action_result (예: quote_revision_requested)
  event_name              TEXT          NOT NULL,
  from_state              TEXT,
  to_state                TEXT,

  -- ── 행위자 ────────────────────────────────────────
  actor_type              actor_type_enum NOT NULL,
  actor_id                UUID          NOT NULL,
  actor_role              TEXT          NOT NULL,
  -- 이 전이에서 최종 결정을 내린 역할 (= final decision 역할)
  decision_role           TEXT,
  -- 예외를 종료한 역할 (exception_closed_by_role)
  exception_closed_by_role TEXT,

  -- ── 비즈니스 맥락 ─────────────────────────────────
  reason_code             TEXT,
  payload_json            JSONB         NOT NULL DEFAULT '{}',
  -- 페이로드 스키마 버전: 필수. 마이그레이션 추적용.
  payload_schema_version  TEXT          NOT NULL,

  -- ── 심각도 / SLA ──────────────────────────────────
  severity                severity_enum,
  sla_started_at          TIMESTAMPTZ,

  -- ── 타임스탬프 ────────────────────────────────────
  -- occurred_at: 비즈니스 이벤트가 실제로 발생한 시각
  occurred_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- recorded_at: DB에 기록된 시각 (자동, 변경 불가)
  recorded_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- ── 인과 / 연관 ───────────────────────────────────
  -- 이 이벤트를 유발한 이전 이벤트 ID
  caused_by_event_id      UUID,
  -- 같은 문의→견적→주문→출고 흐름을 묶는 식별자
  correlation_id          UUID,
  -- 동일 객체의 버전 번호 (수정 시 증가)
  revision_no             INTEGER       NOT NULL DEFAULT 1,

  -- ── 멱등성 / 중복 방지 ─────────────────────────────
  -- 외부 시스템 이벤트 ID: 강한 멱등성 키
  external_event_id       TEXT,
  -- 중복 의심 후보 비교용 키 (강제 동일성 키가 아님)
  dedupe_key              TEXT,
  source_channel          source_channel_enum NOT NULL DEFAULT 'web',

  -- ── 최종 확정 여부 ────────────────────────────────
  -- true: 해당 단계에서 권한자가 사업적으로 책임지는 최종 확정 이벤트
  -- AI/System은 이 값을 true로 설정 불가
  is_final_decision       BOOLEAN       NOT NULL DEFAULT FALSE,

  -- ── 제약 ──────────────────────────────────────────
  CONSTRAINT events_pkey PRIMARY KEY (event_id),

  -- 같은 객체 내 seq_no는 유일 (순서 고정)
  CONSTRAINT events_object_seq_unique
    UNIQUE (object_type, object_id, object_seq_no),

  -- 외부 이벤트 ID는 채널 내 유일 (멱등성 보장)
  CONSTRAINT events_external_id_unique
    UNIQUE (source_channel, external_event_id)
    -- DEFERRABLE INITIALLY DEFERRED: external_event_id가 NULL이면 무시됨 (partial unique)
);

-- external_event_id가 NULL인 경우는 유니크 제약에서 제외 (partial unique)
DROP INDEX IF EXISTS events_external_id_unique;
CREATE UNIQUE INDEX events_external_id_unique
  ON events (source_channel, external_event_id)
  WHERE external_event_id IS NOT NULL;

-- ── 인덱스 ────────────────────────────────────────────────────────────────────
-- 객체별 이벤트 조회 (replay, projection용)
CREATE INDEX idx_events_object
  ON events (object_type, object_id, object_seq_no ASC);

-- 흐름 전체 조회 (correlation 기반)
CREATE INDEX idx_events_correlation
  ON events (correlation_id)
  WHERE correlation_id IS NOT NULL;

-- 인과 관계 추적
CREATE INDEX idx_events_caused_by
  ON events (caused_by_event_id)
  WHERE caused_by_event_id IS NOT NULL;

-- 이벤트명 기반 조회 (KPI, 룰 엔진)
CREATE INDEX idx_events_name_occurred
  ON events (event_name, occurred_at DESC);

-- final decision 이벤트 빠른 조회
CREATE INDEX idx_events_final_decision
  ON events (object_type, object_id, is_final_decision)
  WHERE is_final_decision = TRUE;

-- dedupe_key 중복 탐지
CREATE INDEX idx_events_dedupe_key
  ON events (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ── append-only 보호 트리거 ─────────────────────────────────────────────────
-- DELETE 시도 차단
CREATE OR REPLACE FUNCTION prevent_event_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'events 테이블은 append-only입니다. DELETE는 허용되지 않습니다. (event_id: %)',
    OLD.event_id;
END;
$$;

CREATE TRIGGER trg_events_no_delete
  BEFORE DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION prevent_event_delete();

-- UPDATE 시도 차단
CREATE OR REPLACE FUNCTION prevent_event_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'events 테이블은 append-only입니다. UPDATE는 허용되지 않습니다. (event_id: %)',
    OLD.event_id;
END;
$$;

CREATE TRIGGER trg_events_no_update
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION prevent_event_update();

-- ── object_seq_no 자동 발급 지원 테이블 ──────────────────────────────────────
-- 티켓 3: object_seq_no 발급기가 사용하는 카운터
CREATE TABLE object_seq_counters (
  object_type   object_type_enum NOT NULL,
  object_id     UUID             NOT NULL,
  last_seq_no   BIGINT           NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

  CONSTRAINT object_seq_counters_pkey
    PRIMARY KEY (object_type, object_id)
);

-- ── 코멘트 ────────────────────────────────────────────────────────────────────
COMMENT ON TABLE events IS
  '운영 코어의 canonical source of truth. append-only. DELETE/UPDATE 금지.';
COMMENT ON COLUMN events.object_seq_no IS
  '같은 객체 내부 이벤트 순서. 단조 증가. occurred_at으로 순서 판단 금지.';
COMMENT ON COLUMN events.is_final_decision IS
  'true = 사업적 최종 확정 이벤트. AI/System actor는 true 설정 불가.';
COMMENT ON COLUMN events.dedupe_key IS
  '중복 의심 후보 비교용. 강제 동일성 키가 아님.';
COMMENT ON COLUMN events.external_event_id IS
  '외부 시스템 이벤트 ID. 강한 멱등성 키.';
