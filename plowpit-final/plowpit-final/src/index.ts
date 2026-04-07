// =============================================================================
// src/index.ts
// 애플리케이션 조립 및 의존성 주입
// 모든 티켓(1~16)을 순서대로 연결
// =============================================================================

import express from 'express';
import * as path from 'path';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

// ── Core: Event Store (티켓 1~4) ────────────────────────────────────────────
import { SeqAllocatorService } from './core/event-store/seq-allocator.service';
import { ProjectorDispatcher } from './core/projection/projector.dispatcher';
import { AppendEventService } from './core/event-store/append-event.service';

// ── Core: Transition (티켓 5~8) ─────────────────────────────────────────────
import { PermissionService } from './core/transition/permission.service';
import { TransitionRegistry } from './core/transition/transition-registry';
import { TransitionObjectService } from './core/transition/transition-object.service';

// ── Core: Exceptions (티켓 9~11) ────────────────────────────────────────────
import { ExceptionsService } from './core/exceptions/exceptions.service';
import { MergeSplitDedupeService } from './core/exceptions/merge-split-dedupe.service';

// ── Core: Projectors (티켓 12) ──────────────────────────────────────────────
import {
  InquiryProjector,
  QuoteProjector,
  OrderProjector,
  ShipmentProjector,
  ExceptionProjector,
} from './core/projection/projectors/index';

// ── Core: Reconciliation (티켓 13) ──────────────────────────────────────────
import { ReconciliationJob } from './core/projection/reconciliation.job';

// ── Core: Rules (티켓 14) ───────────────────────────────────────────────────
import { RulesService } from './core/rules/rules.service';

// ── API: Ops UI (티켓 15) ───────────────────────────────────────────────────
import { createOpsUiRouter } from './api/routes/ops-ui.routes';

// ── KPI + AI (티켓 16) ──────────────────────────────────────────────────────
import { KPIService } from './kpi/kpi.service';
import { AIAssistService } from './ai-assist/ai-assist.service';

dotenv.config();

async function bootstrap(): Promise<void> {
  // ── DB 연결 ────────────────────────────────────────────────────────────────
  const pool = new Pool({
    host:     process.env.DB_HOST     ?? 'localhost',
    port:     parseInt(process.env.DB_PORT ?? '5432'),
    database: process.env.DB_NAME     ?? 'event_core',
    user:     process.env.DB_USER     ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  // ── 그룹 1: Event Core (티켓 1~4) ─────────────────────────────────────────
  // 티켓 3: seq 발급기
  const seqAllocator = new SeqAllocatorService(pool);

  // 티켓 4: projector dispatcher (skeleton)
  const projectorDispatcher = new ProjectorDispatcher();

  // 티켓 2: appendEvent (단일 진입점)
  const appendEventService = new AppendEventService(
    pool,
    seqAllocator,
    projectorDispatcher
  );

  // ── 그룹 2: 권한/상태 전이 (티켓 5~8) ────────────────────────────────────
  // 티켓 5: 권한 검증
  const permissionService = new PermissionService(pool);

  // 티켓 6: 상태 전이 레지스트리
  const transitionRegistry = new TransitionRegistry();

  // 티켓 7+8: transitionObject + System/AI 가드
  const transitionObjectService = new TransitionObjectService(
    pool,
    appendEventService,
    permissionService,
    transitionRegistry
  );

  // ── 그룹 3: 예외/재처리 (티켓 9~11) ─────────────────────────────────────
  // 티켓 9+10: exceptions core + revision/cancel/reopen
  const exceptionsService = new ExceptionsService(
    pool,
    appendEventService,
    transitionObjectService,
    permissionService
  );

  // 티켓 11: merge/split/dedupe
  const mergeSplitDedupeService = new MergeSplitDedupeService(
    pool,
    appendEventService,
    transitionObjectService
  );

  // ── 그룹 4: Current Projectors (티켓 12) ─────────────────────────────────
  const inquiryProjector   = new InquiryProjector(pool, appendEventService);
  const quoteProjector     = new QuoteProjector(pool, appendEventService);
  const orderProjector     = new OrderProjector(pool, appendEventService);
  const shipmentProjector  = new ShipmentProjector(pool, appendEventService);
  const exceptionProjector = new ExceptionProjector(pool, appendEventService);

  // projector 등록 (dispatcher에)
  projectorDispatcher.register(inquiryProjector);
  projectorDispatcher.register(quoteProjector);
  projectorDispatcher.register(orderProjector);
  projectorDispatcher.register(shipmentProjector);
  projectorDispatcher.register(exceptionProjector);

  console.log(
    '[Projectors] 등록 완료:',
    projectorDispatcher.getRegisteredProjectors().join(', ')
  );

  // ── 그룹 5: Reconciliation (티켓 13) ─────────────────────────────────────
  const reconciliationJob = new ReconciliationJob(
    pool,
    appendEventService,
    inquiryProjector,
    quoteProjector,
    orderProjector,
    shipmentProjector,
    exceptionProjector
  );

  // ── 그룹 6: 룰 엔진 (티켓 14) ────────────────────────────────────────────
  const rulesService = new RulesService(pool, appendEventService);

  // starter rules 적재
  try {
    await rulesService.loadRulesFromFile(
      `${__dirname}/../starter-rules/starter-rules.yaml`
    );
    console.log('[RulesService] starter rules 적재 완료');
  } catch (err) {
    console.warn('[RulesService] starter rules 적재 실패 (계속 진행):', err);
  }

  // ── 그룹 7: KPI + AI Stub (티켓 16) ─────────────────────────────────────
  const kpiService     = new KPIService(pool);
  const aiAssistService = new AIAssistService(appendEventService);

  // ── Express 앱 ───────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // ── 정적 파일 서빙 (index.html) ──────────────────────────────────────────
  // Render 배포 시 index.html을 프론트엔드로 제공
  app.use(express.static(path.join(__dirname, '../')));

  // 헬스체크
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      system: 'event-first-ops-core-v1',
      principle: 'event가 진실이다. current는 projection이다.',
      registered_projectors: projectorDispatcher.getRegisteredProjectors(),
    });
  });

  // ── 운영 화면 API (티켓 15) ──────────────────────────────────────────────
  app.use(
    '/ops',
    createOpsUiRouter(
      pool,
      transitionObjectService,
      exceptionsService,
      mergeSplitDedupeService
    )
  );

  // ── KPI API (티켓 16) ─────────────────────────────────────────────────────
  app.get('/kpi', async (req, res) => {
    try {
      const {
        from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        to   = new Date().toISOString(),
      } = req.query;

      const summary = await kpiService.computeAll({
        from: new Date(from as string),
        to:   new Date(to as string),
      });

      res.json(summary);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── Reconciliation API (티켓 13) ─────────────────────────────────────────
  app.post('/admin/reconcile/:objectType', async (req, res) => {
    try {
      const { objectType } = req.params;
      const { object_id } = req.body;

      if (object_id) {
        await reconciliationJob.replayObject(objectType as never, object_id);
        res.json({ success: true, replayed: 1 });
      } else {
        const result = await reconciliationJob.detectAndReconcile(
          objectType as never
        );
        res.json(result);
      }
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get('/admin/inconsistencies/:objectType', async (req, res) => {
    try {
      const { objectType } = req.params;
      const reports = await reconciliationJob.detectInconsistencies(
        objectType as never
      );
      res.json({ object_type: objectType, count: reports.length, reports });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── AI Assist API (티켓 16) ───────────────────────────────────────────────
  app.post('/ai/parse-inquiry', async (req, res) => {
    try {
      const { inquiry_id, raw_text, correlation_id } = req.body;
      const result = await aiAssistService.parseInquiry(
        inquiry_id, raw_text, correlation_id
      );
      res.json({
        ...result.parse_result,
        event_id: result.event_result.event_id,
        // AI 파싱 결과는 검토 필요
        requires_human_review: true,
        warning: 'AI 파싱 결과는 Intake가 검토 후 확정해야 합니다.',
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/ai/suggest-quote-draft', async (req, res) => {
    try {
      const { inquiry_id, parse_result, correlation_id } = req.body;
      const result = await aiAssistService.suggestQuoteDraft(
        inquiry_id, parse_result, correlation_id
      );
      res.json({
        ...result.draft,
        event_id: result.event_result.event_id,
        requires_review: true,
        warning: 'AI 초안은 Sales가 검토/수정 후 quote_draft_created로 확정해야 합니다.',
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.post('/ai/classify-exception', async (req, res) => {
    try {
      const {
        exception_id, description,
        target_object_type, correlation_id
      } = req.body;
      const result = await aiAssistService.classifyException(
        exception_id, description, target_object_type, correlation_id
      );
      res.json({
        ...result.classification,
        event_id: result.event_result.event_id,
        requires_human_review: true,
        warning: 'AI 분류 추천은 ExceptionReviewer가 검토 후 최종 처리해야 합니다.',
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ── AI 제품 도메인 조립 ──────────────────────────────────────────────────
  // 기존 B2B 코어(티켓 1~16) 위에 AI 제품 도메인을 올린다.

  // Step 1: AI 제품 전이를 레지스트리에 일괄 등록
  const { ALL_AI_TRANSITIONS } = await import('./core/ai-product/ai-product-transitions');
  transitionRegistry.registerAll(ALL_AI_TRANSITIONS);

  // Step 2: NotificationBridge 구현체 조립
  // DB 기반 구현체 (인라인 - 별도 서비스 파일로 분리 가능)
  const { NotificationBridge } = await import('./core/ai-product/notification-bridge');

  const telegramToken   = process.env.TELEGRAM_BOT_TOKEN ?? '';
  const opsChatId       = process.env.TELEGRAM_OPS_CHAT_ID ?? '';
  const incidentChatId  = process.env.TELEGRAM_INCIDENT_CHAT_ID ?? opsChatId;

  const telegramNotifier = {
    sendToOps: async (msg: string) => {
      if (!telegramToken || !opsChatId) return;
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: opsChatId, text: msg }),
      });
    },
    sendImmediate: async (msg: string) => {
      if (!telegramToken || !incidentChatId) return;
      await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: incidentChatId, text: msg }),
      });
    },
  };

  const autoActionExecutor = {
    execute: async (action: unknown, event: unknown) => {
      // v1: 로그만 기록. 실제 실행기는 auto-action-worker.ts에서 주입
      console.log('[AutoAction]', action, (event as any)?.object_id);
      return { result: 'success' as const, ticket_needed: false };
    },
  };

  const aiTicketCreator = {
    create: async (event: any, level: string) => {
      const result = await pool.query(
        `INSERT INTO ai_tickets
           (ticket_type, event_name, object_id, object_type, customer_id, event_level, payload_summary, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ticket_id`,
        [
          'SUPPORT_TICKET', event.event_name, event.object_id, event.object_type,
          event.payload_json?.customer_id ?? null, level,
          event.reason_code ?? '', event.correlation_id ?? null,
        ]
      );
      return result.rows[0].ticket_id as string;
    },
  };

  const digestAccumulator = {
    push: async (entry: any) => {
      await pool.query(
        `INSERT INTO ai_digest_entries (event_name, level, customer_id, object_id, occurred_at, summary)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [entry.event_name, entry.level, entry.customer_id, entry.object_id, entry.occurred_at, entry.summary]
      );
    },
  };

  const notificationBridge = new NotificationBridge(
    telegramNotifier, autoActionExecutor, aiTicketCreator, digestAccumulator,
  );

  // Step 3: ProjectorDispatcher에 universal listener 등록
  projectorDispatcher.addUniversalListener(
    (event) => notificationBridge.handle(event)
  );

  // Step 4: AI 제품 라우터 등록
  const { createAiProductRouter } = await import('./api/routes/ai-product.routes');
  const aiProductRouter = createAiProductRouter(pool, transitionObjectService);
  app.use('/ai-product', aiProductRouter);

  // SPA 폴백 — /api/* 외 모든 경로를 index.html로
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '../index.html'));
  });

  console.log('[AI Product] 도메인 조립 완료 — /ai-product/* 라우트 활성화');

  // app을 반환 — Netlify Functions에서 serverless-http로 래핑할 수 있게
  return { app, pool };
}

// ── 로컬 서버 실행 (Netlify Functions 환경에서는 호출되지 않음) ──────────────
async function startServer(): Promise<void> {
  const { app, pool } = await bootstrap();
  const PORT = parseInt(process.env.PORT ?? '3000');

  app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     event-first 운영 코어 v1 가동                          ║
║     포트: ${PORT}                                              ║
╠════════════════════════════════════════════════════════════╣
║  절대 원칙                                                  ║
║  1. event가 진실이다                                        ║
║  2. current는 projection이다                               ║
║  3. 최종 상태는 사람 권한자가 쓴다                         ║
║  4. AI와 System은 보조만 한다                              ║
║  5. direct update는 금지다                                 ║
╚════════════════════════════════════════════════════════════╝
    `);
  });

  const shutdown = async () => {
    console.log('[Shutdown] 연결 종료 중...');
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Netlify Functions가 아닌 직접 실행 시에만 서버 시작
if (require.main === module) {
  startServer().catch((err) => {
    console.error('[Bootstrap] 시작 실패:', err);
    process.exit(1);
  });
}

export { bootstrap };
