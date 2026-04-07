-- =============================================================================
-- Migration 003: Master / Reference Tables (C층)
-- accounts, items는 Admin만 최종 확정.
-- Intake는 신규 후보 제안만 가능.
-- =============================================================================

-- ── ACCOUNTS (거래처) ──────────────────────────────────────────────────────
CREATE TABLE accounts (
  account_id              UUID          NOT NULL DEFAULT gen_random_uuid(),
  account_code            TEXT          UNIQUE,
  name                    TEXT          NOT NULL,
  account_type            TEXT          NOT NULL DEFAULT 'customer',
  -- account_type: customer | supplier | both

  contact_info            JSONB         DEFAULT '{}',
  address                 JSONB         DEFAULT '{}',
  payment_terms           TEXT,
  credit_limit            NUMERIC(18,2),

  -- 상태 (Admin만 확정)
  status                  TEXT          NOT NULL DEFAULT 'active',
  -- status: pending_confirmation | active | suspended | inactive

  -- 신규 후보 제안 추적 (Intake가 제안, Admin이 확정)
  proposed_by             UUID,
  proposed_at             TIMESTAMPTZ,
  confirmed_by            UUID,
  confirmed_at            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT accounts_pkey PRIMARY KEY (account_id)
);

-- ── ITEMS (품목) ──────────────────────────────────────────────────────────
CREATE TABLE items (
  item_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  item_code               TEXT          UNIQUE,
  name                    TEXT          NOT NULL,
  description             TEXT,
  category                TEXT,
  unit                    TEXT          NOT NULL DEFAULT 'EA',
  unit_price              NUMERIC(18,2),
  specifications          JSONB         DEFAULT '{}',

  -- 상태 (Admin만 확정)
  status                  TEXT          NOT NULL DEFAULT 'active',
  -- status: pending_confirmation | active | discontinued | inactive

  -- 신규 후보 제안 추적
  proposed_by             UUID,
  proposed_at             TIMESTAMPTZ,
  confirmed_by            UUID,
  confirmed_at            TIMESTAMPTZ,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT items_pkey PRIMARY KEY (item_id)
);

-- ── USERS (사용자) ──────────────────────────────────────────────────────────
CREATE TABLE users (
  user_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  email                   TEXT          NOT NULL UNIQUE,
  name                    TEXT          NOT NULL,
  status                  TEXT          NOT NULL DEFAULT 'active',
  -- status: active | suspended | inactive

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT users_pkey PRIMARY KEY (user_id)
);

-- ── ROLES (역할) ──────────────────────────────────────────────────────────
CREATE TABLE roles (
  role_id                 UUID          NOT NULL DEFAULT gen_random_uuid(),
  role_name               TEXT          NOT NULL UNIQUE,
  -- role_name: Intake | Sales | Approver | OrderOps | InventoryReviewer |
  --            ShipmentOps | ExceptionReviewer | Admin | System | AIAssist
  description             TEXT,
  -- System/AI 역할 여부 (최종 확정 권한 없음)
  is_system_role          BOOLEAN       NOT NULL DEFAULT FALSE,
  is_ai_role              BOOLEAN       NOT NULL DEFAULT FALSE,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT roles_pkey PRIMARY KEY (role_id)
);

-- ── PERMISSIONS (권한) ──────────────────────────────────────────────────────
CREATE TABLE permissions (
  permission_id           UUID          NOT NULL DEFAULT gen_random_uuid(),
  role_name               TEXT          NOT NULL,
  object_type             object_type_enum NOT NULL,
  -- 허용 전이 이벤트 이름 (NULL = 모두 허용, 배열 = 지정된 것만)
  allowed_event_names     TEXT[]        DEFAULT NULL,
  -- 최종 확정 이벤트 허용 여부
  can_make_final_decision BOOLEAN       NOT NULL DEFAULT FALSE,
  -- 예외 종료 권한
  can_close_exception     BOOLEAN       NOT NULL DEFAULT FALSE,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT permissions_pkey PRIMARY KEY (permission_id),
  CONSTRAINT permissions_role_object_unique UNIQUE (role_name, object_type)
);

-- ── USER_ROLES (사용자-역할 매핑) ───────────────────────────────────────────
CREATE TABLE user_roles (
  user_id                 UUID          NOT NULL,
  role_name               TEXT          NOT NULL,
  scope_type              TEXT          NOT NULL DEFAULT 'global',
  -- scope_type: global | account | department
  scope_id                UUID,
  assigned_by             UUID,
  assigned_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ,

  CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_name)
);

-- ── RULES (룰 파일) ──────────────────────────────────────────────────────
-- 룰은 헌법 변경 문서가 아니라 정책 파일이다.
-- 룰로 final decision 우회 불가. 상태 전이표 밖 전이 생성 불가.
CREATE TABLE rules (
  rule_id                 TEXT          NOT NULL,
  rule_version            INTEGER       NOT NULL DEFAULT 1,
  is_active               BOOLEAN       NOT NULL DEFAULT TRUE,

  -- 적용 범위 (scope 구체성 우선 평가)
  scope_type              TEXT          NOT NULL DEFAULT 'global',
  -- scope_type: global | account | department | user
  scope_id                TEXT,

  -- 룰 종류: approval | guardrail | exception | alert | sla
  rule_type               TEXT          NOT NULL,
  object_type             object_type_enum NOT NULL,

  -- 트리거 이벤트 이름
  trigger_event           TEXT          NOT NULL,

  -- 조건 (JSONB)
  conditions              JSONB         NOT NULL DEFAULT '{}',

  -- 액션 (JSONB)
  action                  JSONB         NOT NULL DEFAULT '{}',

  -- 평가 제어
  priority                INTEGER       NOT NULL DEFAULT 100,
  stop_processing         BOOLEAN       NOT NULL DEFAULT FALSE,

  -- 메타데이터
  reason_code             TEXT,
  severity                severity_enum,
  -- 이 룰이 발동 시 생성할 이벤트 이름
  creates_event_name      TEXT,

  -- 유효 기간
  effective_from          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  effective_to            TIMESTAMPTZ,

  -- 관리
  created_by              UUID,
  approved_by             UUID,
  notes                   TEXT,

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT rules_pkey PRIMARY KEY (rule_id, rule_version)
);

-- ── 기본 역할 시드 ─────────────────────────────────────────────────────────
INSERT INTO roles (role_name, description, is_system_role, is_ai_role) VALUES
  ('Intake',             '문의 접수/정규화 담당',              FALSE, FALSE),
  ('Sales',              '견적 작성 담당',                     FALSE, FALSE),
  ('Approver',           '견적/예외 승인 담당',                FALSE, FALSE),
  ('OrderOps',           '주문 등록 담당',                     FALSE, FALSE),
  ('InventoryReviewer',  '재고 확정 담당',                     FALSE, FALSE),
  ('ShipmentOps',        '출고 지시/완료 담당',                FALSE, FALSE),
  ('ExceptionReviewer',  '예외 종료/병합/재처리 판단 담당',    FALSE, FALSE),
  ('Admin',              '룰/권한/마스터 데이터 관리',         FALSE, FALSE),
  ('System',             '승인된 규칙에 따른 자동 전이 실행',  TRUE,  FALSE),
  ('AIAssist',           '파싱/초안/분류 보조',                FALSE, TRUE);

-- ── 인덱스 ────────────────────────────────────────────────────────────────
CREATE INDEX idx_accounts_status ON accounts (status);
CREATE INDEX idx_items_status    ON items (status);
CREATE INDEX idx_rules_trigger   ON rules (trigger_event, is_active)
  WHERE is_active = TRUE;
CREATE INDEX idx_rules_scope     ON rules (scope_type, scope_id, rule_type)
  WHERE is_active = TRUE;
CREATE INDEX idx_user_roles_user ON user_roles (user_id);

-- ── 코멘트 ────────────────────────────────────────────────────────────────
COMMENT ON TABLE accounts IS 'Admin만 최종 확정. Intake는 신규 후보 제안만 가능.';
COMMENT ON TABLE items    IS 'Admin만 최종 확정.';
COMMENT ON TABLE rules    IS '정책 파일. 헌법 변경 아님. final decision 우회 불가.';
COMMENT ON TABLE permissions IS 'can_make_final_decision: AI/System은 항상 FALSE.';
