import type { Credential, ProviderConfig, S3Config } from '../../config/types.ts';
import type {
  IContainerProvider,
  IDnsProvider,
  IProviderRegistry, ProviderCapabilities,
  ProviderEntry,
} from './interfaces.ts';
import type { IS3Provider } from './s3.ts';
import { createS3Providers } from './s3-factory.ts';
import { StubContainerProvider } from '../../providers/stub/container.ts';
import { AlibabaEciContainerProvider } from '../../providers/alibaba/eci-container.ts';
import { PodmanContainerProvider } from '../../providers/podman/podman-provider.ts';
import { secureContainerProvider } from './security.ts';
import { PodmanNetworkPolicyProvider } from '../../providers/podman/podman-network.ts';
import { StubDnsProvider } from '../../providers/stub/dns.ts';
import { CloudflareDnsProvider } from '../../providers/cloudflare/dns.ts';
import { StubMetricsProvider } from '../../providers/stub/metrics.ts';
import { AlibabaEciMetricsProvider } from '../../providers/alibaba/eci-metrics.ts';
import { StubImageProvider } from '../../providers/stub/image.ts';
import { PodmanImageProvider } from '../../providers/podman/podman-image.ts';
import { AlibabaEciImageProvider } from '../../providers/alibaba/eci-image.ts';
/** Named provider account — maps 1:1 to a cloud credential pair. */
interface AccountEntry {
  readonly name: string;
  readonly container: IContainerProvider;
  readonly image: AlibabaEciImageProvider;
}

export function createProviderRegistry(
  config: ProviderConfig,
  s3Config?: S3Config,
): IProviderRegistry {
  const podmanEp = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';

  // Build per-credential Alibaba accounts
  const accounts: AccountEntry[] = config.accounts
    .filter(a => a.accessKeyId && a.accessKeySecret)
    .map(a => ({
      name: a.name,
      container: secureContainerProvider(new AlibabaEciContainerProvider(a.accessKeyId!, a.accessKeySecret!, a.endpoint)),
      image: new AlibabaEciImageProvider(a.accessKeyId!, a.accessKeySecret!, a.endpoint),
    }));

  // Stub and podman are always available as provider types
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

  // Provider-type-based lookup (stub / podman / alibaba principal alias)
  const typeEntries = new Map<string, ProviderEntry>([
    ['stub', stubEntry],
    ['podman', podmanEntry],
    // If there's at least one alibaba account, 'alibaba' resolves to the default
    ...(accounts.length > 0 ? [['alibaba', {
      name: 'alibaba' as const,
      container: accounts[0]!.container,
      image: accounts[0]!.image,
    }] as const] : []),
  ]);

  // Find the effective default
  const isAlibaba = config.container === 'alibaba' && accounts.length > 0;
  const def = isAlibaba
    ? typeEntries.get('alibaba')!
    : config.container === 'podman' ? podmanEntry
    : stubEntry;

  // Network policy provider for multi-tenant isolation (Podman only for now)
  const networkPolicy = isAlibaba
    ? undefined
    : new PodmanNetworkPolicyProvider(podmanEp);

  const dns = createDnsProvider(config.dns, config.cfApiToken);
  const defaultCreds = config.accounts.find((a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret));
  const metrics = config.metrics === 'alibaba' && defaultCreds
    ? new AlibabaEciMetricsProvider(defaultCreds.accessKeyId, defaultCreds.accessKeySecret)
    : new StubMetricsProvider();

  // S3 providers (multi-account)
  const { entries: s3Entries, defaultName: s3DefaultName } = s3Config
    ? createS3Providers(s3Config)
    : { entries: [], defaultName: '' };

  return {
    container: def.container,
    dns,
    metrics,
    image: def.image,
    networkPolicy,
    capabilities: resolveCapabilities(config, accounts.length > 0),

    provider(name: string): ProviderEntry | undefined {
      return typeEntries.get(name);
    },

    account(name: string): ProviderEntry | undefined {
      const a = accounts.find(a => a.name === name);
      if (!a) return undefined;
      return { name: a.name, container: a.container, image: a.image };
    },

    listAccounts(): string[] {
      return accounts.map(a => a.name);
    },

    availableProviders(): readonly ProviderEntry[] {
      return [...typeEntries.values(), ...accounts.map(a => ({
        name: a.name, container: a.container, image: a.image,
      }))];
    },

    s3Account(name?: string): IS3Provider | undefined {
      const n = name ?? s3DefaultName;
      return s3Entries.find(e => e.name === n)?.provider;
    },

    listS3Accounts(): string[] {
      return s3Entries.map(e => e.name);
    },

  };
}

function createDnsProvider(
  type: ProviderConfig['dns'],
  cfToken?: string,
): IDnsProvider {
  switch (type) {
    case 'cloudflare': {
      if (!cfToken) throw new Error('Cloudflare API token required');
      return new CloudflareDnsProvider(cfToken);
    }
    case 'stub':
      return new StubDnsProvider();
  }
}

function resolveCapabilities(config: ProviderConfig, hasAccounts: boolean): ProviderCapabilities {
  const isProd = config.container === 'alibaba' && hasAccounts;
  return {
    spotInstances: isProd, nfsVolumes: true, publicIpAutoAssign: true,
    preemptible: isProd, maxRuntimeSeconds: isProd ? 86_400 * 7 : 0,
  };
}
