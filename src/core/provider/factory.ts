/**
 * Provider factory — creates IProviderRegistry backed by ComputeInstance entities.
 *
 * Instead of creating singleton providers at startup, this factory:
 * 1. Returns a LazyProviderRegistry that instantiates providers on first access.
 * 2. Default provider (matching config.container) is eagerly resolved on first get.
 * 3. All other providers (dns, metrics, networkPolicy, group, S3, instance resolver)
 *    are instantiated lazily, reducing cold-start cost and memory in serverless.
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
import { createS3Providers, type S3ProviderEntry } from './s3-factory.ts';
import { secureContainerProvider, secureContainerGroupProvider } from './security.ts';
import type { IAtomicStore } from '../store/interfaces.ts';
import type { InstanceId } from '../region/instance.ts';
import type { InstanceProviderResolver } from './instance-resolver.ts';
import type { SecretEncryption } from '../auth/secret-encryption.ts';
import { StubContainerProvider } from '../../providers/stub/container.ts';
import { StubImageProvider } from '../../providers/stub/image.ts';
import { StubDnsProvider } from '../../providers/stub/dns.ts';
import { StubMetricsProvider } from '../../providers/stub/metrics.ts';
import { PodmanContainerProvider } from '../../providers/podman/podman-provider.ts';
import { PodmanImageProvider } from '../../providers/podman/podman-image.ts';
import { PodmanNetworkPolicyProvider } from '../../providers/podman/podman-network.ts';
import { PodmanContainerGroupProvider } from '../../providers/podman/podman-group-provider.ts';
import { AlibabaEciContainerProvider } from '../../providers/alibaba/eci-container.ts';
import { AlibabaEciImageProvider } from '../../providers/alibaba/eci-image.ts';
import { AlibabaEciMetricsProvider } from '../../providers/alibaba/eci-metrics.ts';
import { AlibabaEciContainerGroupProvider } from '../../providers/alibaba/eci-group-provider.ts';
import { AlibabaEciApiClient } from '../../providers/alibaba/eci-api.ts';
import { AlibabaCrApiClient } from '../../providers/alibaba/cr-api.ts';
import { AlibabaOssOpenApiClient } from '../../providers/alibaba/oss-openapi.ts';
import { CloudflareDnsProvider } from '../../providers/cloudflare/dns.ts';

// ─── Lazy provider registry ───
// Providers are instantiated on first access rather than at startup,
// reducing cold-start cost and memory in serverless environments.
// Imports are static (worker bundler includes them anyway), but the
// `new XxxProvider()` calls are deferred until first use.

class LazyProviderRegistry implements IProviderRegistry {
  private _defaultImage?: IImageProvider;
  private _networkPolicy: INetworkPolicyProvider | undefined;
  private _dns?: IDnsProvider;
  private _metrics?: IMetricsProvider;
  private _groupContainer: IContainerGroupProvider | undefined;
  private _rawEciApi: any | undefined;
  private _crApi: any | undefined;
  private _ossOpenApi: any | undefined;
  private _typeEntries?: Map<string, ProviderEntry>;
  private _s3Entries?: S3ProviderEntry[];
  private _instanceResolver?: InstanceProviderResolver;
  private _resolverPromise: Promise<void> | null = null;

  public constructor(
    private readonly config: ProviderConfig,
    private readonly s3Config: S3Config | undefined,
    private readonly atomicStore: IAtomicStore | undefined,
    private readonly secretEncryption?: SecretEncryption,
  ) {}

  /** Emit a one-time warning when the global default provider is accessed.
   *  In production, all provider operations should route through resolveContainer(instanceId). */
  #warnedDefault = false;
  #warnDefault(): void {
    if (!this.#warnedDefault) {
      this.#warnedDefault = true;
      console.warn(`[provider] Using global default container="${this.config.container}" as fallback. Per-instance resolution (resolveContainer) is preferred for production.`);
    }
  }

  /** Number of Alibaba accounts with valid credentials. */
  private get _hasAlibabaAccounts(): boolean {
    return this.config.accounts.some(a => !!(a.accessKeyId && a.accessKeySecret));
  }

  /** @deprecated Global default is disabled — use resolveContainer(instanceId) instead. */
  get container(): IContainerProvider {
    throw new Error(
      'Global default provider is disabled. Use resolveContainer(instanceId) to route to a specific instance, ' +
      'or resolveContainer(undefined) to auto-pick the first online container-capable instance.'
    );
  }

  get image(): IImageProvider {
    if (!this._defaultImage) {
      this.#warnDefault();
      this._defaultImage = this._resolveDefaultEntry().image;
    }
    return this._defaultImage;
  }

  get networkPolicy(): INetworkPolicyProvider | undefined {
    if (this._networkPolicy === undefined) {
      const ep = process.env.PODMAN_ENDPOINT ?? 'http://127.0.0.1:8080';
      this._networkPolicy = this._isAlibaba ? undefined : new PodmanNetworkPolicyProvider(ep);
    }
    return this._networkPolicy;
  }

  get dns(): IDnsProvider {
    if (!this._dns) {
      this._dns = this.config.dns === 'cloudflare' && this.config.cfApiToken
        ? new CloudflareDnsProvider(this.config.cfApiToken)
        : new StubDnsProvider();
    }
    return this._dns;
  }

  get metrics(): IMetricsProvider {
    if (!this._metrics) {
      const defaultCreds = this.config.accounts.find(
        (a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret),
      );
      this._metrics = this.config.metrics === 'alibaba' && defaultCreds
        ? new AlibabaEciMetricsProvider(defaultCreds.accessKeyId, defaultCreds.accessKeySecret)
        : new StubMetricsProvider();
    }
    return this._metrics;
  }

  get groupContainer(): IContainerGroupProvider | undefined {
    if (!this._groupContainer) {
      this._groupContainer = this._createGroupProvider();
    }
    return this._groupContainer;
  }

  get rawEciApi(): any | undefined {
    if (!this._rawEciApi) {
      const cred = this._firstAlibabaCred();
      if (cred) this._rawEciApi = new AlibabaEciApiClient(cred.accessKeyId, cred.accessKeySecret);
    }
    return this._rawEciApi;
  }

  get crApi(): any | undefined {
    if (!this._crApi) {
      const cred = this._firstAlibabaCred();
      if (cred) this._crApi = new AlibabaCrApiClient(cred.accessKeyId, cred.accessKeySecret);
    }
    return this._crApi;
  }

  get ossOpenApi(): any | undefined {
    if (!this._ossOpenApi) {
      const cred = this._firstAlibabaCred();
      if (cred) this._ossOpenApi = new AlibabaOssOpenApiClient(cred.accessKeyId, cred.accessKeySecret);
    }
    return this._ossOpenApi;
  }

  get capabilities(): ProviderCapabilities {
    const isProd = this.config.container === 'alibaba' && this._hasAlibabaAccounts;
    return {
      spotInstances: isProd, nfsVolumes: true, publicIpAutoAssign: true,
      preemptible: isProd, maxRuntimeSeconds: isProd ? 86_400 * 7 : 0,
    };
  }

  // ─── Type-based provider lookup (lazy) ───

  private _getTypeEntries(): Map<string, ProviderEntry> {
    if (!this._typeEntries) {
      this._typeEntries = this._buildTypeEntries();
    }
    return this._typeEntries;
  }

  provider(name: string): ProviderEntry | undefined {
    return this._getTypeEntries().get(name);
  }

  availableProviders(): readonly ProviderEntry[] {
    return [...this._getTypeEntries().values()];
  }

  // ─── S3 (lazy) ───

  private _getS3Entries(): S3ProviderEntry[] {
    if (!this._s3Entries && this.s3Config) {
      this._s3Entries = createS3Providers(this.s3Config).entries;
    }
    return this._s3Entries ?? [];
  }

  s3Account(name?: string): IS3Provider | undefined {
    const entries = this._getS3Entries();
    const n = name ?? this.s3Config?.defaultAccount ?? '';
    return entries.find(e => e.name === n)?.provider;
  }

  listS3Accounts(): string[] {
    return this._getS3Entries().map(e => e.name);
  }

  // ─── Instance-based resolution (lazy) ───

  private async _ensureResolver(): Promise<void> {
    if (this._instanceResolver || !this.atomicStore) return;
    if (!this._resolverPromise) {
      this._resolverPromise = this._initResolver();
    }
    await this._resolverPromise;
  }

  private async _initResolver(): Promise<void> {
    if (!this.atomicStore) return;
    const { InstanceService } = await import('../region/instance.ts');
    const { CredentialService } = await import('../auth/credential.ts');
    const { InstanceProviderResolver } = await import('./instance-resolver.ts');
    const instanceService = new InstanceService(this.atomicStore);
    const credService = new CredentialService(this.atomicStore, this.secretEncryption);
    this._instanceResolver = new InstanceProviderResolver(instanceService, credService);
  }

  public async resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider> {
    await this._ensureResolver();
    if (this._instanceResolver) {
      return this._instanceResolver.resolveContainer(instanceId);
    }
    throw new Error('InstanceProviderResolver not available — atomicStore is required for provider resolution');
  }

  public async resolveImage(instanceId?: InstanceId): Promise<IImageProvider> {
    await this._ensureResolver();
    if (this._instanceResolver) {
      return this._instanceResolver.resolveImage(instanceId);
    }
    throw new Error('InstanceProviderResolver not available — atomicStore is required for provider resolution');
  }

  public async resolveGroup(instanceId?: InstanceId): Promise<IContainerGroupProvider | undefined> {
    await this._ensureResolver();
    if (!this._instanceResolver) {
      throw new Error('InstanceProviderResolver not available — atomicStore is required for provider resolution');
    }
    return this._instanceResolver.resolveGroup(instanceId);
  }

  public async resolveRawEciApi(instanceId?: InstanceId): Promise<any | undefined> {
    await this._ensureResolver();
    if (this._instanceResolver && instanceId) {
      return this._instanceResolver.resolveRawEciApi(instanceId);
    }
    return this.rawEciApi;
  }

  public async resolveCrApi(instanceId?: InstanceId): Promise<any | undefined> {
    await this._ensureResolver();
    if (this._instanceResolver && instanceId) {
      return this._instanceResolver.resolveCrApi(instanceId);
    }
    return this.crApi;
  }

  public async resolveOssOpenApi(instanceId?: InstanceId): Promise<any | undefined> {
    await this._ensureResolver();
    if (this._instanceResolver && instanceId) {
      return this._instanceResolver.resolveOssOpenApi(instanceId);
    }
    return this.ossOpenApi;
  }

  // ─── Internal helpers ───

  private get _isAlibaba(): boolean {
    return this.config.container === 'alibaba' && this._hasAlibabaAccounts;
  }

  /** First valid Alibaba credential from config, or undefined if none configured. */
  private _firstAlibabaCred(): { accessKeyId: string; accessKeySecret: string } | undefined {
    const found = this.config.accounts.find(
      (a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret),
    );
    return found ? { accessKeyId: found.accessKeyId, accessKeySecret: found.accessKeySecret } : undefined;
  }

  private _resolveDefaultEntry(): ProviderEntry {
    if (this._isAlibaba) {
      return this._buildAlibabaDefaultEntry();
    }
    if (this.config.container === 'podman') {
      return this._buildPodmanEntry();
    }
    return this._buildStubEntry();
  }

  private _buildStubEntry(): ProviderEntry {
    return {
      name: 'stub',
      container: secureContainerProvider(new StubContainerProvider()),
      image: new StubImageProvider(),
    };
  }

  private _buildPodmanEntry(): ProviderEntry {
    const ep = process.env.PODMAN_ENDPOINT ?? 'http://127.0.0.1:8080';
    return {
      name: 'podman',
      container: secureContainerProvider(new PodmanContainerProvider(ep)),
      image: new PodmanImageProvider(ep),
    };
  }

  private _buildAlibabaDefaultEntry(): ProviderEntry {
    const accounts = this._buildAlibabaAccounts();
    return {
      name: 'alibaba',
      container: accounts[0]!.container,
      image: accounts[0]!.image,
    };
  }

  private _buildAlibabaAccounts(): { name: string; container: IContainerProvider; image: IImageProvider }[] {
    return this.config.accounts
      .filter((a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret))
      .map(a => ({
        name: a.name,
        container: secureContainerProvider(new AlibabaEciContainerProvider(a.accessKeyId, a.accessKeySecret, a.endpoint)),
        image: new AlibabaEciImageProvider(a.accessKeyId, a.accessKeySecret, a.endpoint,
          a.defaultRegion ?? this.config.region as string,
          a.extra?.registryCredentials as { server: string; userName: string; password: string }[] | undefined),
      }));
  }

  private _buildTypeEntries(): Map<string, ProviderEntry> {
    const entries = new Map<string, ProviderEntry>();
    entries.set('stub', this._buildStubEntry());
    entries.set('podman', this._buildPodmanEntry());
    const aliAccounts = this._buildAlibabaAccounts();
    if (aliAccounts.length > 0) {
      entries.set('alibaba', {
        name: 'alibaba' as const,
        container: aliAccounts[0]!.container,
        image: aliAccounts[0]!.image,
      });
    }
    return entries;
  }

  private _createGroupProvider(): IContainerGroupProvider | undefined {
    if (this._isAlibaba) {
      const defaultAccount = this.config.accounts.find(
        (a): a is Credential & { accessKeyId: string; accessKeySecret: string } => !!(a.accessKeyId && a.accessKeySecret),
      );
      if (defaultAccount) {
        return secureContainerGroupProvider(
          new AlibabaEciContainerGroupProvider(defaultAccount.accessKeyId, defaultAccount.accessKeySecret, defaultAccount.endpoint),
        );
      }
    }
    if (this.config.container === 'podman') {
      const ep = process.env.PODMAN_ENDPOINT ?? 'http://127.0.0.1:8080';
      return secureContainerGroupProvider(new PodmanContainerGroupProvider(ep));
    }
    return undefined;
  }
}

export function createProviderRegistry(
  config: ProviderConfig,
  s3Config?: S3Config,
  atomicStore?: IAtomicStore,
  secretEncryption?: SecretEncryption,
): IProviderRegistry {
  return new LazyProviderRegistry(config, s3Config, atomicStore, secretEncryption);
}
