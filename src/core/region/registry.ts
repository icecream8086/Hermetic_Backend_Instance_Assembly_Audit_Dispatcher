import type { RegionId, AlibabaRegion } from './types.ts';
import { ALIBABA_REGIONS } from './types.ts';

// ─── Region-level configuration ───

export interface RegionEndpoint {
  readonly container?: string | undefined;
  readonly metrics?: string | undefined;
  readonly s3?: string | undefined;
}

export interface RegionConfig {
  readonly vswitchId?: string | undefined;
  readonly securityGroupId?: string | undefined;
  readonly zoneId?: string | undefined;
  readonly endpoints?: RegionEndpoint | undefined;
}

// ─── Default endpoint builders ───

function defaultAlibabaEndpoint(region: string, service: string): string {
  return `${service}.${region}.aliyuncs.com`;
}

function buildAlibabaDefaults(): Map<AlibabaRegion, RegionConfig> {
  const map = new Map<AlibabaRegion, RegionConfig>();
  for (const r of ALIBABA_REGIONS) {
    map.set(r, {
      endpoints: {
        container: defaultAlibabaEndpoint(r, 'eci'),
        metrics: defaultAlibabaEndpoint(r, 'eci'),
        s3: `oss-${r}.aliyuncs.com`,
      },
    });
  }
  return map;
}

/** Known provider names accepted by getEndpoint. */
export type ProviderName = 'alibaba' | 'aws' | 'podman' | 'stub';

// ─── RegionRegistry ───

export class RegionRegistry {
  static readonly ALIBABA = buildAlibabaDefaults();

  /** Local dev region config. */
  static readonly LOCAL: RegionConfig = {
    endpoints: { container: 'http://127.0.0.1:8080', s3: 'http://127.0.0.1:9000' },
  };

  /** Runtime overrides applied on top of static defaults. */
  readonly #overrides = new Map<string, RegionConfig>();

  constructor(seed?: ReadonlyArray<{ region: string; config: RegionConfig }>) {
    if (seed) {
      for (const { region, config } of seed) {
        this.#overrides.set(region, config);
      }
    }
  }

  /** Get the full region config (defaults + overrides merged). */
  getConfig(region: RegionId, provider?: ProviderName): RegionConfig {
    const ov = this.#overrides.get(region);
    if (ov) return ov;

    // Route to the correct static default table based on provider hint
    if (provider === 'alibaba' || ALIBABA_REGIONS.includes(region as AlibabaRegion)) {
      return RegionRegistry.ALIBABA.get(region as AlibabaRegion) ?? {};
    }
    if (region === 'local') return RegionRegistry.LOCAL;

    return {};
  }

  /**
   * Resolve an API endpoint for a given provider service + region.
   *
   * RegionId is a zero-cost brand string — it does not encode which cloud
   * provider the region belongs to.  The caller supplies `provider` so
   * this method can route to the correct default table (Alibaba vs AWS).
   * Runtime overrides are checked first, then built-in defaults.
   */
  getEndpoint(provider: ProviderName, region: RegionId, service: string): string {
    const cfg = this.getConfig(region, provider);

    // Check region-level override first
    if (cfg.endpoints) {
      const ep = cfg.endpoints[service as keyof RegionEndpoint];
      if (ep) return ep;
    }

    // Fallback to dynamic endpoint by provider
    if (provider === 'alibaba' && ALIBABA_REGIONS.includes(region as AlibabaRegion)) {
      return defaultAlibabaEndpoint(region, service);
    }

    return '';
  }

  /** Apply a runtime override for a specific region. */
  setOverride(region: string, config: RegionConfig): void {
    this.#overrides.set(region, config);
  }

  /** Remove a runtime override (reverts to static default). */
  removeOverride(region: string): void {
    this.#overrides.delete(region);
  }

  /** List all known region IDs (static + overrides). */
  listRegions(): string[] {
    const set = new Set<string>([...ALIBABA_REGIONS, 'local', ...this.#overrides.keys()]);
    return [...set];
  }
}

// ─── Singleton for app-wide use ───

let _defaultRegistry: RegionRegistry | undefined;

export function getDefaultRegistry(): RegionRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new RegionRegistry();
  }
  return _defaultRegistry;
}

export function setDefaultRegistry(r: RegionRegistry): void {
  _defaultRegistry = r;
}
