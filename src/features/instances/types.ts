/**
 * Compute instance types — GitHub Runner model.
 *
 * Runner lifecycle: online / offline / deleted
 *   busy flag independent: busy=true ⇒ status=online
 */

import { z } from 'zod';

const runnerIdSchema = z.string().brand('RunnerId');
const runnerGroupIdSchema = z.string().brand('RunnerGroupId');

export type RunnerId = z.infer<typeof runnerIdSchema>;
export type RunnerGroupId = z.infer<typeof runnerGroupIdSchema>;

export function generateRunnerId(): RunnerId {
  return runnerIdSchema.parse(`runner_${crypto.randomUUID()}`);
}

export function generateRunnerGroupId(): RunnerGroupId {
  return runnerGroupIdSchema.parse(`rgrp_${crypto.randomUUID()}`);
}

// ─── Runner status (GitHub Actions model) ───

export type RunnerStatus = 'online' | 'offline';
export type RunnerOs = 'linux' | 'win' | 'mac';

export interface RunnerInstance {
  readonly id: RunnerId;
  readonly name: string;
  readonly os: RunnerOs;
  readonly status: RunnerStatus;
  /** Whether currently executing a job. */
  readonly busy: boolean;
  /** Labels for job routing. */
  readonly labels: string[];
  /** Provider identity — which infrastructure this runner uses. */
  readonly providerInstanceId?: string | undefined;
  /** Group IDs this runner belongs to. */
  readonly groupIds: string[];
  readonly registeredAt: number;
  readonly lastHeartbeatAt: number;
}

// ─── Registration token (1h TTL, GitHub model) ───

export interface RegistrationToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly createdAt: number;
}

// ─── Runner group (GitHub Actions model) ───

export type RunnerGroupVisibility = 'all' | 'selected';

export interface RunnerGroup {
  readonly id: RunnerGroupId;
  readonly name: string;
  readonly visibility: RunnerGroupVisibility;
  readonly selectedScopeIds: string[];
  /** Inherits visibility to child scopes. */
  readonly dependsOn: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ─── DTOs ───

export interface CreateRunnerInput {
  readonly name: string;
  readonly os?: RunnerOs | undefined;
  readonly labels?: string[] | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly groupIds?: string[] | undefined;
}

export interface UpdateRunnerInput {
  readonly name?: string | undefined;
  readonly labels?: string[] | undefined;
  readonly groupIds?: string[] | undefined;
}

export interface CreateRunnerGroupInput {
  readonly name: string;
  readonly visibility?: RunnerGroupVisibility | undefined;
  readonly selectedScopeIds?: string[] | undefined;
  readonly dependsOn?: string[] | undefined;
}
