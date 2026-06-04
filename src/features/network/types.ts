import type { InstanceId } from '../../core/region/instance.ts';
import type { NetworkRule } from '../../core/provider/interfaces.ts';

declare const SG_ID_BRAND: unique symbol;
export type SecurityGroupId = string & { readonly [SG_ID_BRAND]: true };

export function generateSecurityGroupId(): SecurityGroupId {
  return `sg_${crypto.randomUUID()}` as SecurityGroupId;
}

/** 安全组状态 */
export type SecurityGroupStatus = 'Active' | 'Inactive' | 'Error';

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
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | null | undefined;
  userGroupIds?: string[] | null | undefined;
  status?: SecurityGroupStatus | undefined;
}
