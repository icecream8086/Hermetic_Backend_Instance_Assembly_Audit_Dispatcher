/**
 * 类型安全的更新合并函数。
 *
 * 只合并 input 中与实体共享且值不为 undefined 的字段，
 * 过滤掉 input 独有的字段（避免污染实体）。
 *
 * 为什么输入用 Record：exactOptionalPropertyTypes: true 下 mapped type
 * 的 T[K] | undefined 不等价于 T[K] (optional)。用 Record 把约束
 * 放在调用方，函数内部只做运行时过滤。
 */
export function applyUpdate<T extends object>(
  entity: T,
  input: Record<string, unknown>,
): T {
  const updates: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(entity, key) && input[key] !== undefined) {
      updates[key] = input[key];
    }
  }
  return { ...entity, ...updates };
}
