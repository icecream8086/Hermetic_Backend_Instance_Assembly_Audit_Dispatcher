import type { RegionId, ZoneId, ClusterId } from './types.ts';
import { ALIBABA_REGIONS } from './types.ts';

// ─── Region-level configuration ───

export interface RegionEndpoint {
  readonly container?: string | undefined;
  readonly metrics?: string | undefined;
  readonly s3?: string | undefined;
}

export interface RegionConfig {
  readonly subnetId?: string | undefined;
  readonly securityGroupId?: string | undefined;
  readonly zoneId?: ZoneId | undefined;
  readonly endpoints?: RegionEndpoint | undefined;
}

// ─── Default endpoint builders ───

function defaultAlibabaEndpoint(region: string, service: string): string {
  return `${service}.${region}.aliyuncs.com`;
}

function buildAlibabaDefaults(): Map<string, RegionConfig> {
  const map = new Map<string, RegionConfig>();
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
  public static readonly ALIBABA = buildAlibabaDefaults();

  /** Local dev region config. */
  public static readonly LOCAL: RegionConfig = {
    endpoints: { container: 'http://127.0.0.1:8080', s3: 'http://127.0.0.1:9000' },
  };

  /** Runtime overrides applied on top of static defaults. */
  readonly #overrides = new Map<string, RegionConfig>();

  /** Cluster-specific overrides applied on top of regional config. */
  readonly #clusterOverrides = new Map<string, RegionConfig>();

  public constructor(seed?: readonly { region: string; config: RegionConfig }[]) {
    if (seed) {
      for (const { region, config } of seed) {
        this.#overrides.set(region, config);
      }
    }
  }

  /** Get the full region config (defaults + overrides merged).
   *  If clusterId is provided, cluster-level overrides are also applied. */
  public getConfig(region: RegionId, provider?: ProviderName, clusterId?: ClusterId): RegionConfig {
    // Cluster-specific override takes highest priority
    if (clusterId) {
      const co = this.#clusterOverrides.get(clusterId);
      if (co) return co;
    }

    const ov = this.#overrides.get(region);
    if (ov) return ov;

    // Route to the correct static default table based on provider hint
    if (provider === 'alibaba' || ALIBABA_REGIONS.includes(region)) {
      return RegionRegistry.ALIBABA.get(region) ?? {};
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
  public getEndpoint(provider: ProviderName, region: RegionId, service: string, clusterId?: ClusterId): string {
    const cfg = this.getConfig(region, provider, clusterId);

    // Check region-level override first
    if (cfg.endpoints) {
      const ep = cfg.endpoints[service as keyof RegionEndpoint];
      if (ep) return ep;
    }

    // Fallback to dynamic endpoint by provider
    if (provider === 'alibaba' && ALIBABA_REGIONS.includes(region)) {
      return defaultAlibabaEndpoint(region, service);
    }

    return '';
  }

  /** Apply a runtime override for a specific cluster. */
  public setClusterOverride(clusterId: ClusterId, config: RegionConfig): void {
    this.#clusterOverrides.set(clusterId, config);
  }

  /** Remove a cluster override. */
  public removeClusterOverride(clusterId: ClusterId): void {
    this.#clusterOverrides.delete(clusterId);
  }

  /** Apply a runtime override for a specific region. */
  public setOverride(region: string, config: RegionConfig): void {
    this.#overrides.set(region, config);
  }

  /** Remove a runtime override (reverts to static default). */
  public removeOverride(region: string): void {
    this.#overrides.delete(region);
  }

  /** List all known region IDs (static + overrides). */
  public listRegions(): string[] {
    const set = new Set<string>([...ALIBABA_REGIONS, 'local', ...this.#overrides.keys()]);
    return [...set];
  }
}

// ─── Singleton for app-wide use ───

let _defaultRegistry: RegionRegistry | undefined;

export function getDefaultRegistry(): RegionRegistry {
  _defaultRegistry ??= new RegionRegistry();
  return _defaultRegistry;
}

export function setDefaultRegistry(r: RegionRegistry): void {
  _defaultRegistry = r;
}
