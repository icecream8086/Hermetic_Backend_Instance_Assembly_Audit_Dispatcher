import { z } from 'zod';
import type { InstanceId } from '../../core/region/instance.ts';

declare const SUBNET_ID_BRAND: unique symbol;
export type SubnetId = string & { readonly [SUBNET_ID_BRAND]: true };

export function generateSubnetId(): SubnetId {
  return z.custom<SubnetId>().parse(`sub_${crypto.randomUUID()}`);
}

export type SubnetStatus = 'Active' | 'Inactive' | 'Full' | 'Error';

/** 子网实体 — 平台无关的 IP 段管理。
 *  通过绑定 ComputeInstance 自动继承 provider/region。 */
export interface Subnet {
  readonly id: SubnetId;
  readonly name: string;
  readonly description?: string | undefined;

  // ── 子网配置 ──
  /** CIDR 超网，如 "10.2.0.0/16" */
  readonly cidr: string;
  /** 子网前缀长度，如 24 表示 /24 子网 */
  readonly subnetPrefix: number;

  // ── 绑定 ──
  readonly instanceId: InstanceId;
  readonly provider: string;
  readonly region: string;

  // ── Provider 侧资源 ID ──
  readonly providerSubnetId?: string | undefined;

  // ── 访问控制 ──
  readonly visibility: 'public' | 'private';
  readonly creatorId?: string | undefined;
  readonly userIds?: readonly string[] | undefined;
  readonly userGroupIds?: readonly string[] | undefined;

  // ── 状态 ──
  readonly status: SubnetStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSubnetInput {
  name: string;
  description?: string | undefined;
  cidr: string;
  subnetPrefix: number;
  instanceId: InstanceId;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | undefined;
  userGroupIds?: string[] | undefined;
}

export interface UpdateSubnetInput {
  name?: string | undefined;
  description?: string | null | undefined;
  cidr?: string | undefined;
  subnetPrefix?: number | undefined;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | null | undefined;
  userGroupIds?: string[] | null | undefined;
  status?: SubnetStatus | undefined;
}
