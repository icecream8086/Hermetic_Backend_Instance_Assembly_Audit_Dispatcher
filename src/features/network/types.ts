import type { RegionId } from '../../core/region/types.ts';

declare const NETWORK_ID_BRAND: unique symbol;
export type NetworkId = string & { readonly [NETWORK_ID_BRAND]: true };

export function generateNetworkId(): NetworkId {
  return `net_${crypto.randomUUID()}` as NetworkId;
}

/** 虚拟网段状态 */
export type NetworkStatus = 'Active' | 'Inactive' | 'Error';

/** 虚拟网段实体 */
export interface VirtualNetwork {
  readonly id: NetworkId;
  readonly name: string;
  readonly description?: string | undefined;

  // ── 网络配置 ──
  /** CIDR 超网，如 "10.2.0.0/16" */
  readonly cidr: string;
  /** 子网前缀长度，如 24 表示 /24 子网 */
  readonly subnetPrefix: number;
  /** 安全组 ID（provider 侧） */
  readonly securityGroupId?: string | undefined;

  // ── Provider 映射 ──
  readonly provider: string;
  readonly region: RegionId;

  // ── Provider 侧资源 ID（创建后回填） ──
  readonly providerNetworkId?: string | undefined;

  // ── 访问控制 ──
  readonly visibility: 'public' | 'private';
  /** 创建者 ID — "仅自己可见" */
  readonly creatorId?: string | undefined;
  /** 白名单用户 */
  readonly userIds?: readonly string[] | undefined;
  /** 白名单用户组 */
  readonly userGroupIds?: readonly string[] | undefined;

  // ── 状态 ──
  readonly status: NetworkStatus;

  // ── 时间戳 ──
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateNetworkInput {
  name: string;
  description?: string | undefined;
  cidr: string;
  subnetPrefix: number;
  securityGroupId?: string | undefined;
  provider: string;
  region: RegionId;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | undefined;
  userGroupIds?: string[] | undefined;
}

export interface UpdateNetworkInput {
  name?: string | undefined;
  description?: string | null | undefined;
  securityGroupId?: string | null | undefined;
  visibility?: 'public' | 'private' | undefined;
  userIds?: string[] | null | undefined;
  userGroupIds?: string[] | null | undefined;
  status?: NetworkStatus | undefined;
}
