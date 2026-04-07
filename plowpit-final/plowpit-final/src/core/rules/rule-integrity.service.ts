// =============================================================================
// src/core/rules/rule-integrity.service.ts
// 출처: NemoClaw (NVIDIA) — nemoclaw/src/blueprint/verify.ts
// 원본 라이선스: Apache-2.0
// 추출 범위: computeDirectoryDigest + satisfiesMinVersion 2개 함수만
// 제외: verifyBlueprintDigest (BlueprintManifest 타입 의존), checkCompatibility (openshell 버전)
//
// 우리 엔진에서의 역할:
//   - starter-rules.yaml 파일 무결성 검증 (SHA-256)
//   - 마이그레이션 SQL 파일 체인 무결성 검증
//   - 룰 파일이 외부에서 변조되지 않았는지 확인
//   - 룰 로딩 전 선제 검증으로 금지 액션 우회 방지
// =============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── 무결성 검증 ────────────────────────────────────────────────────────────────

export interface IntegrityCheckResult {
  valid: boolean;
  path: string;
  digest: string;
  expectedDigest?: string;
  errors: string[];
}

/**
 * 단일 파일 SHA-256 다이제스트 계산.
 */
export function computeFileDigest(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`파일 없음: ${filePath}`);
  }
  return createHash('sha256')
    .update(readFileSync(filePath))
    .digest('hex');
}

/**
 * 디렉터리 전체 SHA-256 다이제스트 계산.
 * 출처: NemoClaw blueprint/verify.ts — computeDirectoryDigest()
 *
 * 파일 경로를 알파벳 정렬하여 순서 일관성 보장.
 * 각 파일: 상대경로 + 파일 내용을 순서대로 해시에 포함.
 */
export function computeDirectoryDigest(dirPath: string): string {
  const hash = createHash('sha256');
  const files = collectFiles(dirPath).sort();
  for (const file of files) {
    hash.update(file);                          // 상대 경로 포함
    hash.update(readFileSync(join(dirPath, file)));  // 파일 내용 포함
  }
  return hash.digest('hex');
}

function collectFiles(dirPath: string, prefix = ''): string[] {
  const entries = readdirSync(dirPath);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const relativePath = prefix ? `${prefix}/${entry}` : entry;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

// ── 버전 비교 유틸리티 ──────────────────────────────────────────────────────────

/**
 * 버전 문자열 비교 (semver 호환).
 * 출처: NemoClaw blueprint/verify.ts — satisfiesMinVersion()
 *
 * actual >= minimum이면 true.
 * "1.2.3" vs "1.2.0" → true
 * "1.1.0" vs "1.2.0" → false
 */
export function satisfiesMinVersion(actual: string, minimum: string): boolean {
  const aParts = actual.split('.').map(Number);
  const mParts = minimum.split('.').map(Number);
  for (let i = 0; i < Math.max(aParts.length, mParts.length); i++) {
    const a = aParts[i] ?? 0;
    const m = mParts[i] ?? 0;
    if (a > m) return true;
    if (a < m) return false;
  }
  return true; // equal
}

// ── 룰 파일 무결성 검증 ────────────────────────────────────────────────────────

/**
 * 룰 파일 무결성 검증.
 * - starter-rules.yaml
 * - 마이그레이션 SQL 파일들
 *
 * 용도: 룰 서비스가 파일을 로드하기 전 변조 여부 확인.
 * expectedDigest가 없으면 다이제스트만 계산하고 valid=true 반환.
 */
export function verifyRuleFile(
  filePath: string,
  expectedDigest?: string
): IntegrityCheckResult {
  const errors: string[] = [];

  if (!existsSync(filePath)) {
    return {
      valid: false,
      path: filePath,
      digest: '',
      expectedDigest,
      errors: [`파일 없음: ${filePath}`],
    };
  }

  const digest = computeFileDigest(filePath);

  if (expectedDigest && digest !== expectedDigest) {
    errors.push(
      `무결성 실패: 예상 ${expectedDigest}, 실제 ${digest}. ` +
      `파일이 변조되었거나 잘못된 버전입니다.`
    );
  }

  return {
    valid: errors.length === 0,
    path: filePath,
    digest,
    expectedDigest,
    errors,
  };
}

/**
 * 마이그레이션 파일 체인 무결성 검증.
 * SQL 파일들이 순서대로 모두 존재하는지 확인.
 */
export function verifyMigrationChain(
  migrationsDir: string,
  expectedFiles: string[]
): IntegrityCheckResult[] {
  return expectedFiles.map((file) =>
    verifyRuleFile(join(migrationsDir, file))
  );
}
