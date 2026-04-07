// =============================================================================
// src/core/projection/projector.interface.ts
// 티켓 4: Projector Skeleton
// 원칙:
//   - projector는 business truth를 만들지 않는다
//   - projector는 event를 current로 변환하는 소비자다
//   - projector 내부에서 direct write로 상태 확정 금지
//   - projector가 권한 판단 수행 금지
// =============================================================================

import { Pool } from 'pg';
import { EventRecord, ObjectType } from '../event-store/events.types';

// ── Projector 인터페이스 ──────────────────────────────────────────────────────
export interface IProjector {
  /** 이 projector가 처리하는 object_type */
  readonly objectType: ObjectType;

  /**
   * 이벤트를 받아 current projection을 갱신.
   * 실패 시 throw → dispatcher가 재시도.
   * 이 메서드는 권한 판단을 수행하지 않는다.
   */
  project(event: EventRecord): Promise<void>;

  /**
   * 특정 객체를 전체 이벤트 이력으로 재투영.
   * reconciliation job이 사용.
   */
  replay(objectId: string): Promise<void>;
}

// ── Projection 메타데이터 업데이트 헬퍼 ────────────────────────────────────────
export async function updateProjectionMeta(
  pool: Pool,
  tableName: string,
  objectId: string,
  event: EventRecord
): Promise<void> {
  await pool.query(
    `UPDATE ${tableName}
     SET last_event_id           = $1,
         last_projected_event_id = $1,
         projected_at            = NOW(),
         projection_version      = projection_version + 1,
         updated_at              = NOW()
     WHERE ${getIdColumn(tableName)} = $2`,
    [event.event_id, objectId]
  );
}

function getIdColumn(tableName: string): string {
  const map: Record<string, string> = {
    inquiries:            'inquiry_id',
    quotes:               'quote_id',
    orders:               'order_id',
    shipments:            'shipment_id',
    exceptions:           'exception_id',
    tasks:                'task_id',
    inventory_snapshots:  'snapshot_id',
  };
  return map[tableName] ?? `${tableName.replace(/s$/, '')}_id`;
}
