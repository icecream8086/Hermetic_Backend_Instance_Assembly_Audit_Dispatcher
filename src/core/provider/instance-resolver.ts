/**
 * InstanceProviderResolver — dynamically creates provider instances from
 * ComputeInstance entities. Replaces the old static provider singleton model.
 *
 * Flow:
 *   SandboxService.provision()
 *     → resolveContainer(clusterId)  // or instanceId
 *     → InstanceService.resolveByCluster() → picks online instance
 *     → #createContainerProvider(instance) → returns IContainerProvider
 *     → provider.create(input)
 */

import type { IContainerProvider, IContainerGroupProvider, IImageProvider, INetworkPolicyProvider } from './interfaces.ts';
import type { IS3Provider } from './s3.ts';
import type { ComputeInstance } from '../region/instance.ts';
import type { InstanceService, InstanceId } from '../region/instance.ts';
import type { CredentialService, RegistryCredential } from '../auth/credential.ts';
import { AppError } from '../types.ts';
import { CredentialResolutionError } from './errors.ts';
import { secureContainerProvider, secureContainerGroupProvider } from './security.ts';
import { PodmanContainerProvider } from '../../providers/podman/podman-provider.ts';
import { PodmanImageProvider } from '../../providers/podman/podman-image.ts';
import { PodmanContainerGroupProvider } from '../../providers/podman/podman-group-provider.ts';
import { PodmanNetworkPolicyProvider } from '../../providers/podman/podman-network.ts';
import { AlibabaEciContainerProvider } from '../../providers/alibaba/eci-container.ts';
import { AlibabaEciImageProvider } from '../../providers/alibaba/eci-image.ts';
import { AlibabaEciContainerGroupProvider } from '../../providers/alibaba/eci-group-provider.ts';
import { StubContainerProvider } from '../../providers/stub/container.ts';
import { StubImageProvider } from '../../providers/stub/image.ts';
import { AwsS3Provider } from '../../providers/s3/aws-s3.ts';
import { AlibabaOssProvider } from '../../providers/alibaba/oss.ts';
import { AlibabaEciApiClient } from '../../providers/alibaba/eci-api.ts';
import { AlibabaCrApiClient } from '../../providers/alibaba/cr-api.ts';
import { AlibabaOssOpenApiClient } from '../../providers/alibaba/oss-openapi.ts';

export class InstanceProviderResolver {
  public constructor(
    private readonly instanceService: InstanceService,
    private readonly credentialService: CredentialService,
  ) {}

  /** Resolve a container provider. If instanceId provided, uses that instance.
   *  Otherwise picks the first online instance with container capability. */
  public async resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst) return this.#createContainerProvider(inst);
      throw new AppError(404, 'INSTANCE_NOT_FOUND', `Container instance ${instanceId} not found`);
    }
    const all = await this.instanceService.resolveByCapability('container');
    if (all.length > 0) return this.#createContainerProvider(all[0]!);
    return secureContainerProvider(new StubContainerProvider());
  }

  /** Resolve an image provider. */
  public async resolveImage(instanceId?: InstanceId): Promise<IImageProvider> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst?.capabilities.image) return this.#createImageProvider(inst);
      throw new AppError(404, 'INSTANCE_NOT_FOUND', `Image instance ${instanceId} not found`);
    }
    const all = await this.instanceService.resolveByCapability('image');
    if (all.length > 0) return this.#createImageProvider(all[0]!);
    return new StubImageProvider();
  }

  /** Resolve a container group provider. */
  public async resolveGroup(instanceId?: InstanceId): Promise<IContainerGroupProvider | undefined> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst?.capabilities.group) return this.#createGroupProvider(inst);
      throw new AppError(404, 'INSTANCE_NOT_FOUND', `Group instance ${instanceId} not found or lacks group capability`);
    }
    const all = await this.instanceService.resolveByCapability('group');
    if (all.length > 0) return this.#createGroupProvider(all[0]!);
    return undefined;
  }

  /** Resolve a specific instance and create its container provider. */
  public async resolveContainerByInstance(instanceId: InstanceId): Promise<IContainerProvider | null> {
    const inst = await this.instanceService.get(instanceId);
    return inst ? this.#createContainerProvider(inst) : null;
  }

  /** Resolve a network policy provider for a specific instance. */
  public async resolveNetworkPolicy(instanceId: InstanceId): Promise<INetworkPolicyProvider | undefined> {
    const inst = await this.instanceService.get(instanceId);
    if (!inst?.capabilities.network) return undefined;
    return this.#createNetworkPolicyProvider(inst);
  }

  /** Resolve an S3 provider for a specific instance. */
  public async resolveS3(instanceId: InstanceId): Promise<IS3Provider | undefined> {
    const inst = await this.instanceService.get(instanceId);
    if (!inst?.capabilities.s3) return undefined;
    return this.#createS3Provider(inst);
  }

  // ─── Provider factory methods ───

  async #resolveCredential(credentialRef?: string, instanceId?: string): Promise<{
    type?: string | undefined;
    accessKeyId: string | undefined;
    accessKeySecret: string | undefined;
    token?: string | undefined;
    username?: string | undefined;
    password?: string | undefined;
    registryCredentials?: readonly RegistryCredential[] | undefined;
  }> {
    // 1. Try credential manager (preferred — per-instance, encrypted)
    if (credentialRef) {
      // credentialRef may be a credential ID (cred_xxx) or a name (eci_profile@...)
      const cred = await this.credentialService.get(credentialRef as any)
        ?? await this.credentialService.findByName(credentialRef, instanceId);
      if (cred?.accessKeyId && cred?.accessKeySecret) {
        return {
          type: cred.type,
          accessKeyId: cred.accessKeyId,
          accessKeySecret: cred.accessKeySecret,
          token: cred.token,
          username: cred.username,
          password: cred.password,
          registryCredentials: cred.registryCredentials,
        };
      }
      // credentialRef was explicitly configured but cannot be resolved — fail loudly
      throw new CredentialResolutionError(
        `Credential "${credentialRef}" not found or missing access keys for instance ${instanceId ?? 'unknown'}. Check that the credential exists and has ALIBABA_ACCESS_KEY_ID / ALIBABA_ACCESS_KEY_SECRET set.`,
        credentialRef,
        instanceId,
      );
    }
    // 2. Fallback to environment variables (backward compatible)
    const envAk = process.env.ALIBABA_ACCESS_KEY_ID;
    const envSk = process.env.ALIBABA_ACCESS_KEY_SECRET;
    if (envAk && envSk) {
      return { accessKeyId: envAk, accessKeySecret: envSk };
    }
    return { accessKeyId: undefined, accessKeySecret: undefined };
  }

  async #createContainerProvider(instance: ComputeInstance): Promise<IContainerProvider> {
    switch (instance.platform) {
      case 'podman':
        return secureContainerProvider(new PodmanContainerProvider(instance.endpoint));
      case 'alibaba': {
        const cred = await this.#resolveCredential(instance.credentialRef, instance.id);
        return secureContainerProvider(new AlibabaEciContainerProvider(
          cred.accessKeyId ?? '', cred.accessKeySecret ?? '', instance.endpoint,
        ));
      }
      case 'stub':
        return secureContainerProvider(new StubContainerProvider());
      default:
        return secureContainerProvider(new StubContainerProvider());
    }
  }

  async #createImageProvider(instance: ComputeInstance): Promise<IImageProvider> {
    switch (instance.platform) {
      case 'podman':
        return new PodmanImageProvider(instance.endpoint);
      case 'alibaba': {
        const cred = await this.#resolveCredential(instance.credentialRef, instance.id);
        return new AlibabaEciImageProvider(
          cred.accessKeyId ?? '', cred.accessKeySecret ?? '', instance.endpoint,
          instance.region,
          cred.registryCredentials as { server: string; userName: string; password: string }[] | undefined,
        );
      }
      case 'stub':
        return new StubImageProvider();
      default:
        return new StubImageProvider();
    }
  }

  async #createGroupProvider(instance: ComputeInstance): Promise<IContainerGroupProvider | undefined> {
    switch (instance.platform) {
      case 'podman':
        return secureContainerGroupProvider(new PodmanContainerGroupProvider(instance.endpoint));
      case 'alibaba': {
        const cred = await this.#resolveCredential(instance.credentialRef, instance.id);
        return secureContainerGroupProvider(new AlibabaEciContainerGroupProvider(
          cred.accessKeyId ?? '', cred.accessKeySecret ?? '', instance.endpoint,
        ));
      }
      default:
        return undefined;
    }
  }

  async #createNetworkPolicyProvider(instance: ComputeInstance): Promise<INetworkPolicyProvider | undefined> {
    switch (instance.platform) {
      case 'podman':
        return new PodmanNetworkPolicyProvider(instance.endpoint);
      case 'alibaba':
        // Alibaba SecurityGroup-based network policy — not yet implemented
        return undefined;
      default:
        return undefined;
    }
  }

  async #createS3Provider(instance: ComputeInstance): Promise<IS3Provider | undefined> {
    const cred = await this.#resolveCredential(instance.credentialRef, instance.id);
    switch (instance.platform) {
      case 'podman':
        // Podman has no native S3 — MinIO-compatible endpoint via AwsS3Provider
        return cred.accessKeyId && cred.accessKeySecret
          ? new AwsS3Provider({ accessKeyId: cred.accessKeyId, secretAccessKey: cred.accessKeySecret }, 'auto', instance.endpoint)
          : undefined;
      case 'alibaba':
        return cred.accessKeyId && cred.accessKeySecret
          ? new AlibabaOssProvider(cred.accessKeyId, cred.accessKeySecret, instance.endpoint)
          : undefined;
      case 'stub':
        return undefined;
      default:
        return undefined;
    }
  }

  /** Resolve a raw ECI API client for a specific instance. */
  public async resolveRawEciApi(instanceId: InstanceId): Promise<any> {
    const inst = await this.instanceService.get(instanceId);
    if (inst?.platform !== 'alibaba') return undefined;
    const cred = await this.#resolveCredential(inst.credentialRef);
    if (!cred.accessKeyId || !cred.accessKeySecret) return undefined;
    return new AlibabaEciApiClient(cred.accessKeyId, cred.accessKeySecret, inst.endpoint);
  }

  /** Resolve a CR (Container Registry) API client for a specific instance. */
  public async resolveCrApi(instanceId: InstanceId): Promise<any> {
    const inst = await this.instanceService.get(instanceId);
    if (inst?.platform !== 'alibaba') return undefined;
    const cred = await this.#resolveCredential(inst.credentialRef);
    if (!cred.accessKeyId || !cred.accessKeySecret) return undefined;
    return new AlibabaCrApiClient(cred.accessKeyId, cred.accessKeySecret);
  }

  /** Resolve an OSS management-plane API client for a specific instance. */
  public async resolveOssOpenApi(instanceId: InstanceId): Promise<any> {
    const inst = await this.instanceService.get(instanceId);
    if (inst?.platform !== 'alibaba') return undefined;
    const cred = await this.#resolveCredential(inst.credentialRef);
    if (!cred.accessKeyId || !cred.accessKeySecret) return undefined;
    return new AlibabaOssOpenApiClient(cred.accessKeyId, cred.accessKeySecret);
  }
}
