// =============================================================================
// src/ai-assist/ai-endpoint-config.ts
// 출처: NemoClaw (NVIDIA) — nemoclaw/src/onboard/config.ts
// 원본 라이선스: Apache-2.0
// 변경사항:
//   - 클래스명/타입명: NemoClawOnboardConfig → AIEndpointConfig
//   - 저장 경로: ~/.nemoclaw → ~/.ops-core
//   - 파일명: config.json → ai-endpoint.json
//   - OpenClaw 전용 설명 제거, 우리 엔진 맥락으로 교체
//
// 우리 엔진에서의 역할:
//   - AI Assist stub이 실제 LLM과 연결될 때 엔드포인트 설정 관리
//   - NVIDIA cloud, nim-local, vllm, ollama, custom 5가지 엔드포인트 지원
//   - 설정 파일은 AI Assist '초안/파싱/분류' 보조 목적에만 사용
//   - 이 설정이 최종 확정 권한에 영향을 주지 않음 (원칙 유지)
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DIR = join(process.env.HOME ?? '/tmp', '.ops-core');

/**
 * 지원하는 AI 추론 엔드포인트 유형.
 * NemoClaw 원본의 EndpointType과 동일.
 */
export type EndpointType =
  | 'build'      // NVIDIA Cloud API (build.nvidia.com)
  | 'ncp'        // NVIDIA Cloud Partner (동적 엔드포인트)
  | 'nim-local'  // 로컬 NIM 서비스
  | 'vllm'       // 로컬 vLLM 서버
  | 'ollama'     // 로컬 Ollama
  | 'custom';    // 커스텀 OpenAI 호환 엔드포인트

/**
 * AI 엔드포인트 설정.
 * 우리 엔진 AI Assist가 실제 LLM에 연결할 때 사용하는 설정.
 */
export interface AIEndpointConfig {
  endpointType:   EndpointType;
  endpointUrl:    string;
  ncpPartner:     string | null;
  model:          string;
  profile:        string;
  credentialEnv:  string;   // API 키를 담고 있는 환경변수 이름
  provider?:      string;
  providerLabel?: string;
  configuredAt:   string;   // ISO timestamp
}

/**
 * 엔드포인트 타입 → 사람이 읽을 수 있는 설명.
 */
export function describeEndpoint(config: AIEndpointConfig): string {
  if (config.endpointUrl === 'https://inference.local/v1') {
    return 'Managed Inference Route (inference.local)';
  }
  return `${config.endpointType} (${config.endpointUrl})`;
}

/**
 * 엔드포인트 타입 → 공급자 명칭.
 */
export function describeProvider(config: AIEndpointConfig): string {
  if (config.providerLabel) return config.providerLabel;

  switch (config.endpointType) {
    case 'build':     return 'NVIDIA Cloud API';
    case 'ollama':    return 'Local Ollama';
    case 'vllm':      return 'Local vLLM';
    case 'nim-local': return 'Local NIM';
    case 'ncp':       return 'NVIDIA Cloud Partner';
    case 'custom':    return 'Custom OpenAI-compatible';
    default:          return 'Unknown';
  }
}

// ── 파일 시스템 관리 ──────────────────────────────────────────────────────────
let configDirCreated = false;

function ensureConfigDir(): void {
  if (configDirCreated) return;
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  configDirCreated = true;
}

function configPath(): string {
  return join(CONFIG_DIR, 'ai-endpoint.json');
}

/**
 * 저장된 AI 엔드포인트 설정 로드.
 * 파일이 없으면 null 반환 (stub 모드 유지).
 */
export function loadAIEndpointConfig(): AIEndpointConfig | null {
  ensureConfigDir();
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AIEndpointConfig;
  } catch {
    return null;
  }
}

/**
 * AI 엔드포인트 설정 저장.
 * Admin이 설정 확정 후 호출.
 */
export function saveAIEndpointConfig(config: AIEndpointConfig): void {
  ensureConfigDir();
  writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

/**
 * AI 엔드포인트 설정 삭제 (stub 모드로 복귀).
 */
export function clearAIEndpointConfig(): void {
  const path = configPath();
  if (existsSync(path)) unlinkSync(path);
}

/**
 * 현재 설정에서 API 키 조회 (환경변수 기반).
 * credentialEnv에 지정된 환경변수에서 읽음.
 */
export function getApiKey(config: AIEndpointConfig): string | null {
  return process.env[config.credentialEnv] ?? null;
}
