// =============================================================================
// src/core/projection/projector.dispatcher.ts
// 티켓 4: Projector Dispatcher
// 원칙:
//   - object_type별 projector로 라우팅
//   - consumer 실패 시 재시도/재투영 가능 구조
//   - projector 내용 비어 있어도 파이프라인 동작
// =============================================================================

import { EventRecord, ObjectType } from '../event-store/events.types';
import { IProjector } from './projector.interface';

interface DispatchRecord {
  event: EventRecord;
  attempts: number;
  lastError?: Error;
}

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

export class ProjectorDispatcher {
  private readonly projectors = new Map<ObjectType, IProjector>();
  // 실패한 이벤트 큐 (reconciliation job이 처리)
  private readonly failedQueue: DispatchRecord[] = [];

  // ── Universal Listener (AI 제품 알림 브리지용) ───────────────────────────
  // object_type에 관계없이 모든 이벤트를 수신한다.
  // 알림/자동조치/티켓 처리용. projector와 독립적으로 실행.
  private readonly universalListeners: Array<(event: EventRecord) => Promise<void>> = [];

  addUniversalListener(listener: (event: EventRecord) => Promise<void>): void {
    this.universalListeners.push(listener);
  }

  /**
   * projector 등록.
   * 각 object_type마다 하나의 projector.
   */
  register(projector: IProjector): void {
    this.projectors.set(projector.objectType, projector);
  }

  /**
   * 이벤트를 해당 object_type의 projector로 dispatch.
   * 등록된 projector가 없으면 건너뜀 (에러 아님 - skeleton 단계 허용).
   * 실패 시 재시도, 최종 실패 시 failedQueue에 보관.
   */
  async dispatch(event: EventRecord): Promise<void> {
    const projector = this.projectors.get(event.object_type);

    if (!projector) {
      // 아직 projector가 등록되지 않은 object_type: skip (skeleton 단계)
      // Universal listener는 projector 없어도 호출한다.
      this.fireUniversalListeners(event);
      return;
    }

    await this.dispatchWithRetry({ event, attempts: 0 });

    // projector 성공 후에도 universal listener 호출
    this.fireUniversalListeners(event);
  }

  private fireUniversalListeners(event: EventRecord): void {
    for (const listener of this.universalListeners) {
      listener(event).catch((err) => {
        // universal listener 실패는 이벤트 처리 결과에 영향 없음
        console.error('[UniversalListener] 오류:', err);
      });
    }
  }

  private async dispatchWithRetry(record: DispatchRecord): Promise<void> {
    const { event } = record;
    const projector = this.projectors.get(event.object_type);
    if (!projector) return;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        await projector.project(event);
        return; // 성공
      } catch (error) {
        record.lastError = error instanceof Error ? error : new Error(String(error));
        record.attempts = attempt;

        if (attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS * attempt); // exponential backoff
        }
      }
    }

    // 최종 실패: failedQueue에 보관 (reconciliation job이 나중에 처리)
    this.failedQueue.push(record);
    console.error(
      `[ProjectorDispatcher] 최종 실패 - object_type=${event.object_type} ` +
      `event_id=${event.event_id} 오류: ${record.lastError?.message}`
    );
  }

  /**
   * 실패 큐 재처리 (reconciliation job에서 호출).
   */
  async retryFailed(): Promise<{ retried: number; stillFailed: number }> {
    const toRetry = this.failedQueue.splice(0);
    let successCount = 0;

    for (const record of toRetry) {
      try {
        await this.dispatchWithRetry({ ...record, attempts: 0 });
        successCount++;
      } catch {
        // 여전히 실패하면 다시 큐에 추가됨 (dispatchWithRetry 내부에서)
      }
    }

    return {
      retried: toRetry.length,
      stillFailed: this.failedQueue.length,
    };
  }

  getFailedQueueSize(): number {
    return this.failedQueue.length;
  }

  getRegisteredProjectors(): ObjectType[] {
    return [...this.projectors.keys()];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
