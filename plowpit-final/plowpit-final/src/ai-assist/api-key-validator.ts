// =============================================================================
// src/ai-assist/api-key-validator.ts
// 출처: NemoClaw (NVIDIA) — nemoclaw/src/onboard/validate.ts
// 원본 라이선스: Apache-2.0
// 적용: AI Assist가 실제 LLM 엔드포인트와 연결할 때 API 키 유효성 검증
//
// 우리 엔진에서의 역할:
//   - AI Assist stub이 실제 LLM 엔드포인트로 전환될 때 사용
//   - 엔드포인트 /models 호출로 키 유효성 + 가용 모델 목록 확인
//   - is_final_decision 원칙과 무관: AI 검증 보조층에만 사용
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  models: string[];
  error: string | null;
}

/**
 * AI 엔드포인트에 API 키 유효성 검증.
 * GET {endpointUrl}/models 호출 후 응답으로 판단.
 * 타임아웃: 10초
 *
 * 우리 엔진 원칙 준수:
 *   - 이 함수의 결과가 최종 확정에 영향을 주지 않음
 *   - AI가 '유효하다'고 해도 사람 권한자가 최종 설정 확정
 */
export async function validateApiKey(
  apiKey: string,
  endpointUrl: string,
): Promise<ValidationResult> {
  const url = `${endpointUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        valid: false,
        models: [],
        error: `HTTP ${String(response.status)}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await response.json()) as { data?: { id: string }[] };
    const models = (json.data ?? []).map((m) => m.id);
    return { valid: true, models, error: null };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? '요청 타임아웃 (10초)'
          : err.message
        : String(err);
    return { valid: false, models: [], error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * API 키 마스킹 (로그 출력용).
 * nvapi-로 시작하는 NVIDIA 키는 별도 포맷 적용.
 */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '****';
  const last4 = apiKey.slice(-4);
  if (apiKey.startsWith('nvapi-')) {
    return `nvapi-****${last4}`;
  }
  return `****${last4}`;
}
