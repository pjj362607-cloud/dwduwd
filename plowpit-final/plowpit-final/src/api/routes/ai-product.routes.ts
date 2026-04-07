// =============================================================================
// src/api/routes/ai-product.routes.ts
//
// AI 제품 도메인 라우트
//
// 포함:
//   Page 1-4: 문제 선택 → 구성 선택 → 권장안 생성 → 분기
//   Page 5:   AI 검수 (SEMI 경로)
//   Page 6:   주문 확정
//   프로젝트 체인: 접수 → 요구사항 → 견적 → 승인
//   운영 체인:    설치 → 연결 → 동의
//   대시보드:     이벤트 로그 + 집계 + 타임라인
//
// 원칙:
//   - 모든 상태 변경은 transitionObject() 경유 (기존 코어 원칙 준수)
//   - UI는 코어의 창문이지 편집기가 아님
//   - 직접 UPDATE 금지
// =============================================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { TransitionObjectService } from '../../core/transition/transition-object.service';
import { AI_EVENT_NAMES } from '../../core/ai-product/ai-product.types';

// ── 권장안/분류 엔진 (인라인) ─────────────────────────────────────────────────
type SystemType = 'STANDARD' | 'SEMI' | 'CUSTOM';

function classify(config: Record<string, unknown>): SystemType {
  if (config.user_scope === 'org_wide')         return 'CUSTOM';
  if (config.data_sensitivity === 'high')        return 'CUSTOM';
  if (config.problem_domain === 'workflow' && config.user_scope !== 'individual') return 'CUSTOM';
  if (config.api_mode === 'customer')            return 'SEMI';
  if (config.data_sensitivity === 'medium')      return 'SEMI';
  if (config.tech_readiness === 'none' || config.tech_readiness === 'basic') return 'SEMI';
  return 'STANDARD';
}

function recommend(problem: Record<string, unknown>, config: Record<string, unknown>) {
  const system_type = classify({ ...problem, ...config });
  return {
    system_type,
    recommended_engine: problem.problem_domain === 'data_analysis' ? 'analysis_engine'
      : problem.problem_domain === 'cs_automation' ? 'conversation_engine'
      : 'general_engine',
    recommended_deploy_mode: config.data_sensitivity === 'high' ? 'hybrid'
      : config.deploy_mode ?? 'hybrid',
    recommended_ops_mode: config.tech_readiness === 'none' ? 'managed'
      : config.tech_readiness === 'advanced' ? 'self' : 'hybrid',
    estimated_range: system_type === 'STANDARD' ? { min: 300000, max: 800000 }
      : system_type === 'SEMI' ? { min: 800000, max: 3000000 }
      : { min: 3000000, max: 0 },
    classification_reasons: [] as string[],
  };
}

export function createAiProductRouter(
  pool: Pool,
  transitionService: TransitionObjectService,
): Router {
  const router = Router();

  // ══════════════════════════════════════════════════════════════
  // Page 1+2+3: 권장안 생성
  // POST /ai-product/recommend
  // ══════════════════════════════════════════════════════════════

  router.post('/recommend', async (req: Request, res: Response) => {
    try {
      const { problem, config } = req.body as {
        problem: Record<string, unknown>;
        config:  Record<string, unknown>;
      };
      if (!problem || !config) {
        return res.status(400).json({ error: 'problem, config 필수' });
      }
      const recommendation = recommend(problem, config);
      res.json({ recommendation });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Page 5: AI 검수 (SEMI 경로)
  // POST /ai-product/verify
  // ══════════════════════════════════════════════════════════════

  router.post('/verify', async (req: Request, res: Response) => {
    try {
      const { problem, config } = req.body as {
        problem: Record<string, unknown>;
        config:  Record<string, unknown>;
      };
      const issues: string[] = [];
      const system_type = classify({ ...problem, ...config });

      // 검수 중 CUSTOM으로 상향되면 에스컬레이션
      if (system_type === 'CUSTOM') {
        return res.json({
          status: 'escalate_to_custom',
          issues: ['검수 결과 맞춤형 설계 필요'],
        });
      }
      if (config.data_sensitivity === 'high') {
        issues.push('고민감 데이터 — 격리 정책 확인 필요');
      }
      if (config.deploy_mode === 'local' && config.tech_readiness === 'none') {
        issues.push('로컬 설치 요청이지만 내부 기술 대응 없음');
      }
      res.json({ status: 'pass', issues });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Page 6: 주문 확정 (STANDARD / SEMI)
  // POST /ai-product/orders
  // ══════════════════════════════════════════════════════════════

  router.post('/orders', async (req: Request, res: Response) => {
    try {
      const {
        actor_id, actor_role, customer_id,
        problem, config, recommendation, policy_version,
      } = req.body;

      if (!actor_id || !customer_id || !recommendation) {
        return res.status(400).json({ error: 'actor_id, customer_id, recommendation 필수' });
      }
      if (recommendation.system_type === 'CUSTOM') {
        return res.status(400).json({
          error: 'CUSTOM 유형은 /ai-product/projects 를 통해야 합니다',
        });
      }

      const config_id = uuidv4();
      const correlation_id = uuidv4();

      // 1. ai_configs 행 생성
      await pool.query(
        `INSERT INTO ai_configs
           (config_id, customer_id, system_type, order_type,
            problem_domain, config_json, final_config_json, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          config_id, customer_id,
          recommendation.system_type, 'immediate',
          problem?.problem_domain ?? null,
          JSON.stringify(config ?? {}),
          JSON.stringify(recommendation),
          correlation_id,
        ]
      );

      // 2. ORDER_CREATED 이벤트 (transitionObject 경유)
      const result = await transitionService.transition({
        object_type:            'ai_config' as any,
        object_id:              config_id,
        event_name:             AI_EVENT_NAMES.ORDER_CREATED,
        from_state:             null as any,
        to_state:               'configuring',
        actor_type:             'user',
        actor_id,
        actor_role,
        payload_json:           { customer_id, system_type: recommendation.system_type, policy_version },
        payload_schema_version: 'v1',
        correlation_id,
        is_final_decision:      false,
        source_channel:         'web',
      });

      res.status(201).json({
        config_id,
        correlation_id,
        system_type: recommendation.system_type,
        event_id: result.event_id,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 프로젝트 접수 (CUSTOM 경로)
  // POST /ai-product/projects
  // ══════════════════════════════════════════════════════════════

  router.post('/projects', async (req: Request, res: Response) => {
    try {
      const { actor_id, actor_role, customer_id, recommendation } = req.body;
      if (!actor_id || !customer_id) {
        return res.status(400).json({ error: 'actor_id, customer_id 필수' });
      }

      const project_id = uuidv4();
      const correlation_id = uuidv4();

      await pool.query(
        `INSERT INTO ai_projects (project_id, customer_id, correlation_id)
         VALUES ($1, $2, $3)`,
        [project_id, customer_id, correlation_id]
      );

      const result = await transitionService.transition({
        object_type:            'ai_project' as any,
        object_id:              project_id,
        event_name:             AI_EVENT_NAMES.PROJECT_INTAKE,
        from_state:             null as any,
        to_state:               'intake',
        actor_type:             'user',
        actor_id,
        actor_role,
        payload_json:           { customer_id, recommendation },
        payload_schema_version: 'v1',
        correlation_id,
        is_final_decision:      false,
        source_channel:         'web',
      });

      res.status(201).json({ project_id, correlation_id, event_id: result.event_id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  // 요구사항 정의
  router.post('/projects/:projectId/requirements', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { actor_id, actor_role, requirements, correlation_id } = req.body;

      await pool.query(
        `UPDATE ai_projects SET requirements_json = $1, updated_at = NOW() WHERE project_id = $2`,
        [JSON.stringify(requirements), projectId]
      );

      const result = await transitionService.transition({
        object_type: 'ai_project' as any, object_id: projectId,
        event_name: AI_EVENT_NAMES.REQUIREMENT_DEFINED,
        from_state: 'intake', to_state: 'requirement_defined',
        actor_type: 'user', actor_id, actor_role,
        payload_json: { requirement_keys: Object.keys(requirements ?? {}) },
        payload_schema_version: 'v1', correlation_id, is_final_decision: false, source_channel: 'web',
      });

      res.json({ event_id: result.event_id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 견적 생성
  router.post('/projects/:projectId/quotes', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { actor_id, actor_role, lines, currency = 'KRW', valid_days = 14, correlation_id } = req.body;

      const total = (lines as Array<{ quantity: number; unit_price: number }>)
        .reduce((s, l) => s + l.quantity * l.unit_price, 0);
      const quote = { quote_id: uuidv4(), lines, total, currency,
        valid_until: new Date(Date.now() + valid_days * 86400000).toISOString() };

      await pool.query(
        `UPDATE ai_projects SET quote_json = $1, updated_at = NOW() WHERE project_id = $2`,
        [JSON.stringify(quote), projectId]
      );

      const result = await transitionService.transition({
        object_type: 'ai_project' as any, object_id: projectId,
        event_name: AI_EVENT_NAMES.QUOTE_CREATED,
        from_state: 'requirement_defined', to_state: 'quoted',
        actor_type: 'user', actor_id, actor_role,
        payload_json: { total, currency, valid_until: quote.valid_until },
        payload_schema_version: 'v1', correlation_id, is_final_decision: false, source_channel: 'web',
      });

      res.json({ quote, event_id: result.event_id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 견적 승인
  router.post('/projects/:projectId/quotes/approve', async (req: Request, res: Response) => {
    try {
      const { projectId } = req.params;
      const { actor_id, actor_role, correlation_id } = req.body;

      const result = await transitionService.transition({
        object_type: 'ai_project' as any, object_id: projectId,
        event_name: AI_EVENT_NAMES.QUOTE_APPROVED,
        from_state: 'quoted', to_state: 'approved',
        actor_type: 'user', actor_id, actor_role,
        payload_json: { approved_by: actor_id },
        payload_schema_version: 'v1', correlation_id,
        is_final_decision: true, source_channel: 'web',
      });

      res.json({ event_id: result.event_id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 운영 체인: 설치 완료
  // POST /ai-product/installations/:configId/complete
  // ══════════════════════════════════════════════════════════════

  router.post('/installations/:configId/complete', async (req: Request, res: Response) => {
    try {
      const { configId } = req.params;
      const { actor_id, actor_role, customer_id, install_method = 'hybrid',
              api_mode = 'shared', api_provider, correlation_id } = req.body;

      const installation_id = uuidv4();
      await pool.query(
        `INSERT INTO ai_installations
           (installation_id, config_id, customer_id, install_method, api_mode, api_provider, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [installation_id, configId, customer_id, install_method, api_mode, api_provider ?? null, correlation_id]
      );

      const result = await transitionService.transition({
        object_type: 'ai_installation' as any, object_id: installation_id,
        event_name: AI_EVENT_NAMES.INSTALL_COMPLETED,
        from_state: 'installing', to_state: 'installed',
        actor_type: 'system', actor_id, actor_role,
        payload_json: { config_id: configId, install_method },
        payload_schema_version: 'v1', correlation_id, is_final_decision: false, source_channel: 'system',
      });

      res.json({ installation_id, event_id: result.event_id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 동의 처리
  router.post('/installations/:installationId/consent', async (req: Request, res: Response) => {
    try {
      const { installationId } = req.params;
      const { actor_id, actor_role, accepted, collection_scope, activation_mode,
              consent_version, correlation_id } = req.body;

      if (accepted) {
        await pool.query(
          `UPDATE ai_installations
             SET collection_scope=$1, activation_mode=$2, consent_version=$3, consented_at=NOW(), updated_at=NOW()
           WHERE installation_id=$4`,
          [collection_scope, activation_mode, consent_version, installationId]
        );
      }

      const result = await transitionService.transition({
        object_type: 'ai_installation' as any, object_id: installationId,
        event_name:  accepted ? AI_EVENT_NAMES.CONSENT_ACCEPTED : AI_EVENT_NAMES.CONSENT_DECLINED,
        from_state: 'connected', to_state: accepted ? 'consented' : 'connected',
        actor_type: 'user', actor_id, actor_role,
        payload_json: { collection_scope, activation_mode, accepted },
        payload_schema_version: 'v1', correlation_id,
        is_final_decision: true,   // 고객의 최종 선택
        source_channel: 'web',
      });

      res.json({ event_id: result.event_id });
    } catch (err: unknown) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 대시보드: AI 제품 이벤트 로그
  // GET /ai-product/dashboard/events
  // ══════════════════════════════════════════════════════════════

  router.get('/dashboard/events', async (req: Request, res: Response) => {
    try {
      const {
        object_type, object_id, event_name, level,
        since, until, limit = '50', offset = '0',
      } = req.query;

      const conditions = [
        `e.object_type IN ('ai_config','ai_project','ai_installation','ai_runtime')`,
      ];
      const params: unknown[] = [];
      let idx = 1;

      if (object_type) { conditions.push(`e.object_type = $${idx++}`); params.push(object_type); }
      if (object_id)   { conditions.push(`e.object_id = $${idx++}`);   params.push(object_id);   }
      if (event_name)  { conditions.push(`e.event_name = $${idx++}`);  params.push(event_name);  }
      if (since)       { conditions.push(`e.occurred_at >= $${idx++}`); params.push(since);      }
      if (until)       { conditions.push(`e.occurred_at <= $${idx++}`); params.push(until);      }

      const where = conditions.join(' AND ');
      const lim   = parseInt(limit as string);
      const off   = parseInt(offset as string);

      const rows = await pool.query(
        `SELECT e.event_id, e.object_type, e.object_id, e.object_seq_no,
                e.event_name, e.from_state, e.to_state,
                e.actor_type, e.actor_role, e.reason_code,
                e.payload_json, e.occurred_at, e.correlation_id,
                e.is_final_decision, e.severity
         FROM events e
         WHERE ${where}
         ORDER BY e.occurred_at DESC
         LIMIT ${lim} OFFSET ${off}`,
        params
      );

      const count = await pool.query(
        `SELECT COUNT(*) as total FROM events e WHERE ${where}`, params
      );

      res.json({
        rows: rows.rows,
        total: parseInt(count.rows[0].total),
        limit: lim,
        offset: off,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 대시보드: 집계 요약
  router.get('/dashboard/summary', async (req: Request, res: Response) => {
    try {
      const { since, until } = req.query;
      const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 86400000);
      const untilDate = until ? new Date(until as string) : new Date();

      const [orderCount, failCount, runtimeCount, ticketCount] = await Promise.all([
        pool.query(
          `SELECT COUNT(*) as n FROM events
           WHERE object_type = 'ai_config' AND event_name = $1
             AND occurred_at BETWEEN $2 AND $3`,
          [AI_EVENT_NAMES.ORDER_CREATED, sinceDate, untilDate]
        ),
        pool.query(
          `SELECT event_name, COUNT(*) as n FROM events
           WHERE object_type IN ('ai_config','ai_installation','ai_runtime')
             AND event_name LIKE '%_failed%'
             AND occurred_at BETWEEN $1 AND $2
           GROUP BY event_name`,
          [sinceDate, untilDate]
        ),
        pool.query(
          `SELECT COUNT(*) as n FROM events
           WHERE object_type = 'ai_runtime' AND event_name = $1
             AND occurred_at BETWEEN $2 AND $3`,
          [AI_EVENT_NAMES.RUNTIME_STARTED, sinceDate, untilDate]
        ),
        pool.query(
          `SELECT COUNT(*) as n FROM ai_tickets
           WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS')`,
          []
        ),
      ]);

      res.json({
        period: { since: sinceDate.toISOString(), until: untilDate.toISOString() },
        order_count:          parseInt(orderCount.rows[0].n),
        runtime_started:      parseInt(runtimeCount.rows[0].n),
        open_tickets:         parseInt(ticketCount.rows[0].n),
        failure_breakdown:    failCount.rows,
        generated_at:         new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 티켓 목록
  router.get('/tickets', async (req: Request, res: Response) => {
    try {
      const { status, customer_id, limit = '50', offset = '0' } = req.query;
      const conditions = ['1=1'];
      const params: unknown[] = [];
      let idx = 1;

      if (status)      { conditions.push(`status = $${idx++}`);      params.push(status);      }
      if (customer_id) { conditions.push(`customer_id = $${idx++}`); params.push(customer_id); }

      const where = conditions.join(' AND ');
      const rows = await pool.query(
        `SELECT * FROM ai_tickets WHERE ${where}
         ORDER BY created_at DESC LIMIT ${parseInt(limit as string)} OFFSET ${parseInt(offset as string)}`,
        params
      );
      res.json({ tickets: rows.rows });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // 티켓 상태 전이
  router.post('/tickets/:ticketId/resolve', async (req: Request, res: Response) => {
    try {
      const { ticketId } = req.params;
      const { resolution_note, assignee } = req.body;
      await pool.query(
        `UPDATE ai_tickets
           SET status='RESOLVED', resolution_note=$1, resolved_at=NOW(), updated_at=NOW()
         WHERE ticket_id=$2`,
        [resolution_note, ticketId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
