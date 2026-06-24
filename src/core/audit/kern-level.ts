/**
 * Kernel log levels (0-7), matching syslog convention.
 *
 * <0> KERN_EMERG   — 系统不可用
 * <1> KERN_ALERT   — 需要立即操作
 * <2> KERN_CRIT    — 严重条件
 * <3> KERN_ERR     — 错误条件
 * <4> KERN_WARNING — 警告条件
 * <5> KERN_NOTICE  — 正常但重要的通知
 * <6> KERN_INFO    — 信息性消息
 * <7> KERN_DEBUG   — 调试级别消息
 */
export const enum KernLevel {
  EMERG   = 0,
  ALERT   = 1,
  CRIT    = 2,
  ERR     = 3,
  WARNING = 4,
  NOTICE  = 5,
  INFO    = 6,
  DEBUG   = 7,
}

const KERN_NAMES: Record<number, string> = {
  0: 'EMERG', 1: 'ALERT', 2: 'CRIT', 3: 'ERR',
  4: 'WARNING', 5: 'NOTICE', 6: 'INFO', 7: 'DEBUG',
};

export function kernLevelName(level: KernLevel): string {
  return KERN_NAMES[level] ?? `LEVEL_${level}`;
}

// ═══════════════════════════════════════════════════════════
// Facility encoding — syslog-style facility × 8 + severity
// ═══════════════════════════════════════════════════════════

/** Syslog-style facility codes. Values 0-23, with 16-23 reserved for local use. */
export const enum AuditFacility {
  KERN     = 0,  // 内核/系统
  SANDBOX  = 1,  // 沙箱操作
  IMAGE    = 2,  // 镜像管理
  AUTH     = 3,  // 认证
  PERM     = 4,  // 权限检查
  NETWORK  = 5,  // 网络操作
  VOLUME   = 6,  // 存储卷
  HTTP     = 7,  // HTTP 请求
  PROVIDER = 8,  // Provider 调用
  DNS      = 9,  // DNS 操作
  QUEUE    = 10, // 消息队列
  TEMPLATE = 11, // 模板解析
  // 16-23: 留给自定义
  LOCAL0 = 16, LOCAL1 = 17, LOCAL2 = 18, LOCAL3 = 19,
  LOCAL4 = 20, LOCAL5 = 21, LOCAL6 = 22, LOCAL7 = 23,
}

const FACILITY_NAMES: Record<number, string> = {
  0: 'kern', 1: 'sandbox', 2: 'image', 3: 'auth', 4: 'perm',
  5: 'network', 6: 'volume', 7: 'http', 8: 'provider', 9: 'dns',
  10: 'queue', 11: 'template',
  16: 'local0', 17: 'local1', 18: 'local2', 19: 'local3',
  20: 'local4', 21: 'local5', 22: 'local6', 23: 'local7',
};

/** Map facility string name to numeric code. Unknown facilities → LOCAL0 (16). */
const NAME_TO_FACILITY: Record<string, AuditFacility> = {
  kern: AuditFacility.KERN, system: AuditFacility.KERN,
  sandbox: AuditFacility.SANDBOX, 'sandbox-service': AuditFacility.SANDBOX,
  image: AuditFacility.IMAGE, 'image-pull': AuditFacility.IMAGE,
  auth: AuditFacility.AUTH, authz: AuditFacility.AUTH,
  perm: AuditFacility.PERM, 'perm-audit': AuditFacility.PERM,
  network: AuditFacility.NETWORK, secgroup: AuditFacility.NETWORK,
  volume: AuditFacility.VOLUME,
  http: AuditFacility.HTTP,
  provider: AuditFacility.PROVIDER,
  dns: AuditFacility.DNS, 'dns-service': AuditFacility.DNS,
  queue: AuditFacility.QUEUE,
  template: AuditFacility.TEMPLATE,
  'user-service': AuditFacility.AUTH,
  sysgrp: AuditFacility.PERM,
  subnet: AuditFacility.NETWORK,
};

/** Encode facility + severity into a single priority integer (0-191). */
export function encodePriority(facility: AuditFacility, level: KernLevel): number {
  return (facility << 3) | level;
}

/** Decode a priority integer back to facility and severity. */
export function decodePriority(priority: number): { facility: AuditFacility; level: KernLevel } {
  return { facility: (priority >> 3) as AuditFacility, level: (priority & 0x7) as KernLevel };
}

/** Look up numeric facility from a string name. Unknown facilities → LOCAL0. */
export function resolveFacility(name: string): AuditFacility {
  return NAME_TO_FACILITY[name.toLowerCase()] ?? AuditFacility.LOCAL0;
}

/** Get the human-readable name of a numeric facility. */
export function facilityName(facility: AuditFacility): string {
  return FACILITY_NAMES[facility] ?? `local${facility - 16}`;
}
