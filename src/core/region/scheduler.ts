import type { RegionId, AlibabaRegion } from './types.ts';
import { ALIBABA_REGIONS } from './types.ts';
import { createRegionId } from './types.ts';
import { getDefaultRegistry } from './registry.ts';

export interface ScheduleRequest {
  /** Required capability type. */
  readonly capability: 'container' | 'compute';
  /** Preferred regions in order (optional). */
  readonly preferredRegions?: readonly string[] | undefined;
  /** Minimum CPU cores required. */
  readonly cpu?: number | undefined;
  /** Minimum memory in MB required. */
  readonly memory?: number | undefined;
  /** Provider hint ('alibaba' | 'podman' | 'stub'). */
  readonly provider?: string | undefined;
  /** Tenant ID for network isolation. */
  readonly tenantId?: string | undefined;
}

export interface ScheduleResult {
  readonly region: RegionId;
  readonly provider: string;
  readonly score: number;
  readonly reason: string;
}

const LOCAL_REGION = createRegionId('local');

/**
 * Simple region scheduler. Evaluates available regions against the request
 * and returns the best match based on capabilities, resource availability,
 * and user preference.
 */
export function scheduleRegion(request: ScheduleRequest): ScheduleResult {
  const registry = getDefaultRegistry();
  const allRegions = registry.listRegions();

  const candidates: ScheduleResult[] = [];

  for (const region of allRegions) {
    const provider = resolveProvider(region, request.provider);
    const score = scoreRegion(region, request);
    if (score <= 0) continue;

    candidates.push({
      region: createRegionId(region),
      provider,
      score,
      reason: score >= 100 ? 'preferred' : score >= 50 ? 'available' : 'fallback',
    });
  }

  if (candidates.length === 0) {
    // Fallback to local
    return {
      region: LOCAL_REGION,
      provider: request.provider ?? 'stub',
      score: 0,
      reason: 'no region matched — using local fallback',
    };
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!;
}

function resolveProvider(region: string, preferred?: string): string {
  if (preferred) return preferred;
  if (region === 'local') return 'podman';
  if (ALIBABA_REGIONS.includes(region as AlibabaRegion)) return 'alibaba';
  return 'stub';
}

/**
 * Score a region for a given request. Higher = better match.
 * Returns 0 if the region cannot satisfy the request.
 */
function scoreRegion(region: string, request: ScheduleRequest): number {
  let score = 0;

  // Preferred regions get a big boost
  if (request.preferredRegions?.includes(region)) {
    score += 100;
  }

  // Provider match
  const provider = resolveProvider(region, request.provider);
  if (request.provider && provider !== request.provider) {
    // Hard mismatch — wrong provider
    if (!request.preferredRegions?.includes(region)) return 0;
    score -= 50; // still possible but penalized
  }

  // Local gets a base score
  if (region === 'local') {
    score += 30;
  }

  // Alibaba regions get their own base score
  if (ALIBABA_REGIONS.includes(region as AlibabaRegion)) {
    score += 20;
  }

  return score;
}

/**
 * Resolve a provider-aware endpoint for the scheduled region.
 */
export function getEndpointFor(region: RegionId, provider: string, service: string): string {
  if (provider === 'podman' || region === 'local') {
    return process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';
  }
  const registry = getDefaultRegistry();
  return registry.getEndpoint(provider as any, region, service);
}
