// ─── Provider factory ───
// Selects and instantiates provider implementations by type.
// All credentials are injected from config/env, never hardcoded.

import type { ProviderConfig } from '../../config/types.ts';
import type {
  IContainerProvider,
  IDnsProvider,
  IMetricsProvider,
  IProviderRegistry,
  ProviderCapabilities,
} from './interfaces.ts';
import { StubContainerProvider } from '../../providers/stub/container.ts';
import { AlibabaEciContainerProvider } from '../../providers/alibaba/eci-container.ts';
import { StubDnsProvider } from '../../providers/stub/dns.ts';
import { CloudflareDnsProvider } from '../../providers/cloudflare/dns.ts';
import { StubMetricsProvider } from '../../providers/stub/metrics.ts';
import { AlibabaEciMetricsProvider } from '../../providers/alibaba/eci-metrics.ts';

export interface ProviderCredentials {
  readonly alibaba?: {
    readonly accessKeyId: string;
    readonly accessKeySecret: string;
  };
  readonly cloudflare?: {
    readonly apiToken: string;
  };
}

export function createProviderRegistry(
  config: ProviderConfig,
  credentials?: ProviderCredentials,
): IProviderRegistry {
  const container = createContainerProvider(config.container, credentials);
  const dns = createDnsProvider(config.dns, credentials);
  const metrics = createMetricsProvider(config.metrics, credentials);

  return {
    container,
    dns,
    metrics,
    capabilities: resolveCapabilities(config),
  };
}

function createContainerProvider(
  type: ProviderConfig['container'],
  credentials?: ProviderCredentials,
): IContainerProvider {
  switch (type) {
    case 'alibaba': {
      const ak = credentials?.alibaba;
      if (!ak) throw new Error('Alibaba credentials required for container provider');
      return new AlibabaEciContainerProvider(ak.accessKeyId, ak.accessKeySecret);
    }
    case 'stub':
      return new StubContainerProvider();
  }
}

function createDnsProvider(
  type: ProviderConfig['dns'],
  credentials?: ProviderCredentials,
): IDnsProvider {
  switch (type) {
    case 'cloudflare': {
      const cf = credentials?.cloudflare;
      if (!cf) throw new Error('Cloudflare API token required for DNS provider');
      return new CloudflareDnsProvider(cf.apiToken);
    }
    case 'stub':
      return new StubDnsProvider();
  }
}

function createMetricsProvider(
  type: ProviderConfig['metrics'],
  credentials?: ProviderCredentials,
): IMetricsProvider {
  switch (type) {
    case 'alibaba': {
      const ak = credentials?.alibaba;
      if (!ak) throw new Error('Alibaba credentials required for metrics provider');
      return new AlibabaEciMetricsProvider(ak.accessKeyId, ak.accessKeySecret);
    }
    case 'stub':
      return new StubMetricsProvider();
  }
}

function resolveCapabilities(config: ProviderConfig): ProviderCapabilities {
  const isProd = config.container === 'alibaba';
  return {
    spotInstances: isProd,
    nfsVolumes: true,
    publicIpAutoAssign: true,
    preemptible: isProd,
    maxRuntimeSeconds: isProd ? 86_400 * 7 : 0, // 7 days for prod, unlimited for stub
  };
}
