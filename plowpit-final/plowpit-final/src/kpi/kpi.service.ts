// =============================================================================
// src/kpi/kpi.service.ts
// 티켓 16: KPI 최소 계산층
// 원칙:
//   - KPI는 current 값이 아니라 event 기준으로 계산
//   - 수기 계산 없이 조회 가능
//   - before/after 비교 가능
// 필수 KPI 5종 + 예외 처리 시간
// =============================================================================

import { Pool } from 'pg';

export interface KPIPeriod {
  from: Date;
  to: Date;
}

export interface KPISummary {
  period: KPIPeriod;
  quote_response_time:    QuoteResponseTimeKPI;
  order_missing_count:    OrderMissingCountKPI;
  inventory_mismatch:     InventoryMismatchKPI;
  shipment_delay_count:   ShipmentDelayKPI;
  ceo_intervention_count: CEOInterventionKPI;
  exception_resolution_time: ExceptionResolutionTimeKPI;
  computed_at: Date;
}

export interface QuoteResponseTimeKPI {
  // 문의 접수 → 견적 발송까지 평균 시간 (시간 단위)
  avg_hours: number;
  p50_hours: number;
  p90_hours: number;
  count: number;
}

export interface OrderMissingCountKPI {
  // 주문이 누락된 건수: 견적이 order_pending 상태인데 주문이 생성되지 않은 경우
  count: number;
  oldest_pending_hours: number;
}

export interface InventoryMismatchKPI {
  // 재고 재확인 요청 건수 (inventory_insufficient → recheck)
  recheck_count: number;
  // 재고 불일치로 인한 예외 건수
  exception_count: number;
}

export interface ShipmentDelayKPI {
  // 출고 지연 건수 (shipment_delay_flagged 이벤트 발생)
  delay_count: number;
  // 예정일 기준 초과 출고 건수
  overdue_count: number;
  avg_delay_hours: number;
}

export interface CEOInterventionKPI {
  // Approver 역할 개입 횟수 (= 대표 직접 승인 등)
  // 설계상 대표 = Admin 또는 Approver 역할로 직접 최종 확정한 횟수
  count: number;
  by_object_type: Record<string, number>;
}

export interface ExceptionResolutionTimeKPI {
  // 예외 생성 → 종료까지 평균 시간
  avg_hours: number;
  p50_hours: number;
  by_severity: Record<string, { avg_hours: number; count: number }>;
}

export class KPIService {
  constructor(private readonly pool: Pool) {}

  /**
   * 전체 KPI 한 번에 계산.
   * 모든 지표는 events 테이블 기준.
   */
  async computeAll(period: KPIPeriod): Promise<KPISummary> {
    const [
      quoteResponseTime,
      orderMissing,
      inventoryMismatch,
      shipmentDelay,
      ceoIntervention,
      exceptionResolution,
    ] = await Promise.all([
      this.computeQuoteResponseTime(period),
      this.computeOrderMissingCount(period),
      this.computeInventoryMismatch(period),
      this.computeShipmentDelay(period),
      this.computeCEOInterventionCount(period),
      this.computeExceptionResolutionTime(period),
    ]);

    return {
      period,
      quote_response_time:       quoteResponseTime,
      order_missing_count:       orderMissing,
      inventory_mismatch:        inventoryMismatch,
      shipment_delay_count:      shipmentDelay,
      ceo_intervention_count:    ceoIntervention,
      exception_resolution_time: exceptionResolution,
      computed_at: new Date(),
    };
  }

  // ── KPI 1: 견적 응답 시간 ─────────────────────────────────────────────────
  // 문의 접수(inquiry_received) → 견적 발송(quote_approved 또는 quote_sent)까지
  async computeQuoteResponseTime(period: KPIPeriod): Promise<QuoteResponseTimeKPI> {
    const result = await this.pool.query<{
      avg_hours: string;
      p50_hours: string;
      p90_hours: string;
      count: string;
    }>(
      `
      WITH inquiry_received AS (
        SELECT object_id AS inquiry_id, occurred_at AS received_at
        FROM events
        WHERE event_name = 'inquiry_received'
          AND occurred_at BETWEEN $1 AND $2
      ),
      quote_sent AS (
        SELECT
          ol.source_object_id AS inquiry_id,
          MIN(e.occurred_at)  AS sent_at
        FROM events e
        JOIN object_links ol
          ON ol.target_object_id = e.object_id
          AND ol.source_object_type = 'inquiry'
          AND ol.target_object_type = 'quote'
        WHERE e.event_name IN ('quote_approved', 'quote_sent')
          AND e.occurred_at BETWEEN $1 AND $2
        GROUP BY ol.source_object_id
      ),
      response_times AS (
        SELECT
          EXTRACT(EPOCH FROM (qs.sent_at - ir.received_at)) / 3600 AS hours
        FROM inquiry_received ir
        JOIN quote_sent qs ON qs.inquiry_id = ir.inquiry_id
        WHERE qs.sent_at > ir.received_at
      )
      SELECT
        ROUND(AVG(hours)::numeric, 2)                   AS avg_hours,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2) AS p50_hours,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY hours)::numeric, 2) AS p90_hours,
        COUNT(*)::TEXT                                   AS count
      FROM response_times
      `,
      [period.from, period.to]
    );

    const row = result.rows[0];
    return {
      avg_hours: parseFloat(row?.avg_hours ?? '0'),
      p50_hours: parseFloat(row?.p50_hours ?? '0'),
      p90_hours: parseFloat(row?.p90_hours ?? '0'),
      count: parseInt(row?.count ?? '0', 10),
    };
  }

  // ── KPI 2: 주문 누락 건수 ────────────────────────────────────────────────
  // 견적이 order_pending 상태인데 주문이 생성되지 않은 경우
  async computeOrderMissingCount(period: KPIPeriod): Promise<OrderMissingCountKPI> {
    const result = await this.pool.query<{
      count: string;
      oldest_pending_hours: string;
    }>(
      `
      WITH quote_order_pending AS (
        SELECT object_id AS quote_id, occurred_at
        FROM events
        WHERE event_name = 'quote_order_pending'
          AND occurred_at BETWEEN $1 AND $2
      ),
      quotes_with_orders AS (
        SELECT DISTINCT ol.source_object_id AS quote_id
        FROM object_links ol
        WHERE ol.source_object_type = 'quote'
          AND ol.target_object_type = 'order'
          AND ol.link_type = 'quote_to_order'
      )
      SELECT
        COUNT(qop.quote_id)::TEXT AS count,
        ROUND(
          MAX(EXTRACT(EPOCH FROM (NOW() - qop.occurred_at)) / 3600)::numeric, 1
        ) AS oldest_pending_hours
      FROM quote_order_pending qop
      LEFT JOIN quotes_with_orders qwo ON qwo.quote_id = qop.quote_id
      WHERE qwo.quote_id IS NULL   -- 주문이 아직 연결되지 않은 견적
      `,
      [period.from, period.to]
    );

    const row = result.rows[0];
    return {
      count: parseInt(row?.count ?? '0', 10),
      oldest_pending_hours: parseFloat(row?.oldest_pending_hours ?? '0'),
    };
  }

  // ── KPI 3: 재고 불일치 건수 ──────────────────────────────────────────────
  async computeInventoryMismatch(period: KPIPeriod): Promise<InventoryMismatchKPI> {
    const result = await this.pool.query<{
      recheck_count: string;
      exception_count: string;
    }>(
      `
      SELECT
        (SELECT COUNT(*) FROM events
         WHERE event_name = 'order_inventory_recheck_requested'
           AND occurred_at BETWEEN $1 AND $2
        )::TEXT AS recheck_count,
        (SELECT COUNT(*) FROM events
         WHERE event_name = 'exception_created'
           AND payload_json->>'exception_type' = 'inventory_recheck'
           AND occurred_at BETWEEN $1 AND $2
        )::TEXT AS exception_count
      `,
      [period.from, period.to]
    );

    const row = result.rows[0];
    return {
      recheck_count: parseInt(row?.recheck_count ?? '0', 10),
      exception_count: parseInt(row?.exception_count ?? '0', 10),
    };
  }

  // ── KPI 4: 출고 지연 건수 ────────────────────────────────────────────────
  async computeShipmentDelay(period: KPIPeriod): Promise<ShipmentDelayKPI> {
    const result = await this.pool.query<{
      delay_count: string;
      avg_delay_hours: string;
    }>(
      `
      SELECT
        COUNT(*)::TEXT AS delay_count,
        ROUND(AVG(
          CASE
            WHEN payload_json->>'scheduled_date' IS NOT NULL
            THEN EXTRACT(EPOCH FROM (
              occurred_at - (payload_json->>'scheduled_date')::timestamptz
            )) / 3600
            ELSE 0
          END
        )::numeric, 2) AS avg_delay_hours
      FROM events
      WHERE event_name = 'shipment_delay_flagged'
        AND occurred_at BETWEEN $1 AND $2
      `,
      [period.from, period.to]
    );

    // 예정일 초과 완료 건수
    const overdueResult = await this.pool.query<{ overdue_count: string }>(
      `
      SELECT COUNT(*)::TEXT AS overdue_count
      FROM events e
      JOIN shipments s ON s.shipment_id = e.object_id
      WHERE e.event_name = 'shipment_completed'
        AND e.occurred_at BETWEEN $1 AND $2
        AND s.scheduled_date IS NOT NULL
        AND s.actual_date > s.scheduled_date
      `,
      [period.from, period.to]
    );

    const row = result.rows[0];
    return {
      delay_count: parseInt(row?.delay_count ?? '0', 10),
      overdue_count: parseInt(overdueResult.rows[0]?.overdue_count ?? '0', 10),
      avg_delay_hours: parseFloat(row?.avg_delay_hours ?? '0'),
    };
  }

  // ── KPI 5: 대표 개입 횟수 ────────────────────────────────────────────────
  // is_final_decision = TRUE + actor_role이 'Admin' 또는 'Approver'인 이벤트 수
  async computeCEOInterventionCount(period: KPIPeriod): Promise<CEOInterventionKPI> {
    const result = await this.pool.query<{
      object_type: string;
      count: string;
    }>(
      `
      SELECT object_type, COUNT(*)::TEXT AS count
      FROM events
      WHERE is_final_decision = TRUE
        AND actor_role IN ('Admin', 'Approver')
        AND occurred_at BETWEEN $1 AND $2
      GROUP BY object_type
      `,
      [period.from, period.to]
    );

    const byObjectType: Record<string, number> = {};
    let total = 0;
    for (const row of result.rows) {
      byObjectType[row.object_type] = parseInt(row.count, 10);
      total += parseInt(row.count, 10);
    }

    return { count: total, by_object_type: byObjectType };
  }

  // ── KPI 6: 예외 처리 시간 ─────────────────────────────────────────────────
  async computeExceptionResolutionTime(
    period: KPIPeriod
  ): Promise<ExceptionResolutionTimeKPI> {
    const result = await this.pool.query<{
      avg_hours: string;
      p50_hours: string;
      severity: string;
      sev_avg: string;
      sev_count: string;
    }>(
      `
      WITH resolution_times AS (
        SELECT
          e_close.object_id,
          ex.severity,
          EXTRACT(EPOCH FROM (
            e_close.occurred_at - e_open.occurred_at
          )) / 3600 AS hours
        FROM events e_open
        JOIN events e_close
          ON e_close.object_id = e_open.object_id
          AND e_close.event_name IN (
            'exception_closed_completed', 'exception_closed_cancelled'
          )
        JOIN exceptions ex ON ex.exception_id = e_open.object_id
        WHERE e_open.event_name = 'exception_created'
          AND e_close.occurred_at BETWEEN $1 AND $2
      )
      SELECT
        ROUND(AVG(hours)::numeric, 2)                    AS avg_hours,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY hours)::numeric, 2) AS p50_hours,
        severity,
        ROUND(AVG(hours)::numeric, 2)                    AS sev_avg,
        COUNT(*)::TEXT                                   AS sev_count
      FROM resolution_times
      GROUP BY ROLLUP(severity)
      `,
      [period.from, period.to]
    );

    const bySeverity: Record<string, { avg_hours: number; count: number }> = {};
    let avgHours = 0;
    let p50Hours = 0;

    for (const row of result.rows) {
      if (row.severity === null) {
        avgHours = parseFloat(row.avg_hours ?? '0');
        p50Hours = parseFloat(row.p50_hours ?? '0');
      } else {
        bySeverity[row.severity] = {
          avg_hours: parseFloat(row.sev_avg ?? '0'),
          count: parseInt(row.sev_count ?? '0', 10),
        };
      }
    }

    return { avg_hours: avgHours, p50_hours: p50Hours, by_severity: bySeverity };
  }
}
