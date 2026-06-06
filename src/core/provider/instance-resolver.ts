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

export class InstanceProviderResolver {
  constructor(
    private readonly instanceService: InstanceService,
    private readonly credentialService: CredentialService,
  ) {}

  /** Resolve a container provider. If instanceId provided, uses that instance.
   *  Otherwise picks the first online instance with container capability. */
  async resolveContainer(instanceId?: InstanceId): Promise<IContainerProvider> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst) return this.#createContainerProvider(inst);
    }
    const all = await this.instanceService.resolveByCapability('container');
    if (all.length > 0) return this.#createContainerProvider(all[0]!);
    return secureContainerProvider(new StubContainerProvider());
  }

  /** Resolve an image provider. */
  async resolveImage(instanceId?: InstanceId): Promise<IImageProvider> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst?.capabilities.image) return this.#createImageProvider(inst);
    }
    const all = await this.instanceService.resolveByCapability('image');
    if (all.length > 0) return this.#createImageProvider(all[0]!);
    return new StubImageProvider();
  }

  /** Resolve a container group provider. */
  async resolveGroup(instanceId?: InstanceId): Promise<IContainerGroupProvider | undefined> {
    if (instanceId) {
      const inst = await this.instanceService.get(instanceId);
      if (inst?.capabilities.group) return this.#createGroupProvider(inst);
    }
    const all = await this.instanceService.resolveByCapability('group');
    if (all.length > 0) return this.#createGroupProvider(all[0]!);
    return undefined;
  }

  /** Resolve a specific instance and create its container provider. */
  async resolveContainerByInstance(instanceId: InstanceId): Promise<IContainerProvider | null> {
    const inst = await this.instanceService.get(instanceId);
    return inst ? this.#createContainerProvider(inst) : null;
  }

  /** Resolve a network policy provider for a specific instance. */
  async resolveNetworkPolicy(instanceId: InstanceId): Promise<INetworkPolicyProvider | undefined> {
    const inst = await this.instanceService.get(instanceId);
    if (!inst || !inst.capabilities.network) return undefined;
    return this.#createNetworkPolicyProvider(inst);
  }

  /** Resolve an S3 provider for a specific instance. */
  async resolveS3(instanceId: InstanceId): Promise<IS3Provider | undefined> {
    const inst = await this.instanceService.get(instanceId);
    if (!inst || !inst.capabilities.s3) return undefined;
    return this.#createS3Provider(inst);
  }

  // ─── Provider factory methods ───

  async #resolveCredential(credentialRef?: string): Promise<{
    type?: string | undefined;
    accessKeyId: string | undefined;
    accessKeySecret: string | undefined;
    token?: string | undefined;
    username?: string | undefined;
    password?: string | undefined;
    registryCredentials?: readonly RegistryCredential[] | undefined;
  }> {
    if (!credentialRef) return { accessKeyId: undefined, accessKeySecret: undefined };
    const cred = await this.credentialService.findByName(credentialRef);
    if (!cred) return { accessKeyId: undefined, accessKeySecret: undefined };
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

  async #createContainerProvider(instance: ComputeInstance): Promise<IContainerProvider> {
    switch (instance.platform) {
      case 'podman':
        return secureContainerProvider(new PodmanContainerProvider(instance.endpoint));
      case 'alibaba': {
        const cred = await this.#resolveCredential(instance.credentialRef);
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
        const cred = await this.#resolveCredential(instance.credentialRef);
        return new AlibabaEciImageProvider(
          cred.accessKeyId ?? '', cred.accessKeySecret ?? '', instance.endpoint,
          'cn-hangzhou',
          cred.registryCredentials as Array<{ server: string; userName: string; password: string }> | undefined,
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
        const cred = await this.#resolveCredential(instance.credentialRef);
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
    const cred = await this.#resolveCredential(instance.credentialRef);
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
}
