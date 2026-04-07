// =============================================================================
// src/core/projection/projectors/index.ts
// 티켓 12: Current Projectors
// 원칙:
//   - current는 event replay로 재생성 가능
//   - current와 event 충돌 시 event 우선
//   - projection 메타데이터 확인 가능
//   - projector는 권한 판단 수행 금지
//   - projection에서 business decision 추가 금지
// =============================================================================

import { Pool } from 'pg';
import { EventRecord } from '../../event-store/events.types';
import { IProjector, updateProjectionMeta } from '../projector.interface';
import { AppendEventService } from '../../event-store/append-event.service';

// ── Inquiry Projector ──────────────────────────────────────────────────────────
export class InquiryProjector implements IProjector {
  readonly objectType = 'inquiry' as const;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  async project(event: EventRecord): Promise<void> {
    switch (event.event_name) {
      case 'inquiry_received': {
        const payload = event.payload_json as Record<string, unknown>;
        await this.pool.query(
          `
          INSERT INTO inquiries (
            inquiry_id, correlation_id, customer_name, customer_id,
            raw_text, source_channel, current_state,
            last_event_id, last_projected_event_id, projected_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NOW())
          ON CONFLICT (inquiry_id) DO UPDATE SET
            current_state           = $7,
            last_event_id           = $8,
            last_projected_event_id = $8,
            projected_at            = NOW(),
            updated_at              = NOW()
          `,
          [
            event.object_id,
            event.correlation_id,
            payload.customer_name ?? null,
            payload.customer_id ?? null,
            payload.raw_text ?? null,
            payload.source_channel ?? event.source_channel,
            event.to_state ?? 'received',
            event.event_id,
          ]
        );
        break;
      }

      case 'inquiry_parsed_by_ai': {
        const payload = event.payload_json as Record<string, unknown>;
        // AI 파싱 결과는 current에 반영하지만 최종 확정 아님
        await this.pool.query(
          `
          UPDATE inquiries SET
            parsed_items            = $1::jsonb,
            customer_name           = COALESCE($2, customer_name),
            last_event_id           = $3,
            last_projected_event_id = $3,
            projected_at            = NOW(),
            updated_at              = NOW()
          WHERE inquiry_id = $4
          `,
          [
            JSON.stringify(payload.parsed_items ?? []),
            payload.customer_name ?? null,
            event.event_id,
            event.object_id,
          ]
        );
        break;
      }

      default: {
        // 상태 전이 이벤트: to_state로 current_state 갱신
        if (event.to_state) {
          await this.pool.query(
            `
            UPDATE inquiries SET
              current_state           = $1,
              last_event_id           = $2,
              last_projected_event_id = $2,
              projected_at            = NOW(),
              updated_at              = NOW()
            WHERE inquiry_id = $3
            `,
            [event.to_state, event.event_id, event.object_id]
          );
        }
        break;
      }
    }
  }

  async replay(objectId: string): Promise<void> {
    // 1. current 초기화
    await this.pool.query(
      `DELETE FROM inquiries WHERE inquiry_id = $1`,
      [objectId]
    );
    // 2. 전체 이벤트 재처리
    const events = await this.appendEventService.getEventHistory('inquiry', objectId);
    for (const event of events) {
      await this.project(event);
    }
  }
}

// ── Quote Projector ────────────────────────────────────────────────────────────
export class QuoteProjector implements IProjector {
  readonly objectType = 'quote' as const;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  async project(event: EventRecord): Promise<void> {
    const payload = event.payload_json as Record<string, unknown>;

    switch (event.event_name) {
      case 'quote_draft_created': {
        await this.pool.query(
          `
          INSERT INTO quotes (
            quote_id, inquiry_id, correlation_id,
            customer_id, items, total_amount, due_date, notes,
            current_state, current_revision_no,
            last_event_id, last_projected_event_id, projected_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, NOW())
          ON CONFLICT (quote_id) DO UPDATE SET
            current_state           = $9,
            last_event_id           = $11,
            last_projected_event_id = $11,
            projected_at            = NOW(),
            updated_at              = NOW()
          `,
          [
            event.object_id,
            payload.inquiry_id ?? null,
            event.correlation_id,
            payload.customer_id ?? null,
            JSON.stringify(payload.items ?? []),
            payload.total_amount ?? null,
            payload.due_date ?? null,
            payload.notes ?? null,
            event.to_state ?? 'drafting',
            event.revision_no ?? 1,
            event.event_id,
          ]
        );
        break;
      }

      case 'quote_revision_requested': {
        // revision_no 증가 + 내용 업데이트 (overwrite 아님)
        const changes = (payload.changes ?? {}) as Record<string, unknown>;
        await this.pool.query(
          `
          UPDATE quotes SET
            current_state           = $1,
            current_revision_no     = $2,
            items                   = COALESCE($3::jsonb, items),
            total_amount            = COALESCE($4, total_amount),
            due_date                = COALESCE($5, due_date),
            notes                   = COALESCE($6, notes),
            last_event_id           = $7,
            last_projected_event_id = $7,
            projected_at            = NOW(),
            updated_at              = NOW()
          WHERE quote_id = $8
          `,
          [
            event.to_state ?? 'revision_requested',
            event.revision_no ?? 1,
            changes.items ? JSON.stringify(changes.items) : null,
            changes.total_amount ?? null,
            changes.due_date ?? null,
            changes.notes ?? null,
            event.event_id,
            event.object_id,
          ]
        );
        break;
      }

      default: {
        if (event.to_state) {
          await this.pool.query(
            `
            UPDATE quotes SET
              current_state           = $1,
              last_event_id           = $2,
              last_projected_event_id = $2,
              projected_at            = NOW(),
              updated_at              = NOW()
            WHERE quote_id = $3
            `,
            [event.to_state, event.event_id, event.object_id]
          );
        }
        break;
      }
    }
  }

  async replay(objectId: string): Promise<void> {
    await this.pool.query(`DELETE FROM quotes WHERE quote_id = $1`, [objectId]);
    const events = await this.appendEventService.getEventHistory('quote', objectId);
    for (const event of events) {
      await this.project(event);
    }
  }
}

// ── Order Projector ────────────────────────────────────────────────────────────
export class OrderProjector implements IProjector {
  readonly objectType = 'order' as const;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  async project(event: EventRecord): Promise<void> {
    const payload = event.payload_json as Record<string, unknown>;

    switch (event.event_name) {
      case 'order_draft_created': {
        await this.pool.query(
          `
          INSERT INTO orders (
            order_id, quote_id, correlation_id,
            customer_id, items, total_amount, requested_delivery_date,
            current_state, current_revision_no,
            last_event_id, last_projected_event_id, projected_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9, NOW())
          ON CONFLICT (order_id) DO UPDATE SET
            current_state           = $8,
            last_event_id           = $9,
            last_projected_event_id = $9,
            projected_at            = NOW(),
            updated_at              = NOW()
          `,
          [
            event.object_id,
            payload.quote_id ?? null,
            event.correlation_id,
            payload.customer_id ?? null,
            JSON.stringify(payload.items ?? []),
            payload.total_amount ?? null,
            payload.requested_delivery_date ?? null,
            event.to_state ?? 'registration_pending',
            event.event_id,
          ]
        );
        break;
      }

      default: {
        if (event.to_state) {
          await this.pool.query(
            `
            UPDATE orders SET
              current_state           = $1,
              current_revision_no     = COALESCE($2, current_revision_no),
              last_event_id           = $3,
              last_projected_event_id = $3,
              projected_at            = NOW(),
              updated_at              = NOW()
            WHERE order_id = $4
            `,
            [
              event.to_state,
              event.revision_no > 1 ? event.revision_no : null,
              event.event_id,
              event.object_id,
            ]
          );
        }
        break;
      }
    }
  }

  async replay(objectId: string): Promise<void> {
    await this.pool.query(`DELETE FROM orders WHERE order_id = $1`, [objectId]);
    const events = await this.appendEventService.getEventHistory('order', objectId);
    for (const event of events) {
      await this.project(event);
    }
  }
}

// ── Shipment Projector ─────────────────────────────────────────────────────────
export class ShipmentProjector implements IProjector {
  readonly objectType = 'shipment' as const;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  async project(event: EventRecord): Promise<void> {
    const payload = event.payload_json as Record<string, unknown>;

    switch (event.event_name) {
      case 'shipment_created': {
        await this.pool.query(
          `
          INSERT INTO shipments (
            shipment_id, order_id, parent_shipment_id, correlation_id,
            items, is_partial, current_state,
            last_event_id, last_projected_event_id, projected_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, NOW())
          ON CONFLICT (shipment_id) DO UPDATE SET
            current_state           = $7,
            last_event_id           = $8,
            last_projected_event_id = $8,
            projected_at            = NOW(),
            updated_at              = NOW()
          `,
          [
            event.object_id,
            payload.order_id ?? null,
            payload.parent_shipment_id ?? null,
            event.correlation_id,
            JSON.stringify(payload.items ?? []),
            payload.parent_shipment_id ? true : false,
            event.to_state ?? 'preparing',
            event.event_id,
          ]
        );
        break;
      }

      case 'shipment_partial_dispatched': {
        await this.pool.query(
          `
          UPDATE shipments SET
            current_state           = 'partial_dispatched',
            is_partial              = TRUE,
            items                   = $1::jsonb,
            last_event_id           = $2,
            last_projected_event_id = $2,
            projected_at            = NOW(),
            updated_at              = NOW()
          WHERE shipment_id = $3
          `,
          [
            JSON.stringify(payload.dispatch_items ?? []),
            event.event_id,
            event.object_id,
          ]
        );
        break;
      }

      default: {
        if (event.to_state) {
          await this.pool.query(
            `
            UPDATE shipments SET
              current_state           = $1,
              actual_date             = CASE
                WHEN $1 = 'closed_completed' THEN NOW()::DATE
                ELSE actual_date
              END,
              last_event_id           = $2,
              last_projected_event_id = $2,
              projected_at            = NOW(),
              updated_at              = NOW()
            WHERE shipment_id = $3
            `,
            [event.to_state, event.event_id, event.object_id]
          );
        }
        break;
      }
    }
  }

  async replay(objectId: string): Promise<void> {
    await this.pool.query(`DELETE FROM shipments WHERE shipment_id = $1`, [objectId]);
    const events = await this.appendEventService.getEventHistory('shipment', objectId);
    for (const event of events) {
      await this.project(event);
    }
  }
}

// ── Exception Projector ────────────────────────────────────────────────────────
export class ExceptionProjector implements IProjector {
  readonly objectType = 'exception' as const;

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  async project(event: EventRecord): Promise<void> {
    const payload = event.payload_json as Record<string, unknown>;

    switch (event.event_name) {
      case 'exception_created': {
        // exception projection은 ExceptionsService가 직접 생성하므로
        // projector는 메타데이터만 갱신
        await updateProjectionMeta(this.pool, 'exceptions', event.object_id, event);
        break;
      }

      case 'exception_type_suggested_by_ai': {
        // AI 분류 추천: 참고용으로만 저장. 확정 아님.
        await this.pool.query(
          `
          UPDATE exceptions SET
            ai_suggested_type       = $1,
            ai_suggested_priority   = $2,
            last_event_id           = $3,
            last_projected_event_id = $3,
            projected_at            = NOW(),
            updated_at              = NOW()
          WHERE exception_id = $4
          `,
          [
            payload.suggested_type ?? null,
            payload.suggested_priority ?? null,
            event.event_id,
            event.object_id,
          ]
        );
        break;
      }

      default: {
        if (event.to_state) {
          await this.pool.query(
            `
            UPDATE exceptions SET
              current_state           = $1,
              last_event_id           = $2,
              last_projected_event_id = $2,
              projected_at            = NOW(),
              updated_at              = NOW()
            WHERE exception_id = $3
            `,
            [event.to_state, event.event_id, event.object_id]
          );
        }
        break;
      }
    }
  }

  async replay(objectId: string): Promise<void> {
    // exception은 ExceptionsService가 초기 레코드를 생성하므로
    // replay 시에는 상태만 초기화 후 재처리
    await this.pool.query(
      `UPDATE exceptions SET current_state = 'created',
       last_event_id = NULL, last_projected_event_id = NULL
       WHERE exception_id = $1`,
      [objectId]
    );
    const events = await this.appendEventService.getEventHistory('exception', objectId);
    for (const event of events) {
      await this.project(event);
    }
  }
}
