// =============================================================================
// src/core/ai-product/index.integration.patch.ts
//
// 기존 코어와 AI 제품 도메인의 결합 지점을 설명하는 패치 가이드.
//
// 실제 변경 대상 파일 2개:
//   1. src/core/projection/projector.dispatcher.ts  — universal listener 추가
//   2. src/index.ts                                 — AI 도메인 조립 추가
//
// 각 파일에 추가할 코드를 아래에 정확히 명시한다.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// [변경 1] src/core/projection/projector.dispatcher.ts
//
// ProjectorDispatcher 클래스에 아래 2개를 추가한다.
// 위치: register() 메서드 바로 아래
// ─────────────────────────────────────────────────────────────────────────────

/*
  // ── Universal Listener (AI 제품 알림 브리지용) ─────────────────────────────
  private readonly universalListeners: Array<(event: EventRecord) => Promise<void>> = [];

  addUniversalListener(listener: (event: EventRecord) => Promise<void>): void {
    this.universalListeners.push(listener);
  }
*/

// dispatch() 메서드 내부 projector 호출 이후에 아래를 추가한다:
/*
    // Universal listener 호출 (AI 제품 알림 브리지 등)
    // projector와 독립적으로 실행. 실패해도 dispatch 결과에 영향 없음.
    for (const listener of this.universalListeners) {
      listener(event).catch((err) => {
        console.error('[UniversalListener] 오류:', err);
      });
    }
*/

// ─────────────────────────────────────────────────────────────────────────────
// [변경 2] src/index.ts
//
// bootstrap() 함수 내부에 아래를 추가한다.
// 위치: projectorDispatcher 생성 이후, appendEventService 생성 이전
// ─────────────────────────────────────────────────────────────────────────────

/*
  // ── AI 제품 도메인 조립 ────────────────────────────────────────────────────

  // 1. TransitionRegistry에 AI 제품 전이 등록
  import { ALL_AI_TRANSITIONS } from './core/ai-product/ai-product-transitions';
  for (const t of ALL_AI_TRANSITIONS) {
    (transitionRegistry as any)['_registerExternal']?.(t);
    // 또는 아래처럼 직접 TRANSITION_MAP에 접근하는 방식으로 변경:
    // transitionRegistry.registerAll(ALL_AI_TRANSITIONS);
  }

  // 2. NotificationBridge 생성 및 universal listener 등록
  import { NotificationBridge } from './core/ai-product/notification-bridge';
  const notificationBridge = new NotificationBridge(
    telegramNotifier,    // TelegramNotifier 구현체 주입
    autoActionExecutor,  // AutoActionExecutor 구현체 주입
    aiTicketCreator,     // AiTicketCreator 구현체 주입 (DB ai_tickets 테이블 사용)
    digestAccumulator,   // DigestAccumulator 구현체 주입 (DB ai_digest_entries 테이블 사용)
  );
  projectorDispatcher.addUniversalListener(
    (event) => notificationBridge.handle(event)
  );

  // 3. AI 제품 라우터 등록
  import { createAiProductRouter } from './api/routes/ai-product.routes';
  const aiProductRouter = createAiProductRouter(pool, transitionObjectService);
  app.use('/ai-product', aiProductRouter);

  // 4. 마이그레이션에 006 추가
  // src/db/migrate.ts 의 MIGRATION_FILES 배열에 '006_ai_product_schema.sql' 추가
*/
