// =============================================================================
// src/ai-assist/ai-assist.service.ts
// 티켓 16: AI Assist Stub
// 원칙:
//   - AI는 코어 밖에서만 작동
//   - AI 결과는 저장되지만 최종 상태 확정 권한 없음
//   - AI만으로 최종 상태 확정 금지
//   - AI가 rule을 생성/활성화 금지
//   - AI 결과는 검토 가능 (초안/추천/파싱 형태로만)
// =============================================================================

import { AppendEventService } from '../core/event-store/append-event.service';
import {
  AppendEventResult,
  ObjectType,
} from '../core/event-store/events.types';

// AI 행위자 고정값 (System actor와 구분)
const AI_ACTOR_ID = '00000000-0000-0000-0000-000000000001';
const AI_ACTOR_ROLE = 'AIAssist';

// ── AI 파싱 결과 ───────────────────────────────────────────────────────────────
export interface InquiryParseResult {
  customer_name?: string;
  customer_code?: string;
  items: Array<{
    item_code?: string;
    item_name: string;
    quantity: number;
    unit: string;
    requested_delivery?: string;
  }>;
  contact_info?: {
    phone?: string;
    email?: string;
  };
  raw_text: string;
  confidence_score: number;
  missing_fields: string[];
  parsing_notes?: string;
}

// ── 견적 초안 결과 ─────────────────────────────────────────────────────────────
export interface QuoteDraftResult {
  suggested_items: Array<{
    item_id?: string;
    item_code?: string;
    item_name: string;
    quantity: number;
    unit_price: number;
    amount: number;
    notes?: string;
  }>;
  suggested_total: number;
  suggested_due_date?: string;
  confidence_score: number;
  draft_notes?: string;
  requires_review: true;  // 항상 true: AI 초안은 반드시 검토 필요
}

// ── 예외 분류 추천 결과 ────────────────────────────────────────────────────────
export interface ExceptionClassificationResult {
  suggested_exception_type: string;
  suggested_severity: string;
  suggested_assigned_role: string;
  reasoning: string;
  confidence_score: number;
  requires_human_review: true;  // 항상 true
}

export class AIAssistService {
  constructor(
    private readonly appendEventService: AppendEventService
  ) {}

  // ── 1. 문의 파싱 보조 ─────────────────────────────────────────────────────
  /**
   * 문의 텍스트를 파싱하여 구조화된 정보 추출.
   * 결과는 inquiry_parsed_by_ai 이벤트로 기록.
   * 최종 확정 아님. Intake가 검토 후 확정.
   */
  async parseInquiry(
    inquiryId: string,
    rawText: string,
    correlationId?: string
  ): Promise<{ parse_result: InquiryParseResult; event_result: AppendEventResult }> {

    // STUB: 실제 AI 모델 호출 대신 구조 반환
    // 실제 구현 시 LLM API 호출로 대체
    const parseResult = await this.callParsingStub(rawText);

    // AI 결과를 이벤트로 기록 (검토용)
    const eventResult = await this.appendEventService.append({
      object_type: 'inquiry',
      object_id: inquiryId,
      event_name: 'inquiry_parsed_by_ai',
      actor_type: 'ai',         // AI actor (final decision 불가)
      actor_id: AI_ACTOR_ID,
      actor_role: AI_ACTOR_ROLE,
      payload_json: {
        parse_result: parseResult,
        raw_text: rawText,
        // AI 파싱 결과는 참고용 - Intake가 검토 후 확정
        requires_human_review: true,
      },
      payload_schema_version: 'v1',
      correlation_id: correlationId,
      is_final_decision: false,  // AI는 final decision 불가. 항상 false.
      source_channel: 'system',
    });

    return { parse_result: parseResult, event_result: eventResult };
  }

  // ── 2. 견적 초안 생성 보조 ────────────────────────────────────────────────
  /**
   * 파싱된 문의 정보를 바탕으로 견적 초안 생성.
   * 결과는 quote_draft_suggested_by_ai 이벤트로 기록.
   * Sales가 검토/수정 후 quote_draft_created 이벤트 생성해야 함.
   * AI 초안이 곧 견적 확정 아님.
   */
  async suggestQuoteDraft(
    inquiryId: string,
    parseResult: InquiryParseResult,
    correlationId?: string
  ): Promise<{ draft: QuoteDraftResult; event_result: AppendEventResult }> {

    const draft = await this.callQuoteDraftStub(parseResult);

    // AI 초안을 이벤트로 기록 (Sales 검토용)
    const eventResult = await this.appendEventService.append({
      object_type: 'inquiry',
      object_id: inquiryId,
      event_name: 'quote_draft_suggested_by_ai',
      actor_type: 'ai',
      actor_id: AI_ACTOR_ID,
      actor_role: AI_ACTOR_ROLE,
      payload_json: {
        draft,
        // Sales가 이 초안을 검토 후 quote_draft_created로 확정해야 함
        requires_sales_review: true,
        cannot_be_auto_confirmed: true,
      },
      payload_schema_version: 'v1',
      correlation_id: correlationId,
      is_final_decision: false,
      source_channel: 'system',
    });

    return { draft, event_result: eventResult };
  }

  // ── 3. 예외 분류 추천 ─────────────────────────────────────────────────────
  /**
   * 예외 내용을 분석하여 유형/심각도/담당 역할 추천.
   * 결과는 exception_type_suggested_by_ai 이벤트로 기록.
   * ExceptionReviewer가 검토 후 최종 처리.
   * AI는 예외를 종료하거나 병합할 수 없음.
   */
  async classifyException(
    exceptionId: string,
    description: string,
    targetObjectType: ObjectType,
    correlationId?: string
  ): Promise<{ classification: ExceptionClassificationResult; event_result: AppendEventResult }> {

    const classification = await this.callClassificationStub(
      description,
      targetObjectType
    );

    // AI 분류를 이벤트로 기록 (ExceptionReviewer 참고용)
    const eventResult = await this.appendEventService.append({
      object_type: 'exception',
      object_id: exceptionId,
      event_name: 'exception_type_suggested_by_ai',
      actor_type: 'ai',
      actor_id: AI_ACTOR_ID,
      actor_role: AI_ACTOR_ROLE,
      payload_json: {
        suggested_type: classification.suggested_exception_type,
        suggested_priority: classification.suggested_severity,
        suggested_role: classification.suggested_assigned_role,
        reasoning: classification.reasoning,
        confidence_score: classification.confidence_score,
        // ExceptionReviewer가 최종 판단
        requires_exception_reviewer: true,
      },
      payload_schema_version: 'v1',
      correlation_id: correlationId,
      is_final_decision: false,
      source_channel: 'system',
    });

    return { classification, event_result: eventResult };
  }

  // ── STUB 구현부 ──────────────────────────────────────────────────────────
  // 실제 구현 시 LLM API 호출로 대체

  private async callParsingStub(rawText: string): Promise<InquiryParseResult> {
    // TODO: 실제 구현 시 LLM 호출
    return {
      customer_name: undefined,
      items: [],
      raw_text: rawText,
      confidence_score: 0.0,
      missing_fields: ['customer_name', 'items', 'delivery_date'],
      parsing_notes: '[STUB] AI 파싱 미구현. 실제 구현 필요.',
    };
  }

  private async callQuoteDraftStub(
    _parseResult: InquiryParseResult
  ): Promise<QuoteDraftResult> {
    return {
      suggested_items: [],
      suggested_total: 0,
      confidence_score: 0.0,
      draft_notes: '[STUB] AI 견적 초안 미구현. Sales 직접 작성 필요.',
      requires_review: true,
    };
  }

  private async callClassificationStub(
    _description: string,
    targetObjectType: ObjectType
  ): Promise<ExceptionClassificationResult> {
    return {
      suggested_exception_type: 'revision_request',
      suggested_severity: 'medium',
      suggested_assigned_role: 'ExceptionReviewer',
      reasoning: `[STUB] ${targetObjectType} 관련 예외. AI 분류 미구현.`,
      confidence_score: 0.0,
      requires_human_review: true,
    };
  }
}
