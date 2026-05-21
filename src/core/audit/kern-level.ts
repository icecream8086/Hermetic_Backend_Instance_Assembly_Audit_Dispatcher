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
  0: 'EMERG',
  1: 'ALERT',
  2: 'CRIT',
  3: 'ERR',
  4: 'WARNING',
  5: 'NOTICE',
  6: 'INFO',
  7: 'DEBUG',
};

/** 将 KernLevel 数值转可读名称 (如 5 → "NOTICE") */
export function kernLevelName(level: KernLevel): string {
  return KERN_NAMES[level] ?? `LEVEL_${level}`;
}
