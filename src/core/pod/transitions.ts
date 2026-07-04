/**
 * Pod state machine — pure-action-driven transitions.
 *
 * Design (CEA):
 * - PodAction is the exhaustive action set: every state change goes through
 *   `transitionPod()` which covers all variants in a switch with `never` guard.
 * - `createPod()` is the single construction site for PodEntity.
 * - Platform-controlled conditions (DisruptionTarget) survive provider syncs.
 */

import { generateVersionId } from '../brand.ts';
import type { PodEntity, PodPhase, PodCondition, PodSpec, PodNetwork, PodRuntime } from './types.ts';
import { createPodId } from './types.ts';

// ═══════════════════════════════════════════════════════════════
// Action type — exhaustive discriminated union
// ═══════════════════════════════════════════════════════════════

export type PodAction =
  // ── 生命周期 ──
  | { readonly type: 'Provision'; readonly spec: PodSpec; readonly providerId: string; readonly network: PodNetwork; readonly creatorId?: string | undefined; readonly templateRef?: string | undefined }
  | { readonly type: 'Start' }
  | { readonly type: 'Stop' }
  | { readonly type: 'Restart' }
  | { readonly type: 'Update'; readonly spec: PodSpec }
  | { readonly type: 'Terminate' }
  // ── Provider 同步 ──
  | { readonly type: 'UpdateFromProvider'; readonly status: PodRuntime }
  // ── GC 专用 ──
  | { readonly type: 'ForceDelete' }
  | { readonly type: 'MarkFailed'; readonly reason: string }
  | { readonly type: 'MarkSucceeded' }
  | { readonly type: 'MarkExpired' };

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** Condition types that are platform-controlled (not from provider). */
const CONTROL_CONDITION_TYPES = new Set(['DisruptionTarget']);

function filterControlConditions(conditions: readonly PodCondition[]): PodCondition[] {
  return conditions.filter(c => CONTROL_CONDITION_TYPES.has(c.type));
}

function upsertCondition(conditions: readonly PodCondition[], cond: PodCondition): PodCondition[] {
  const filtered = conditions.filter(c => c.type !== cond.type);
  return [...filtered, cond];
}

function now(): string { return new Date().toISOString(); }
function nowMs(): number { return Date.now(); }

// ═══════════════════════════════════════════════════════════════
// createPod — single construction site for PodEntity
// ═══════════════════════════════════════════════════════════════

export function createPod(
  action: { readonly type: 'Provision' } & Extract<PodAction, { readonly type: 'Provision' }>,
): PodEntity {
  const initialPhase: PodPhase = 'Pending'; // provision 固定 Starting 相位
  return {
    podId: createPodId(crypto.randomUUID()),
    name: action.spec.metadata.name,
    spec: action.spec,
    phase: initialPhase,
    providerId: action.providerId,
    network: action.network,
    containers: [],
    conditions: [
      { type: 'PodScheduled', status: 'False', lastTransitionTime: nowMs() },
      { type: 'Initialized', status: 'False', lastTransitionTime: nowMs() },
    ],
    events: [],
    createdAt: nowMs(),
    updatedAt: nowMs(),
    version: generateVersionId(),
    creatorId: action.creatorId,
    templateRef: action.templateRef,
  };
}

// ═══════════════════════════════════════════════════════════════
// transitionPod — pure state machine
// ═══════════════════════════════════════════════════════════════

export function transitionPod(pod: PodEntity, action: PodAction): PodEntity {
  switch (action.type) {
    case 'Provision':
      return createPod(action);

    case 'Stop': {
      if (pod.phase !== 'Running')
        throw new Error(`Cannot stop pod in phase ${pod.phase}`);
      return {
        ...pod,
        phase: 'Succeeded',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'Start': {
      if (pod.phase !== 'Succeeded' && pod.phase !== 'Failed')
        throw new Error(`Cannot start pod in phase ${pod.phase}`);
      return {
        ...pod,
        phase: 'Running',
        deletionTimestamp: undefined,
        conditions: [
          ...filterControlConditions(pod.conditions),
          { type: 'PodScheduled', status: 'True', lastTransitionTime: nowMs() },
        ],
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'Restart':
      return {
        ...pod,
        phase: 'Running',
        conditions: [
          ...filterControlConditions(pod.conditions),
          { type: 'PodScheduled', status: 'True', lastTransitionTime: nowMs() },
        ],
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'Update':
      return {
        ...pod,
        spec: action.spec,
        phase: 'Running',
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'UpdateInProgress', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'Terminate': {
      if (pod.deletionTimestamp !== undefined)
        return pod; // 幂等——已标记删除
      return {
        ...pod,
        deletionTimestamp: now(),
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'TerminationRequested', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'UpdateFromProvider': {
      const runtime = action.status;
      const newPhase = runtime.phase;

      // 保留平台控制类 Condition（不被 Provider 同步覆盖）
      const controlTypes = new Set(['DisruptionTarget']);
      const preserved = pod.conditions.filter(c => controlTypes.has(c.type));

      // Provider 带来的 Condition
      const providerConditionTypes = new Set(runtime.conditions.map(c => c.type));
      const merged = [
        ...preserved,
        ...runtime.conditions,
        // 保留不在 Provider 返回中的平台 Condition（如被 Provider 删除的调度状态）
        ...pod.conditions.filter(c => !controlTypes.has(c.type) && !providerConditionTypes.has(c.type)),
      ];

      return {
        ...pod,
        phase: newPhase,
        containers: runtime.containers,
        conditions: merged,
        events: runtime.events,
        network: runtime.network,
        updatedAt: nowMs(),
        version: generateVersionId(),
      };
    }

    case 'ForceDelete':
      return {
        ...pod,
        phase: 'Failed',
        deletionTimestamp: now(),
        conditions: upsertCondition(pod.conditions, { type: 'DisruptionTarget', status: 'True', reason: 'ForceDeleted', lastTransitionTime: nowMs() }),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkFailed':
      return {
        ...pod,
        phase: 'Failed',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkSucceeded':
      return {
        ...pod,
        phase: 'Succeeded',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    case 'MarkExpired':
      return {
        ...pod,
        phase: 'Failed',
        conditions: filterControlConditions(pod.conditions),
        updatedAt: nowMs(),
        version: generateVersionId(),
      };

    default:
      void (action satisfies never);
      throw new Error(`Unknown PodAction: ${String((action as { type: string }).type)}`);
  }
}
