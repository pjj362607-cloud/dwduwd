// =============================================================================
// src/core/transition/permission.service.ts
// 티켓 5: Role / Permission Validation
// 원칙:
//   - 누가 어떤 전이를 호출할 수 있는지 차단
//   - user/system/ai 분기 명확히
//   - final decision 권한자 검증 가능
//   - 역할 미확정 상태에서 전이 허용 금지
//   - UI에서 role 우회 금지
// =============================================================================

import { Pool } from 'pg';
import {
  ActorType,
  ObjectType,
  PermissionCheckResult,
  EventCoreError,
  EventCoreErrorCode,
} from '../event-store/events.types';
import {
  FINAL_DECISION_EVENTS,
  SYSTEM_ALLOWED_EVENTS,
  AI_ALLOWED_EVENTS,
} from './permission.constants';

// 외부에서 import 가능하도록 re-export
export { FINAL_DECISION_EVENTS, SYSTEM_ALLOWED_EVENTS, AI_ALLOWED_EVENTS };

export interface ActorContext {
  actor_type: ActorType;
  actor_id: string;
  actor_role: string;
  // 실행 시 DB에서 조회한 실제 역할 목록
  verified_roles?: string[];
}

export class PermissionService {
  constructor(private readonly pool: Pool) {}

  /**
   * 전이 권한 종합 검증.
   * 실패 시 EventCoreError throw.
   *
   * 검증 순서:
   * 1. actor_type 분기 (user/system/ai)
   * 2. 역할 존재 확인
   * 3. 이벤트별 허용 역할 확인
   * 4. final decision 권한 확인
   */
  async checkTransitionPermission(
    actor: ActorContext,
    objectType: ObjectType,
    eventName: string,
    isFinalDecision: boolean,
    allowedRolesForEvent: string[]
  ): Promise<PermissionCheckResult> {

    // ── 1. System/AI 분기 ────────────────────────────────────────────────
    if (actor.actor_type === 'system') {
      return this.checkSystemPermission(eventName, isFinalDecision);
    }

    if (actor.actor_type === 'ai') {
      return this.checkAIPermission(eventName, isFinalDecision);
    }

    // ── 2. User: 역할 존재 확인 ──────────────────────────────────────────
    if (!actor.actor_role || actor.actor_role.trim() === '') {
      throw new EventCoreError(
        '역할 미확정 상태에서 전이 불가',
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { actor_id: actor.actor_id }
      );
    }

    // ── 3. DB에서 사용자 역할 검증 ───────────────────────────────────────
    const verifiedRoles = await this.getVerifiedUserRoles(actor.actor_id);
    if (verifiedRoles.length === 0) {
      throw new EventCoreError(
        `사용자에게 할당된 역할 없음: ${actor.actor_id}`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { actor_id: actor.actor_id }
      );
    }

    // 요청한 actor_role이 실제 역할에 포함되는지 확인
    if (!verifiedRoles.includes(actor.actor_role)) {
      throw new EventCoreError(
        `actor_role(${actor.actor_role})이 사용자의 실제 역할에 없음`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { actor_id: actor.actor_id, claimed_role: actor.actor_role, actual_roles: verifiedRoles }
      );
    }

    // ── 4. 이벤트별 허용 역할 확인 ──────────────────────────────────────
    if (
      allowedRolesForEvent.length > 0 &&
      !allowedRolesForEvent.some((r) => verifiedRoles.includes(r))
    ) {
      throw new EventCoreError(
        `이벤트(${eventName})를 수행할 권한 없음. 필요 역할: ${allowedRolesForEvent.join(', ')}`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        {
          event_name: eventName,
          actor_role: actor.actor_role,
          allowed_roles: allowedRolesForEvent,
        }
      );
    }

    // ── 5. Final decision 권한 확인 ─────────────────────────────────────
    if (isFinalDecision) {
      await this.checkFinalDecisionPermission(actor, objectType, eventName);
    }

    return { allowed: true };
  }

  /**
   * System actor 권한 검증.
   * System은 화이트리스트 이벤트만 가능. final decision 절대 불가.
   */
  private checkSystemPermission(
    eventName: string,
    isFinalDecision: boolean
  ): PermissionCheckResult {
    if (isFinalDecision) {
      throw new EventCoreError(
        `System actor는 최종 확정 이벤트 생성 불가: ${eventName}`,
        EventCoreErrorCode.SYSTEM_FINAL_DECISION_FORBIDDEN,
        { event_name: eventName }
      );
    }

    if (!SYSTEM_ALLOWED_EVENTS.has(eventName)) {
      throw new EventCoreError(
        `System actor에게 허용되지 않은 이벤트: ${eventName}. ` +
        `허용: ${[...SYSTEM_ALLOWED_EVENTS].join(', ')}`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { event_name: eventName }
      );
    }

    return { allowed: true };
  }

  /**
   * AI actor 권한 검증.
   * AI는 화이트리스트 이벤트만 가능. final decision 절대 불가.
   */
  private checkAIPermission(
    eventName: string,
    isFinalDecision: boolean
  ): PermissionCheckResult {
    if (isFinalDecision) {
      throw new EventCoreError(
        `AI actor는 최종 확정 이벤트 생성 불가: ${eventName}`,
        EventCoreErrorCode.AI_FINAL_DECISION_FORBIDDEN,
        { event_name: eventName }
      );
    }

    if (!AI_ALLOWED_EVENTS.has(eventName)) {
      throw new EventCoreError(
        `AI actor에게 허용되지 않은 이벤트: ${eventName}. ` +
        `허용: ${[...AI_ALLOWED_EVENTS].join(', ')}`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        { event_name: eventName }
      );
    }

    return { allowed: true };
  }

  /**
   * Final decision 이벤트에 대한 권한 확인.
   * DB의 permissions 테이블 기반.
   */
  private async checkFinalDecisionPermission(
    actor: ActorContext,
    objectType: ObjectType,
    eventName: string
  ): Promise<void> {
    const result = await this.pool.query<{ can_make_final_decision: boolean }>(
      `SELECT p.can_make_final_decision
       FROM permissions p
       WHERE p.role_name = $1
         AND p.object_type = $2`,
      [actor.actor_role, objectType]
    );

    const canFinal = result.rows[0]?.can_make_final_decision ?? false;
    if (!canFinal) {
      throw new EventCoreError(
        `역할(${actor.actor_role})은 ${objectType}의 최종 확정 이벤트(${eventName})를 생성할 권한 없음`,
        EventCoreErrorCode.UNAUTHORIZED_TRANSITION,
        {
          actor_role: actor.actor_role,
          object_type: objectType,
          event_name: eventName,
        }
      );
    }
  }

  /**
   * 예외 종료 권한 확인.
   * ExceptionReviewer 또는 정책상 위임된 권한자만 가능.
   */
  async checkExceptionClosePermission(
    actorRole: string,
    objectType: ObjectType
  ): Promise<void> {
    const result = await this.pool.query<{ can_close_exception: boolean }>(
      `SELECT can_close_exception
       FROM permissions
       WHERE role_name = $1 AND object_type = $2`,
      [actorRole, objectType]
    );

    const canClose = result.rows[0]?.can_close_exception ?? false;
    if (!canClose) {
      throw new EventCoreError(
        `역할(${actorRole})은 예외 종료 권한 없음`,
        EventCoreErrorCode.EXCEPTION_CLOSE_UNAUTHORIZED,
        { actor_role: actorRole }
      );
    }
  }

  /**
   * DB에서 사용자의 실제 역할 목록 조회.
   * 만료된 역할 제외.
   */
  private async getVerifiedUserRoles(userId: string): Promise<string[]> {
    const result = await this.pool.query<{ role_name: string }>(
      `SELECT role_name
       FROM user_roles
       WHERE user_id = $1
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [userId]
    );
    return result.rows.map((r) => r.role_name);
  }

  /**
   * 사용자가 특정 역할을 가지고 있는지 빠른 확인.
   */
  async hasRole(userId: string, roleName: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM user_roles
         WHERE user_id = $1 AND role_name = $2
           AND (expires_at IS NULL OR expires_at > NOW())
       ) AS exists`,
      [userId, roleName]
    );
    return result.rows[0]?.exists ?? false;
  }
}
