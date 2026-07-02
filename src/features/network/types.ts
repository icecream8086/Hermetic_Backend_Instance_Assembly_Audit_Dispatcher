import { z } from 'zod';
import type { InstanceId } from '../../core/region/instance.ts';
import type { NetworkRule } from '../../core/provider/interfaces.ts';

const securityGroupIdSchema = z.string().min(1).brand('SecurityGroupId');
export type SecurityGroupId = z.infer<typeof securityGroupIdSchema>;

export function generateSecurityGroupId(): SecurityGroupId { return securityGroupIdSchema.parse(`sg_${crypto.randomUUID()}`); }

/** Parse a raw string into a SecurityGroupId (validates non-empty). */
export function createSecurityGroupId(raw: string): SecurityGroupId { return securityGroupIdSchema.parse(raw); }

/** 安全组状态 */
export type SecurityGroupStatus = 'Active' | 'Inactive' | 'Error';

/** 带宽控制策略 — 参考阿里云 EIP 带宽与 QoS */
export interface BandwidthControl {
  /** 出方向带宽上限 (Mbps) */
  readonly egress?: number | undefined;
  /** 入方向带宽上限 (Mbps) */
  readonly ingress?: number | undefined;
  /** QoS 突发带宽 (Mbps)，超过后降速到 bandwidth */
  readonly burst?: number | undefined;
  /** QoS 优先级，数值越小优先级越高 */
  readonly priority?: number | undefined;
}

/** 安全组实体 — 平台无关的防火墙规则边界。
 *  通过绑定 ComputeInstance 自动继承 provider/region。 */
export interface SecurityGroup {
  readonly id: SecurityGroupId;
  readonly name: string;
  readonly description?: string | undefined;

  // ── 安全组配置 ──
  /** 安全组 ID（provider 侧） */
  readonly securityGroupId?: string | undefined;
  /** 网络策略规则 — 平台无关的入站/出站规则 */
  readonly rules?: readonly NetworkRule[] | undefined;

  // ── 带宽控制 ──
  readonly bandwidth?: BandwidthControl | undefined;

  // ── 绑定 ──
  readonly instanceId: InstanceId;
  readonly provider: string;
  readonly region: string;

  // ── Provider 侧资源 ID ──
  readonly providerNetworkId?: string | undefined;

  // ── 访问控制 ──
  readonly visibility: 'public' | 'private';
  readonly creatorId?: string | undefined;
  readonly userIds?: readonly string[] | undefined;
  readonly userGroupIds?: readonly string[] | undefined;

  // ── 状态 ──
  readonly status: SecurityGroupStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSecurityGroupInput {
  name: string;
  description?: string | undefined;
  securityGroupId?: string | undefined;
  rules?: readonly NetworkRule[] | undefined;
  bandwidth?: BandwidthControl | undefined;
  instanceId: InstanceId;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | undefined;
  userGroupIds?: string[] | undefined;
}

export interface UpdateSecurityGroupInput {
  name?: string | undefined;
  description?: string | null | undefined;
  securityGroupId?: string | null | undefined;
  rules?: readonly NetworkRule[] | null | undefined;
  bandwidth?: BandwidthControl | null | undefined;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | null | undefined;
  userGroupIds?: string[] | null | undefined;
  status?: SecurityGroupStatus | undefined;
}
