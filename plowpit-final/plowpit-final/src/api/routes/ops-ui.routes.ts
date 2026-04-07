// =============================================================================
// src/api/routes/ops-ui.routes.ts
// 티켓 15: 최소 운영 화면 API
// 제공:
//   1. 승인 큐 (Approver용)
//   2. 예외 큐 (ExceptionReviewer용)
//   3. 객체 상세 타임라인 (event history)
// 원칙:
//   - UI는 코어의 창문이지 편집기가 아님
//   - 운영 상태 direct edit UI 금지
//   - CRUD 편집 화면 금지
//   - 모든 상태 변경은 transitionObject() 경유
// =============================================================================

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { TransitionObjectService } from '../../core/transition/transition-object.service';
import { ExceptionsService } from '../../core/exceptions/exceptions.service';
import { MergeSplitDedupeService } from '../../core/exceptions/merge-split-dedupe.service';

export function createOpsUiRouter(
  pool: Pool,
  transitionService: TransitionObjectService,
  exceptionsService: ExceptionsService,
  mergeSplitService: MergeSplitDedupeService
): Router {
  const router = Router();

  // ═══════════════════════════════════════════════════════════════
  // 1. 승인 큐 (Approver 전용)
  // ═══════════════════════════════════════════════════════════════

  /**
   * GET /ops/approval-queue
   * 승인 대기 중인 견적 목록 조회.
   * Approver만 접근 가능.
   */
  router.get('/approval-queue', async (req: Request, res: Response) => {
    try {
      const { page = '1', limit = '20' } = req.query;
      const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

      const result = await pool.query(
        `
        SELECT
          q.quote_id,
          q.inquiry_id,
          q.correlation_id,
          q.customer_id,
          q.items,
          q.total_amount,
          q.due_date,
          q.current_state,
          q.current_revision_no,
          q.created_at,
          q.updated_at,
          q.last_event_id,
          q.projected_at,
          -- 최근 이벤트 요약
          e.actor_role AS last_actor_role,
          e.reason_code AS last_reason_code,
          e.occurred_at AS last_event_at,
          -- 경과 시간 (시간 단위)
          EXTRACT(EPOCH FROM (NOW() - q.updated_at)) / 3600 AS hours_in_state
        FROM quotes q
        LEFT JOIN events e ON e.event_id = q.last_event_id
        WHERE q.current_state = 'approval_pending'
        ORDER BY q.updated_at ASC  -- 오래된 것 먼저 (SLA 기준)
        LIMIT $1 OFFSET $2
        `,
        [parseInt(limit as string), offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM quotes WHERE current_state = 'approval_pending'`
      );

      res.json({
        items: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page as string),
        limit: parseInt(limit as string),
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  /**
   * POST /ops/approval-queue/:quoteId/approve
   * 견적 승인 (Approver만).
   * 모든 상태 변경은 transitionObject() 경유.
   */
  router.post(
    '/approval-queue/:quoteId/approve',
    async (req: Request, res: Response) => {
      try {
        const { quoteId } = req.params;
        const {
          actor_id,
          actor_role,
          notes,
          correlation_id,
        } = req.body;

        if (!actor_id || !actor_role) {
          return res.status(400).json({ error: 'actor_id, actor_role 필수' });
        }

        // 역할 검증은 transitionObject 내부에서 수행
        const result = await transitionService.transition({
          object_type: 'quote',
          object_id: quoteId,
          event_name: 'quote_approved',
          from_state: 'approval_pending',
          to_state: 'sent',
          actor_type: 'user',
          actor_id,
          actor_role,     // Approver만 허용 (레지스트리에서 차단)
          decision_role: actor_role,
          payload_json: { notes },
          payload_schema_version: 'v1',
          correlation_id,
          is_final_decision: true,
          source_channel: 'web',
        });

        res.json({
          success: true,
          event_id: result.event_id,
          object_seq_no: result.object_seq_no,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: msg });
      }
    }
  );

  /**
   * POST /ops/approval-queue/:quoteId/reject
   * 견적 반려 (Approver만).
   */
  router.post(
    '/approval-queue/:quoteId/reject',
    async (req: Request, res: Response) => {
      try {
        const { quoteId } = req.params;
        const { actor_id, actor_role, reason_code, notes, correlation_id } = req.body;

        if (!reason_code) {
          return res.status(400).json({ error: '반려 사유(reason_code) 필수' });
        }

        const result = await transitionService.transition({
          object_type: 'quote',
          object_id: quoteId,
          event_name: 'quote_approval_rejected',
          from_state: 'approval_pending',
          to_state: 'approval_rejected',
          actor_type: 'user',
          actor_id,
          actor_role,
          reason_code,
          payload_json: { notes },
          payload_schema_version: 'v1',
          correlation_id,
          is_final_decision: false,
          source_channel: 'web',
        });

        res.json({ success: true, event_id: result.event_id });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: msg });
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // 2. 예외 큐 (ExceptionReviewer 전용)
  // ═══════════════════════════════════════════════════════════════

  /**
   * GET /ops/exception-queue
   * 처리 대기 예외 목록.
   * severity별 필터, SLA 기준 정렬.
   */
  router.get('/exception-queue', async (req: Request, res: Response) => {
    try {
      const {
        page = '1',
        limit = '20',
        severity,
        exception_type,
        target_object_type,
      } = req.query;

      const offset = (parseInt(page as string) - 1) * parseInt(limit as string);
      const conditions: string[] = [
        `ex.current_state NOT IN ('closed_completed', 'closed_cancelled')`
      ];
      const params: unknown[] = [parseInt(limit as string), offset];
      let paramIdx = 3;

      if (severity) {
        conditions.push(`ex.severity = $${paramIdx++}`);
        params.push(severity);
      }
      if (exception_type) {
        conditions.push(`ex.exception_type = $${paramIdx++}`);
        params.push(exception_type);
      }
      if (target_object_type) {
        conditions.push(`ex.target_object_type = $${paramIdx++}`);
        params.push(target_object_type);
      }

      const whereClause = conditions.join(' AND ');

      const result = await pool.query(
        `
        SELECT
          ex.exception_id,
          ex.correlation_id,
          ex.target_object_type,
          ex.target_object_id,
          ex.exception_type,
          ex.severity,
          ex.reason_code,
          ex.description,
          ex.assigned_role,
          ex.current_state,
          ex.sla_started_at,
          ex.sla_due_at,
          ex.ai_suggested_type,
          ex.ai_suggested_priority,
          ex.created_at,
          -- SLA 초과 여부
          CASE WHEN ex.sla_due_at < NOW() THEN TRUE ELSE FALSE END AS sla_overdue,
          -- 경과 시간
          EXTRACT(EPOCH FROM (NOW() - ex.sla_started_at)) / 3600 AS hours_open
        FROM exceptions ex
        WHERE ${whereClause}
        ORDER BY
          ex.severity DESC,          -- blocking → high → medium → low
          ex.sla_due_at ASC NULLS LAST
        LIMIT $1 OFFSET $2
        `,
        params
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM exceptions ex WHERE ${whereClause}`,
        params.slice(2)
      );

      res.json({
        items: result.rows,
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page as string),
        limit: parseInt(limit as string),
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  /**
   * POST /ops/exception-queue/:exceptionId/close
   * 예외 종료 (ExceptionReviewer만).
   * 업무 판단자와 예외 종료자를 구분.
   */
  router.post(
    '/exception-queue/:exceptionId/close',
    async (req: Request, res: Response) => {
      try {
        const { exceptionId } = req.params;
        const {
          actor_id,
          actor_role,
          resolution,    // 'completed' | 'cancelled'
          reason_code,
          resolution_notes,
          correlation_id,
        } = req.body;

        if (!resolution || !['completed', 'cancelled'].includes(resolution)) {
          return res.status(400).json({
            error: "resolution은 'completed' 또는 'cancelled'여야 함",
          });
        }

        const result = await exceptionsService.closeException({
          exception_id: exceptionId,
          actor_id,
          actor_role,    // ExceptionReviewer만 허용 (내부 검증)
          resolution,
          reason_code,
          resolution_notes,
          correlation_id,
        });

        res.json({ success: true, event_id: result.event_id });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: msg });
      }
    }
  );

  /**
   * POST /ops/exception-queue/:exceptionId/merge
   * 예외 병합 처리.
   */
  router.post(
    '/exception-queue/:exceptionId/merge',
    async (req: Request, res: Response) => {
      try {
        const { exceptionId } = req.params;
        const {
          actor_id,
          actor_role,
          target_exception_id,
          reason_code,
          correlation_id,
        } = req.body;

        const result = await mergeSplitService.mergeObjects({
          object_type: 'exception',
          source_object_id: exceptionId,
          target_object_id: target_exception_id,
          actor_id,
          actor_role,
          reason_code,
          correlation_id,
        });

        res.json({
          success: true,
          source_event_id: result.source_event.event_id,
          target_event_id: result.target_event.event_id,
        });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: msg });
      }
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // 3. 객체 상세 타임라인 (event history 조회)
  // ═══════════════════════════════════════════════════════════════

  /**
   * GET /ops/timeline/:objectType/:objectId
   * 객체의 전체 이벤트 타임라인 조회.
   * 원인 추적 가능 (caused_by_event_id 포함).
   */
  router.get(
    '/timeline/:objectType/:objectId',
    async (req: Request, res: Response) => {
      try {
        const { objectType, objectId } = req.params;
        const { include_related = 'false' } = req.query;

        // 메인 객체 이벤트 이력 (object_seq_no 오름차순)
        const eventsResult = await pool.query(
          `
          SELECT
            e.event_id,
            e.object_type,
            e.object_id,
            e.object_seq_no,
            e.event_name,
            e.from_state,
            e.to_state,
            e.actor_type,
            e.actor_id,
            e.actor_role,
            e.decision_role,
            e.exception_closed_by_role,
            e.reason_code,
            e.payload_json,
            e.payload_schema_version,
            e.severity,
            e.sla_started_at,
            e.occurred_at,
            e.recorded_at,
            e.caused_by_event_id,
            e.correlation_id,
            e.revision_no,
            e.is_final_decision,
            e.source_channel,
            -- 사용자 이름 (조회 편의)
            u.name AS actor_name
          FROM events e
          LEFT JOIN users u ON u.user_id = e.actor_id
          WHERE e.object_type = $1 AND e.object_id = $2
          ORDER BY e.object_seq_no ASC
          `,
          [objectType, objectId]
        );

        // 현재 projection 상태
        const currentState = await getCurrentProjectionState(pool, objectType, objectId);

        // 연관 예외 목록 (선택)
        let relatedExceptions: unknown[] = [];
        if (include_related === 'true') {
          const excResult = await pool.query(
            `
            SELECT exception_id, exception_type, severity, current_state, created_at
            FROM exceptions
            WHERE target_object_type = $1 AND target_object_id = $2
            ORDER BY created_at ASC
            `,
            [objectType, objectId]
          );
          relatedExceptions = excResult.rows;
        }

        res.json({
          object_type: objectType,
          object_id: objectId,
          current_projection: currentState,
          timeline: eventsResult.rows,
          related_exceptions: relatedExceptions,
          event_count: eventsResult.rows.length,
        });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    }
  );

  /**
   * GET /ops/timeline/:objectType/:objectId/correlation
   * 같은 correlation_id의 전체 흐름 조회.
   * 문의→견적→주문→출고 흐름 전체 추적.
   */
  router.get(
    '/timeline/:objectType/:objectId/correlation',
    async (req: Request, res: Response) => {
      try {
        const { objectType, objectId } = req.params;

        // correlation_id 조회
        const corrResult = await pool.query<{ correlation_id: string }>(
          `SELECT correlation_id FROM events
           WHERE object_type = $1 AND object_id = $2 AND correlation_id IS NOT NULL
           LIMIT 1`,
          [objectType, objectId]
        );

        if (!corrResult.rows[0]) {
          return res.json({ correlation_id: null, objects: [] });
        }

        const correlationId = corrResult.rows[0].correlation_id;

        // 같은 correlation_id의 모든 객체 요약
        const objectsResult = await pool.query(
          `
          SELECT
            object_type,
            object_id,
            COUNT(*) AS event_count,
            MIN(occurred_at) AS first_event_at,
            MAX(occurred_at) AS last_event_at,
            MAX(CASE WHEN is_final_decision THEN event_name END) AS last_final_event
          FROM events
          WHERE correlation_id = $1
          GROUP BY object_type, object_id
          ORDER BY MIN(occurred_at) ASC
          `,
          [correlationId]
        );

        res.json({
          correlation_id: correlationId,
          objects: objectsResult.rows,
        });
      } catch (error) {
        res.status(500).json({ error: String(error) });
      }
    }
  );

  return router;
}

// ── 헬퍼: 현재 projection 상태 조회 ─────────────────────────────────────────
async function getCurrentProjectionState(
  pool: Pool,
  objectType: string,
  objectId: string
): Promise<Record<string, unknown> | null> {
  const tableMap: Record<string, { table: string; idCol: string }> = {
    inquiry:   { table: 'inquiries',           idCol: 'inquiry_id' },
    quote:     { table: 'quotes',              idCol: 'quote_id' },
    order:     { table: 'orders',              idCol: 'order_id' },
    shipment:  { table: 'shipments',           idCol: 'shipment_id' },
    exception: { table: 'exceptions',          idCol: 'exception_id' },
    task:      { table: 'tasks',               idCol: 'task_id' },
  };

  const mapping = tableMap[objectType];
  if (!mapping) return null;

  const result = await pool.query(
    `SELECT * FROM ${mapping.table} WHERE ${mapping.idCol} = $1`,
    [objectId]
  );

  return result.rows[0] ?? null;
}
