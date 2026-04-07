// =============================================================================
// src/core/ai-product/notification-bridge.ts
//
// 결합 핵심 파일.
//
// 역할:
//   ProjectorDispatcher의 universal listener로 등록된다.
//   AppendEventService가 저장 후 dispatch하면,
//   AI 제품 도메인 이벤트를 감지해 텔레그램 알림 / AUTO_ACTION / 티켓을 처리한다.
//
// 결합 원칙:
//   1. 기존 코어(appendEvent, transitionObject, projector)는 수정하지 않는다.
//   2. ProjectorDispatcher에 universal listener 훅 하나만 추가한다.
//   3. 기존 코어의 B2B 도메인(inquiry/quote/order/shipment/exception)은 건드리지 않는다.
//   4. AI 제품 object_type 이벤트만 이 브리지를 통과한다.
// =============================================================================

import { EventRecord } from '../event-store/events.types';
import {
  AiObjectType,
  AiEventName,
  AI_EVENT_NAMES,
  AI_EVENT_ACTION_POLICY,
  AI_EVENT_NOTIFICATION_LEVEL,
  AiActionPolicy,
  AutoActionType,
  NotificationLevel,
} from './ai-product.types';

const AI_OBJECT_TYPES = new Set<string>([
  'ai_config', 'ai_project', 'ai_installation', 'ai_runtime',
]);

const AI_EVENT_NAME_SET = new Set<string>(Object.values(AI_EVENT_NAMES));

// ── 텔레그램 클라이언트 인터페이스 ───────────────────────────────────────────
export interface TelegramNotifier {
  sendImmediate(message: string): Promise<void>;
  sendToOps(message: string): Promise<void>;
}

// ── AUTO_ACTION 실행기 인터페이스 ─────────────────────────────────────────────
export interface AutoActionExecutor {
  execute(
    action: AutoActionType | AutoActionType[],
    event: EventRecord,
  ): Promise<{ result: 'success' | 'exhausted'; ticket_needed: boolean }>;
}

// ── 티켓 생성기 인터페이스 ────────────────────────────────────────────────────
export interface AiTicketCreator {
  create(event: EventRecord, level: NotificationLevel): Promise<string>;  // ticket_id 반환
}

// ── 요약 축적기 인터페이스 ────────────────────────────────────────────────────
export interface DigestAccumulator {
  push(entry: {
    event_name:  string;
    level:       NotificationLevel;
    customer_id: string | null;
    object_id:   string;
    occurred_at: Date;
    summary:     string;
  }): Promise<void>;
}

// ── NotificationBridge ───────────────────────────────────────────────────────
export class NotificationBridge {
  constructor(
    private readonly telegram:    TelegramNotifier,
    private readonly autoAction:  AutoActionExecutor,
    private readonly ticketMaker: AiTicketCreator,
    private readonly digest:      DigestAccumulator,
  ) {}

  /**
   * ProjectorDispatcher.addUniversalListener()에 이 메서드를 등록한다.
   * AI 제품 도메인 이벤트만 처리. 나머지는 즉시 반환.
   */
  async handle(event: EventRecord): Promise<void> {
    // AI 제품 도메인 이벤트가 아니면 건너뜀
    if (!AI_OBJECT_TYPES.has(event.object_type)) return;
    if (!AI_EVENT_NAME_SET.has(event.event_name)) return;

    const policy = AI_EVENT_ACTION_POLICY[event.event_name as AiEventName];
    const level  = AI_EVENT_NOTIFICATION_LEVEL[event.event_name as AiEventName];
    if (!policy) return;

    // 모든 처리는 병렬로 — 하나가 실패해도 나머지 진행
    await Promise.allSettled([
      this.handleDigest(event, level, policy),
      this.handleRealtimeNotify(event, level, policy),
      this.handleAutoAction(event, level, policy),
      this.handleTicket(event, level, policy),
    ]);
  }

  // ── 요약 축적 ─────────────────────────────────────────────────────────────
  private async handleDigest(
    event:  EventRecord,
    level:  NotificationLevel,
    policy: AiActionPolicy,
  ): Promise<void> {
    if (!policy.digest_notify) return;

    await this.digest.push({
      event_name:  event.event_name,
      level,
      customer_id: (event.payload_json?.customer_id as string) ?? null,
      object_id:   event.object_id,
      occurred_at: event.occurred_at,
      summary:     this.buildSummary(event),
    });
  }

  // ── 텔레그램 즉시 알림 ────────────────────────────────────────────────────
  private async handleRealtimeNotify(
    event:  EventRecord,
    level:  NotificationLevel,
    policy: AiActionPolicy,
  ): Promise<void> {
    if (!policy.realtime_notify) return;

    const icon   = level === 'critical' ? '🚨' : level === 'high' ? '🔴' : '🟡';
    const reason = event.reason_code
      ? `\n원인: ${event.reason_code}`
      : '';

    const msg = [
      `${icon} [${event.event_name}]`,
      `객체: ${event.object_type}/${event.object_id}`,
      `상태: ${event.from_state ?? '-'} → ${event.to_state ?? '-'}`,
      `행위자: ${event.actor_role}`,
      reason,
      `시각: ${event.occurred_at.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
    ].filter(Boolean).join('\n');

    // HIGH 이상은 ops 채널, CRITICAL은 incident 채널 추가
    await this.telegram.sendToOps(msg);
    if (level === 'critical') {
      await this.telegram.sendImmediate(msg);
    }
  }

  // ── AUTO_ACTION ───────────────────────────────────────────────────────────
  private async handleAutoAction(
    event:  EventRecord,
    level:  NotificationLevel,
    policy: AiActionPolicy,
  ): Promise<void> {
    if (!policy.auto_action) return;

    const result = await this.autoAction.execute(policy.auto_action, event);

    // AUTO_ACTION 소진 후 티켓 필요 → 별도 티켓 생성
    if (result.ticket_needed) {
      await this.ticketMaker.create(event, level).catch(err =>
        console.error('[NotificationBridge] 소진 후 티켓 생성 실패:', err)
      );
    }
  }

  // ── 티켓 생성 ─────────────────────────────────────────────────────────────
  private async handleTicket(
    event:  EventRecord,
    level:  NotificationLevel,
    policy: AiActionPolicy,
  ): Promise<void> {
    if (!policy.ticket_required) return;
    // AUTO_ACTION이 있는 경우 소진 후 티켓은 handleAutoAction에서 처리
    // 여기서는 auto_action이 없는 경우만
    if (policy.auto_action) return;

    await this.ticketMaker.create(event, level);
  }

  // ── 요약 문자열 생성 ──────────────────────────────────────────────────────
  private buildSummary(event: EventRecord): string {
    const parts = [event.event_name];
    if (event.reason_code) parts.push(event.reason_code);
    const msg = event.payload_json?.message as string | undefined;
    if (msg) parts.push(msg);
    return parts.join(' | ');
  }
}
