/**
 * Provider factory — creates IProviderRegistry backed by ComputeInstance entities.
 *
 * Instead of creating singleton providers at startup, this factory:
 * 1. Creates an InstanceProviderResolver that dynamically creates providers
 *    from ComputeInstance entities (stored in IAtomicStore).
 * 2. Seeds initial default instances from config/env.
 * 3. Returns a registry that resolves providers lazily per cluster.
 */

import type { ProviderConfig, S3Config, Credential } from '../../config/types.ts';
import type {
  IContainerProvider,
  IContainerGroupProvider,
  IDnsProvider,
  IImageProvider,
  IMetricsProvider,
  INetworkPolicyProvider,
  IProviderRegistry, ProviderCapabilities,
  ProviderEntry,
} from './interfaces.ts';
import type { IS3Provider } from './s3.ts';
import { createS3Providers } from './s3-factory.ts';
import { StubContainerProvider } from '../../providers/stub/container.ts';
import { AlibabaEciContainerProvider } from '../../providers/alibaba/eci-container.ts';
import { PodmanContainerProvider } from '../../providers/podman/podman-provider.ts';
import { secureContainerProvider, secureContainerGroupProvider } from './security.ts';
import { PodmanNetworkPolicyProvider } from '../../providers/podman/podman-network.ts';
import { StubDnsProvider } from '../../providers/stub/dns.ts';
import { CloudflareDnsProvider } from '../../providers/cloudflare/dns.ts';
import { StubMetricsProvider } from '../../providers/stub/metrics.ts';
import { AlibabaEciMetricsProvider } from '../../providers/alibaba/eci-metrics.ts';
import { StubImageProvider } from '../../providers/stub/image.ts';
import { PodmanImageProvider } from '../../providers/podman/podman-image.ts';
import { AlibabaEciImageProvider } from '../../providers/alibaba/eci-image.ts';
import { PodmanContainerGroupProvider } from '../../providers/podman/podman-group-provider.ts';
import { AlibabaEciContainerGroupProvider } from '../../providers/alibaba/eci-group-provider.ts';
import { InstanceService } from '../region/instance.ts';
import { CredentialService } from '../auth/credential.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import { InstanceProviderResolver } from './instance-resolver.ts';
import type { InstanceId } from '../region/instance.ts';
import { debugLog } from '../logger/log-policy.ts';

interface AccountEntry {
  readonly name: string;
  readonly container: IContainerProvider;
  readonly image: AlibabaEciImageProvider;
}

export function createProviderRegistry(
  config: ProviderConfig,
  s3Config?: S3Config,
  atomicStore?: IAtomicStore,
): IProviderRegistry {
  const podmanEp = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';

  // ─── Build per-credential Alibaba accounts ───
  const accounts: AccountEntry[] = config.accounts
    .filter(a => a.accessKeyId && a.accessKeySecret)
    .map(a => ({
      name: a.name,
      container: secureContainerProvider(new AlibabaEciContainerProvider(a.accessKeyId!, a.accessKeySecret!, a.endpoint)),
      image: new AlibabaEciImageProvider(a.accessKeyId!, a.accessKeySecret!, a.endpoint,
        a.defaultRegion ?? config.region as string,
        a.extra?.registryCredentials as Array<{ server: string; userName: string; password: string }> | undefined),
    }));

  // ─── Stub and podman entries (for backward compat lookups) ───
  const stubEntry: ProviderEntry = {
    name: 'stub',
    container: secureContainerProvider(new StubContainerProvider()),
    image: new StubImageProvider(),
  };
  const podmanEntry: ProviderEntry = {
    name: 'podman',
    container: secureContainerProvider(new PodmanContainerProvider(podmanEp)),
    image: new PodmanImageProvider(podmanEp),
  };

  const typeEntries = new Map<string, ProviderEntry>([
    ['stub', stubEntry],
    ['podman', podmanEntry],
    ...(accounts.length > 0 ? [['alibaba', {
      name: 'alibaba' as const,
      container: accounts[0]!.container,
      image: accounts[0]!.image,
    }] as const] : []),
  ]);

  debugLog('system', 'provider selection: config.container="%s", PODMAN_ENDPOINT="%s"', config.container, process.env['PODMAN_ENDPOINT']);
  const isAlibaba = config.container === 'alibaba' && accounts.length > 0;
  const def = isAlibaba
    ? typeEntries.get('alibaba')!
    : config.container === 'podman' ? podmanEntry
    : stubEntry;

  // ─── Legacy providers (sync, for backward compat) ───
  const networkPolicy: INetworkPolicyProvider | undefined = isAlibaba
    ? undefined
    : new PodmanNetworkPolicyProvider(podmanEp);

  const dns: IDnsProvider = config.dns === 'cloudflare' && config.cfApiToken
    ? new CloudflareDnsProvider(config.cfApiToken)
    : new StubDnsProvider();

  const defaultCreds = config.accounts.find((a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret));
  const metrics: IMetricsProvider = config.metrics === 'alibaba' && defaultCreds
    ? new AlibabaEciMetricsProvider(defaultCreds.accessKeyId, defaultCreds.accessKeySecret)
    : new StubMetricsProvider();

  const defaultAccount = config.accounts.find((a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret));
  const groupContainer: IContainerGroupProvider | undefined = isAlibaba && defaultAccount
    ? secureContainerGroupProvider(new AlibabaEciContainerGroupProvider(defaultAccount.accessKeyId, defaultAccount.accessKeySecret, defaultAccount.endpoint))
    : config.container === 'podman'
      ? secureContainerGroupProvider(new PodmanContainerGroupProvider(podmanEp))
      : undefined;

  // ─── S3 providers ───
  const { entries: s3Entries, defaultName: s3DefaultName } = s3Config
    ? createS3Providers(s3Config)
    : { entries: [], defaultName: '' };

  // ─── Instance-based resolver (dynamic, per-cluster) ───
  let instanceService: InstanceService | undefined;
  let instanceResolver: InstanceProviderResolver | undefined;
  if (atomicStore) {
    instanceService = new InstanceService(atomicStore);
    const credService = new CredentialService(atomicStore);
    instanceResolver = new InstanceProviderResolver(instanceService, credService);
  }

  return {
    container: def.container,
    dns,
    metrics,
    image: def.image,
    networkPolicy,
    groupContainer,
    capabilities: resolveCapabilities(config, accounts.length > 0),

    provider(name: string): ProviderEntry | undefined {
      return typeEntries.get(name);
    },

    availableProviders(): readonly ProviderEntry[] {
      return [...typeEntries.values()];
    },

    s3Account(name?: string): IS3Provider | undefined {
      const n = name ?? s3DefaultName;
      return s3Entries.find(e => e.name === n)?.provider;
    },

    listS3Accounts(): string[] {
      return s3Entries.map(e => e.name);
    },

    // ─── Dynamic instance resolution ───
    async resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider> {
      if (instanceResolver) {
        const p = await instanceResolver.resolveContainer(instanceId);
        if (p) return p;
      }
      return def.container;
    },

    async resolveImage(instanceId?: InstanceId): Promise<IImageProvider> {
      if (instanceResolver) {
        const p = await instanceResolver.resolveImage(instanceId);
        if (p) return p;
      }
      return def.image;
    },

    async resolveGroup(instanceId?: InstanceId): Promise<IContainerGroupProvider | undefined> {
      if (instanceResolver) {
        return instanceResolver.resolveGroup(instanceId);
      }
      return groupContainer;
    },
  };
}

function resolveCapabilities(config: ProviderConfig, hasAccounts: boolean): ProviderCapabilities {
  const isProd = config.container === 'alibaba' && hasAccounts;
  return {
    spotInstances: isProd, nfsVolumes: true, publicIpAutoAssign: true,
    preemptible: isProd, maxRuntimeSeconds: isProd ? 86_400 * 7 : 0,
  };
}
