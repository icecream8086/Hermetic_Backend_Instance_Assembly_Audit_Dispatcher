import type { SecurityResourceService } from '../../core/security/service.ts';

export function resolveSecurityRefs(storage: {
  securityRef?: string | undefined;
  securityRefs?: readonly string[] | undefined;
}): string[] {
  const refs: string[] = [];
  if (storage.securityRef) refs.push(storage.securityRef);
  if (storage.securityRefs) refs.push(...storage.securityRefs);
  return [...new Set(refs)];
}

export async function validateSecurityPolicies(
  names: string[],
  service: SecurityResourceService,
): Promise<void> {
  for (const name of names) {
    const res = await service.getByName(name);
    if (!res) throw new Error(`SecurityResource "${name}" not found`);
  }
}
