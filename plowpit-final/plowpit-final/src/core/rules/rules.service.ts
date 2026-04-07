// =============================================================================
// src/core/rules/rules.service.ts
// 티켓 14: 최소 룰 엔진
// 원칙:
//   - 룰은 정책층이지 헌법 변경층이 아님
//   - 룰 발동 결과는 반드시 event로 남김
//   - auto approve 금지
//   - auto close exception 금지
//   - final decision 우회 룰 금지
//   - 상태 전이표에 없는 상태 생성 금지
//   - 평가 순서: scope 구체성 → priority → guardrail 우선 → stop_processing
// =============================================================================

import { Pool } from 'pg';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import {
  RuleDefinition,
  RuleType,
  EventRecord,
  EventCoreError,
  EventCoreErrorCode,
  SeverityLevel,
} from '../event-store/events.types';
import { AppendEventService } from '../event-store/append-event.service';

// ── 룰 평가 컨텍스트 ──────────────────────────────────────────────────────────
export interface RuleEvaluationContext {
  event: EventRecord;
  object_snapshot?: Record<string, unknown>;
  actor_roles?: string[];
  scope_id?: string; // account_id 등
}

// ── 룰 발동 결과 ──────────────────────────────────────────────────────────────
export interface RuleEvaluationResult {
  rule_id: string;
  rule_type: RuleType;
  triggered: boolean;
  action_taken?: string;
  created_event_id?: string;
  stop_further_processing: boolean;
  error?: string;
}

// ── 룰이 할 수 없는 것 (하드 금지 액션) ─────────────────────────────────────
const FORBIDDEN_RULE_ACTIONS = new Set<string>([
  'auto_approve',
  'auto_close_exception',
  'auto_complete_shipment',
  'override_final_decision',
  'bypass_permission',
  'create_unknown_state',
]);

export class RulesService {
  private rulesCache: RuleDefinition[] = [];
  private lastCacheRefresh = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1분

  constructor(
    private readonly pool: Pool,
    private readonly appendEventService: AppendEventService
  ) {}

  // ── 룰 적재 ────────────────────────────────────────────────────────────────
  /**
   * YAML/JSON 파일에서 룰 로드.
   * 룰 발동 결과는 event로 남긴다 (이 메서드는 적재만).
   */
  async loadRulesFromFile(filePath: string): Promise<void> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = filePath.split('.').pop()?.toLowerCase();

    let rules: RuleDefinition[];
    if (ext === 'yaml' || ext === 'yml') {
      rules = yaml.load(content) as RuleDefinition[];
    } else {
      rules = JSON.parse(content) as RuleDefinition[];
    }

    await this.validateAndUpsertRules(rules);
  }

  /**
   * DB에서 룰 적재 (캐시 포함).
   */
  async loadRulesFromDB(forceRefresh = false): Promise<RuleDefinition[]> {
    const now = Date.now();
    if (!forceRefresh && now - this.lastCacheRefresh < this.CACHE_TTL_MS) {
      return this.rulesCache;
    }

    const result = await this.pool.query<RuleDefinition>(
      `SELECT * FROM rules
       WHERE is_active = TRUE
         AND effective_from <= NOW()
         AND (effective_to IS NULL OR effective_to > NOW())
       ORDER BY
         CASE scope_type
           WHEN 'user'       THEN 1
           WHEN 'account'    THEN 2
           WHEN 'department' THEN 3
           WHEN 'global'     THEN 4
         END ASC,
         priority ASC`,
    );

    this.rulesCache = result.rows;
    this.lastCacheRefresh = now;
    return this.rulesCache;
  }

  // ── 룰 평가 ────────────────────────────────────────────────────────────────
  /**
   * 이벤트 발생 시 trigger_event 매칭 룰 평가.
   * 평가 순서: scope 구체성 → guardrail 우선 → priority → stop_processing
   * 모든 발동 결과는 event로 남긴다.
   */
  async evaluateRulesForEvent(
    context: RuleEvaluationContext
  ): Promise<RuleEvaluationResult[]> {
    const rules = await this.loadRulesFromDB();
    const results: RuleEvaluationResult[] = [];

    // trigger_event 매칭 룰 필터
    const matchingRules = rules.filter(
      (r) =>
        r.trigger_event === context.event.event_name &&
        r.object_type === context.event.object_type
    );

    // 평가 순서 정렬:
    // 1. guardrail 먼저 (가장 중요)
    // 2. scope 구체성 (user > account > department > global)
    // 3. priority 오름차순
    const sorted = matchingRules.sort((a, b) => {
      const guardrailScore = (r: RuleDefinition) => r.rule_type === 'guardrail' ? 0 : 1;
      const scopeScore = (r: RuleDefinition) => {
        const scores = { user: 0, account: 1, department: 2, global: 3 };
        return scores[r.scope_type as keyof typeof scores] ?? 4;
      };

      const guardrailDiff = guardrailScore(a) - guardrailScore(b);
      if (guardrailDiff !== 0) return guardrailDiff;

      const scopeDiff = scopeScore(a) - scopeScore(b);
      if (scopeDiff !== 0) return scopeDiff;

      return a.priority - b.priority;
    });

    for (const rule of sorted) {
      // scope_id 매칭 (지정된 경우)
      if (rule.scope_id && context.scope_id && rule.scope_id !== context.scope_id) {
        continue;
      }

      const evalResult = await this.evaluateSingleRule(rule, context);
      results.push(evalResult);

      // stop_processing가 true이고 룰이 발동됐으면 이후 룰 평가 중단
      if (evalResult.triggered && rule.stop_processing) {
        break;
      }
    }

    return results;
  }

  /**
   * 단일 룰 평가 + 발동 시 이벤트 생성.
   */
  private async evaluateSingleRule(
    rule: RuleDefinition,
    context: RuleEvaluationContext
  ): Promise<RuleEvaluationResult> {
    try {
      // 조건 평가
      const conditionMet = this.evaluateConditions(
        rule.conditions,
        context
      );

      if (!conditionMet) {
        return {
          rule_id: rule.rule_id,
          rule_type: rule.rule_type as RuleType,
          triggered: false,
          stop_further_processing: false,
        };
      }

      // 액션 유효성 검증 (금지 액션 차단)
      const action = rule.action as Record<string, unknown>;
      const actionType = action.type as string;

      if (FORBIDDEN_RULE_ACTIONS.has(actionType)) {
        throw new EventCoreError(
          `룰 금지 액션: ${actionType}. ` +
          `룰은 final decision 우회, auto approve, auto close exception 불가.`,
          EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
          { rule_id: rule.rule_id, action_type: actionType }
        );
      }

      // 룰 발동 결과를 event로 기록 (필수)
      let createdEventId: string | undefined;
      if (rule.creates_event_name) {
        const result = await this.appendEventService.append({
          object_type: context.event.object_type,
          object_id: context.event.object_id,
          event_name: rule.creates_event_name,
          actor_type: 'system',
          actor_id: '00000000-0000-0000-0000-000000000000', // System actor ID
          actor_role: 'System',
          reason_code: rule.reason_code ?? `rule_triggered:${rule.rule_id}`,
          payload_json: {
            rule_id: rule.rule_id,
            rule_version: rule.rule_version,
            triggered_by_event: context.event.event_id,
            action_type: actionType,
            action_params: action.params ?? {},
          },
          payload_schema_version: 'v1',
          severity: rule.severity as SeverityLevel | undefined,
          caused_by_event_id: context.event.event_id,
          correlation_id: context.event.correlation_id,
          is_final_decision: false, // 룰은 final decision 불가
          source_channel: 'system',
        });
        createdEventId = result.event_id;
      }

      return {
        rule_id: rule.rule_id,
        rule_type: rule.rule_type as RuleType,
        triggered: true,
        action_taken: actionType,
        created_event_id: createdEventId,
        stop_further_processing: rule.stop_processing,
      };
    } catch (error) {
      return {
        rule_id: rule.rule_id,
        rule_type: rule.rule_type as RuleType,
        triggered: false,
        stop_further_processing: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 조건 평가 엔진 (간단한 JSONPath 스타일).
   */
  private evaluateConditions(
    conditions: Record<string, unknown>,
    context: RuleEvaluationContext
  ): boolean {
    const { event, object_snapshot } = context;

    // conditions가 비어 있으면 항상 발동
    if (!conditions || Object.keys(conditions).length === 0) return true;

    for (const [key, expected] of Object.entries(conditions)) {
      const actual = this.resolveConditionValue(key, event, object_snapshot);

      if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
        // 연산자 기반 조건: { "$gte": 10 }, { "$in": ["a","b"] } 등
        if (!this.evaluateOperator(actual, expected as Record<string, unknown>)) {
          return false;
        }
      } else if (Array.isArray(expected)) {
        if (!expected.includes(actual)) return false;
      } else {
        if (actual !== expected) return false;
      }
    }

    return true;
  }

  private resolveConditionValue(
    key: string,
    event: EventRecord,
    snapshot?: Record<string, unknown>
  ): unknown {
    // event.* 참조
    if (key.startsWith('event.')) {
      const field = key.slice(6) as keyof EventRecord;
      return event[field];
    }
    // payload.* 참조
    if (key.startsWith('payload.')) {
      const field = key.slice(8);
      return (event.payload_json as Record<string, unknown>)[field];
    }
    // object.* 참조
    if (key.startsWith('object.') && snapshot) {
      const field = key.slice(7);
      return snapshot[field];
    }
    return undefined;
  }

  private evaluateOperator(
    actual: unknown,
    operator: Record<string, unknown>
  ): boolean {
    if ('$eq' in operator)  return actual === operator.$eq;
    if ('$ne' in operator)  return actual !== operator.$ne;
    if ('$gt' in operator)  return typeof actual === 'number' && actual > (operator.$gt as number);
    if ('$gte' in operator) return typeof actual === 'number' && actual >= (operator.$gte as number);
    if ('$lt' in operator)  return typeof actual === 'number' && actual < (operator.$lt as number);
    if ('$lte' in operator) return typeof actual === 'number' && actual <= (operator.$lte as number);
    if ('$in' in operator)  return Array.isArray(operator.$in) && operator.$in.includes(actual);
    if ('$nin' in operator) return Array.isArray(operator.$nin) && !operator.$nin.includes(actual);
    return false;
  }

  /**
   * 룰 검증 및 DB upsert.
   */
  private async validateAndUpsertRules(rules: RuleDefinition[]): Promise<void> {
    for (const rule of rules) {
      // 금지 액션 검증
      const actionType = (rule.action as Record<string, unknown>).type as string;
      if (FORBIDDEN_RULE_ACTIONS.has(actionType)) {
        throw new EventCoreError(
          `룰 적재 거부 - 금지 액션: ${actionType} (rule_id: ${rule.rule_id})`,
          EventCoreErrorCode.UNAUTHORIZED_TRANSITION
        );
      }

      await this.pool.query(
        `
        INSERT INTO rules (
          rule_id, rule_version, is_active,
          scope_type, scope_id, rule_type, object_type,
          trigger_event, conditions, action,
          priority, stop_processing,
          reason_code, severity, creates_event_name,
          effective_from, effective_to,
          created_by, approved_by, notes
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          $9::jsonb, $10::jsonb,
          $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20
        )
        ON CONFLICT (rule_id, rule_version) DO UPDATE SET
          is_active       = $3,
          conditions      = $9::jsonb,
          action          = $10::jsonb,
          priority        = $11,
          stop_processing = $12,
          updated_at      = NOW()
        `,
        [
          rule.rule_id,
          rule.rule_version ?? 1,
          rule.is_active ?? true,
          rule.scope_type ?? 'global',
          rule.scope_id ?? null,
          rule.rule_type,
          rule.object_type,
          rule.trigger_event,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.action),
          rule.priority ?? 100,
          rule.stop_processing ?? false,
          rule.reason_code ?? null,
          rule.severity ?? null,
          rule.creates_event_name ?? null,
          rule.effective_from ?? new Date(),
          rule.effective_to ?? null,
          rule.created_by ?? null,
          rule.approved_by ?? null,
          rule.notes ?? null,
        ]
      );
    }

    // 캐시 무효화
    this.lastCacheRefresh = 0;
  }
}
