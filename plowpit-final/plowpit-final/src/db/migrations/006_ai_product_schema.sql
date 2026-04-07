-- =============================================================================
-- 006_ai_product_schema.sql
-- AI 제품 도메인 테이블
-- 의존성: 001_events_schema.sql (events 테이블)
--
-- 설계 원칙:
--   - current_state는 projection — events 테이블이 진실
--   - direct UPDATE 금지 (projector만 갱신)
--   - 각 테이블은 기존 B2B 도메인 테이블(quotes, orders 등)과 완전 분리
-- =============================================================================

-- ── ai_configs (주문 구성 + 프로비저닝 체인) ────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_configs (
  config_id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       VARCHAR(255)  NOT NULL,
  system_type       VARCHAR(20)   NOT NULL CHECK (system_type IN ('STANDARD', 'SEMI', 'CUSTOM')),
  order_type        VARCHAR(20)   NOT NULL,
  current_state     VARCHAR(50)   NOT NULL DEFAULT 'configuring',

  -- 구성 정보 (Page 1+2 입력값)
  problem_domain    VARCHAR(100),
  goal_type         VARCHAR(100),
  config_json       JSONB         NOT NULL DEFAULT '{}',
  final_config_json JSONB         NOT NULL DEFAULT '{}',

  -- 프로비저닝 연결
  source_project_id UUID,

  -- 메타
  correlation_id    UUID,
  last_event_id     UUID,
  projected_at      TIMESTAMPTZ,
  projection_version INT          NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_configs_customer
  ON ai_configs (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_configs_state
  ON ai_configs (current_state);
CREATE INDEX IF NOT EXISTS idx_ai_configs_correlation
  ON ai_configs (correlation_id);

-- ── ai_projects (CUSTOM 경로 프로젝트) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_projects (
  project_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       VARCHAR(255)  NOT NULL,
  current_state     VARCHAR(50)   NOT NULL DEFAULT 'intake',

  requirements_json JSONB,
  quote_json        JSONB,
  converted_config_id UUID,

  correlation_id    UUID,
  last_event_id     UUID,
  projected_at      TIMESTAMPTZ,
  projection_version INT          NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_projects_customer
  ON ai_projects (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_projects_state
  ON ai_projects (current_state);

-- ── ai_installations (설치 → 연결 → 동의 체인) ───────────────────────────────
CREATE TABLE IF NOT EXISTS ai_installations (
  installation_id   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id         UUID          NOT NULL REFERENCES ai_configs(config_id),
  customer_id       VARCHAR(255)  NOT NULL,
  current_state     VARCHAR(50)   NOT NULL DEFAULT 'installing',

  install_method    VARCHAR(20)   NOT NULL DEFAULT 'hybrid',
  api_mode          VARCHAR(20)   NOT NULL DEFAULT 'shared',
  api_provider      VARCHAR(100),

  -- 수집 동의 정보 (CONSENT_ACCEPTED 시 채워짐)
  collection_scope  VARCHAR(20),
  activation_mode   VARCHAR(20),
  consent_version   VARCHAR(50),
  consented_at      TIMESTAMPTZ,

  correlation_id    UUID,
  last_event_id     UUID,
  projected_at      TIMESTAMPTZ,
  projection_version INT          NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_installations_config
  ON ai_installations (config_id);
CREATE INDEX IF NOT EXISTS idx_ai_installations_state
  ON ai_installations (current_state);

-- ── ai_runtimes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_runtimes (
  runtime_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id   UUID          NOT NULL REFERENCES ai_installations(installation_id),
  customer_id       VARCHAR(255)  NOT NULL,
  current_state     VARCHAR(20)   NOT NULL DEFAULT 'starting',

  started_at        TIMESTAMPTZ,
  stopped_at        TIMESTAMPTZ,
  cost_cap_at       TIMESTAMPTZ,
  runtime_config    JSONB         NOT NULL DEFAULT '{}',

  correlation_id    UUID,
  last_event_id     UUID,
  projected_at      TIMESTAMPTZ,
  projection_version INT          NOT NULL DEFAULT 0,

  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_runtimes_installation_active
  ON ai_runtimes (installation_id)
  WHERE current_state IN ('starting', 'running', 'cost_cap');

-- ── ai_digest_entries (요약 축적) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_digest_entries (
  id            BIGSERIAL     PRIMARY KEY,
  event_name    VARCHAR(100)  NOT NULL,
  level         VARCHAR(20)   NOT NULL,
  customer_id   VARCHAR(255),
  object_id     UUID          NOT NULL,
  occurred_at   TIMESTAMPTZ   NOT NULL,
  summary       TEXT          NOT NULL,
  digested_at   TIMESTAMPTZ,    -- NULL = 아직 요약 전
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_digest_pending
  ON ai_digest_entries (digested_at, occurred_at)
  WHERE digested_at IS NULL;

-- ── ai_tickets (AI 제품 도메인 티켓) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_tickets (
  ticket_id       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_type     VARCHAR(50)   NOT NULL,
  status          VARCHAR(30)   NOT NULL DEFAULT 'OPEN',

  customer_id     VARCHAR(255),
  event_name      VARCHAR(100)  NOT NULL,
  object_id       UUID          NOT NULL,
  object_type     VARCHAR(50)   NOT NULL,
  correlation_id  UUID,
  event_level     VARCHAR(20)   NOT NULL,

  assignee        VARCHAR(255),
  payload_summary TEXT,
  resolution_note TEXT,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_tickets_status
  ON ai_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_tickets_customer
  ON ai_tickets (customer_id, status);
