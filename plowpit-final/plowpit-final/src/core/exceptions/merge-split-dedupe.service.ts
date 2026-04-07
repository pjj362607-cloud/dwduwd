// =============================================================================
// src/core/exceptions/merge-split-dedupe.service.ts
// 티켓 11: Merge / Split / Dedupe
// 원칙:
//   - 병합 후 원본/생존 객체 추적 가능
//   - 부분출고: parent-child 구조로 남음 (예외가 아니라 정식 상태)
//   - dedupe hit: 즉시 병합하지 않고 후보/예외로 남김
//   - external_event_id: 강한 멱등성 키
//   - dedupe_key: 중복 의심 후보 비교용 (강제 동일성 키 아님)
// =============================================================================

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  ObjectType,
  AppendEventResult,
  EventCoreError,
  EventCoreErrorCode,
} from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';
import { TransitionObjectService } from '../transition/transition-object.service';

// ── 병합 입력 ──────────────────────────────────────────────────────────────────
export interface MergeObjectsInput {
  object_type: ObjectType;
  source_object_id: string;    // 병합될 원본 (closed_merged 처리)
  target_object_id: string;    // 생존 객체 (유지)
  actor_id: string;
  actor_role: string;
  reason_code: string;
  correlation_id?: string;
  merge_notes?: string;
}

// ── 부분출고 분할 입력 ──────────────────────────────────────────────────────────
export interface SplitShipmentInput {
  parent_shipment_id: string;
  dispatch_items: Array<{
    item_id: string;
    qty: number;
    unit: string;
  }>;
  remainder_items: Array<{
    item_id: string;
    qty: number;
    unit: string;
  }>;
  actor_id: string;
  actor_role: string;
  split_reason?: string;
  correlation_id?: string;
}

// ── Dedupe 후보 등록 입력 ───────────────────────────────────────────────────────
export interface RegisterDedupeCandiateInput {
  object_type: ObjectType;
  original_event_id: string;
  original_object_id: string;
  suspect_event_id: string;
  suspect_object_id?: string;
  dedupe_key?: string;
  match_score?: number;
  match_fields?: Record<string, unknown>;
}

export class MergeSplitDedupeService {
  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService,
    private readonly transitionObjectService: TransitionObjectService
  ) {}

  // ── 병합 ──────────────────────────────────────────────────────────────────────
  /**
   * 중복 객체 병합.
   * 원본(source)은 closed_merged로 전이.
   * 생존(target)은 유지.
   * 원본/생존 관계는 이벤트 + object_links로 추적.
   */
  async mergeObjects(input: MergeObjectsInput): Promise<{
    source_event: AppendEventResult;
    target_event: AppendEventResult;
  }> {
    // ── 1. 원본 객체 closed_merged 전이 ──────────────────────────────────
    const sourceEvent = await this.transitionObjectService.transition({
      object_type: input.object_type,
      object_id: input.source_object_id,
      event_name: this.getMergeEventName(input.object_type),
      from_state: '',
      to_state: 'closed_merged',
      actor_type: 'user',
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      reason_code: input.reason_code,
      payload_json: {
        merged_into: input.target_object_id,
        merge_notes: input.merge_notes,
      },
      payload_schema_version: 'v1',
      correlation_id: input.correlation_id,
      is_final_decision: true,
    });

    // ── 2. 생존 객체에 병합 수신 이벤트 기록 ─────────────────────────────
    const targetEvent = await this.appendEventService.append({
      object_type: input.object_type,
      object_id: input.target_object_id,
      event_name: `${input.object_type}_received_merge`,
      actor_type: 'user',
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      reason_code: input.reason_code,
      payload_json: {
        merged_from: input.source_object_id,
        source_event_id: sourceEvent.event_id,
      },
      payload_schema_version: 'v1',
      correlation_id: input.correlation_id,
      caused_by_event_id: sourceEvent.event_id,
      is_final_decision: false,
    });

    // ── 3. object_links로 병합 관계 기록 ─────────────────────────────────
    await this.pool.query(
      `
      INSERT INTO object_links (
        source_object_type, source_object_id,
        target_object_type, target_object_id,
        link_type, created_by_event_id, correlation_id
      ) VALUES ($1, $2, $3, $4, 'merged_into', $5, $6)
      ON CONFLICT DO NOTHING
      `,
      [
        input.object_type,
        input.source_object_id,
        input.object_type,
        input.target_object_id,
        sourceEvent.event_id,
        input.correlation_id ?? null,
      ]
    );

    return { source_event: sourceEvent, target_event: targetEvent };
  }

  // ── 부분출고 분할 ──────────────────────────────────────────────────────────
  /**
   * 부분출고 처리: 정식 상태로 처리 (예외 아님).
   * parent shipment → partial_dispatched
   * child shipment(잔량) 생성 → remainder_pending
   * parent-child 연결 유지
   */
  async splitShipment(input: SplitShipmentInput): Promise<{
    parent_event: AppendEventResult;
    child_shipment_id: string;
    child_event: AppendEventResult;
  }> {
    const childShipmentId = uuidv4();

    // ── 1. child shipment 생성 (잔량) ─────────────────────────────────────
    await this.pool.query(
      `
      INSERT INTO shipments (
        shipment_id, parent_shipment_id, correlation_id,
        items, is_partial, current_state
      ) VALUES ($1, $2, $3, $4, TRUE, 'remainder_pending')
      `,
      [
        childShipmentId,
        input.parent_shipment_id,
        input.correlation_id ?? null,
        JSON.stringify(input.remainder_items),
      ]
    );

    // ── 2. parent shipment partial_dispatched 전이 ─────────────────────────
    const parentEvent = await this.transitionObjectService.transition({
      object_type: 'shipment',
      object_id: input.parent_shipment_id,
      event_name: 'shipment_partial_dispatched',
      from_state: '',
      to_state: 'partial_dispatched',
      actor_type: 'user',
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      reason_code: input.split_reason ?? 'partial_shipment',
      payload_json: {
        dispatch_items: input.dispatch_items,
        remainder_items: input.remainder_items,
        child_shipment_id: childShipmentId,
      },
      payload_schema_version: 'v1',
      correlation_id: input.correlation_id,
      is_final_decision: false,
    });

    // ── 3. child shipment 이벤트 기록 ─────────────────────────────────────
    const childEvent = await this.appendEventService.append({
      object_type: 'shipment',
      object_id: childShipmentId,
      event_name: 'shipment_created',
      from_state: null,
      to_state: 'remainder_pending',
      actor_type: 'user',
      actor_id: input.actor_id,
      actor_role: input.actor_role,
      payload_json: {
        parent_shipment_id: input.parent_shipment_id,
        remainder_items: input.remainder_items,
        split_event_id: parentEvent.event_id,
      },
      payload_schema_version: 'v1',
      correlation_id: input.correlation_id,
      caused_by_event_id: parentEvent.event_id,
      is_final_decision: false,
    });

    // ── 4. shipment_splits 테이블에 분할 이력 기록 ────────────────────────
    await this.pool.query(
      `
      INSERT INTO shipment_splits (
        parent_shipment_id, child_shipment_id, split_event_id,
        split_items, remainder_items, split_reason
      ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.parent_shipment_id,
        childShipmentId,
        parentEvent.event_id,
        JSON.stringify(input.dispatch_items),
        JSON.stringify(input.remainder_items),
        input.split_reason ?? 'partial_shipment',
      ]
    );

    // ── 5. object_links로 parent-child 연결 ──────────────────────────────
    await this.pool.query(
      `
      INSERT INTO object_links (
        source_object_type, source_object_id,
        target_object_type, target_object_id,
        link_type, created_by_event_id, correlation_id
      ) VALUES ('shipment', $1, 'shipment', $2, 'split_from', $3, $4)
      ON CONFLICT DO NOTHING
      `,
      [
        input.parent_shipment_id,
        childShipmentId,
        parentEvent.event_id,
        input.correlation_id ?? null,
      ]
    );

    return {
      parent_event: parentEvent,
      child_shipment_id: childShipmentId,
      child_event: childEvent,
    };
  }

  // ── Dedupe 후보 등록 ────────────────────────────────────────────────────────
  /**
   * 중복 의심 후보 등록.
   * dedupe hit 시 즉시 병합하지 않고 후보/예외로 남긴다.
   * dedupe_key는 강제 동일성 키가 아니라 중복 의심 후보 비교용.
   */
  async registerDedupeCandidate(
    input: RegisterDedupeCandiateInput
  ): Promise<string> {
    const candidateId = uuidv4();

    await this.pool.query(
      `
      INSERT INTO dedupe_candidates (
        candidate_id, object_type,
        original_event_id, original_object_id,
        suspect_event_id, suspect_object_id,
        dedupe_key, match_score, match_fields,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      `,
      [
        candidateId,
        input.object_type,
        input.original_event_id,
        input.original_object_id,
        input.suspect_event_id,
        input.suspect_object_id ?? null,
        input.dedupe_key ?? null,
        input.match_score ?? null,
        input.match_fields ? JSON.stringify(input.match_fields) : null,
      ]
    );

    return candidateId;
  }

  /**
   * 중복 후보 해소.
   * confirmed_duplicate → 병합 처리
   * confirmed_distinct  → 해소 기록
   */
  async resolveDedupeCandidate(params: {
    candidate_id: string;
    resolution: 'confirmed_duplicate' | 'confirmed_distinct';
    resolver_id: string;
    resolver_role: string;
    resolution_event_id?: string;
  }): Promise<void> {
    await this.pool.query(
      `
      UPDATE dedupe_candidates
      SET status            = $1,
          resolved_by       = $2,
          resolved_at       = NOW(),
          resolution_event_id = $3
      WHERE candidate_id    = $4
      `,
      [
        params.resolution,
        params.resolver_id,
        params.resolution_event_id ?? null,
        params.candidate_id,
      ]
    );
  }

  /**
   * dedupe_key 기반 중복 의심 후보 검색 (강제 확정 아님).
   */
  async findDedupeCandidates(
    objectType: ObjectType,
    dedupeKey: string
  ): Promise<Array<{ candidate_id: string; match_score: number }>> {
    const result = await this.pool.query<{
      candidate_id: string;
      match_score: string;
    }>(
      `SELECT candidate_id, match_score
       FROM dedupe_candidates
       WHERE object_type = $1
         AND dedupe_key = $2
         AND status = 'pending'
       ORDER BY match_score DESC NULLS LAST`,
      [objectType, dedupeKey]
    );

    return result.rows.map((r) => ({
      candidate_id: r.candidate_id,
      match_score: parseFloat(r.match_score ?? '0'),
    }));
  }

  private getMergeEventName(objectType: ObjectType): string {
    const map: Partial<Record<ObjectType, string>> = {
      inquiry:   'inquiry_merged',
      order:     'order_merged',
      exception: 'exception_merged',
    };
    const name = map[objectType];
    if (!name) {
      throw new EventCoreError(
        `병합 불가한 object_type: ${objectType}`,
        EventCoreErrorCode.INVALID_TRANSITION
      );
    }
    return name;
  }
}
