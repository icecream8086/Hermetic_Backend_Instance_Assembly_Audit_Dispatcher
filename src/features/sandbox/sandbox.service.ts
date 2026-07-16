import type { PodSpec } from '../../core/pod/types.ts';
import type { SecretMountConfig } from '../../core/provider/types.ts';
import type { SecurityResourceService } from '../../core/security/service.ts';
import type { CreateSandboxInput, Sandbox } from './types.ts';

export class SandboxService {
  public constructor(
    private readonly securityService: SecurityResourceService,
  ) {}

  public async provision(input: CreateSandboxInput): Promise<Sandbox & { spec: PodSpec }> {
    const { token, expiresAt } = await this.securityService.issueToken(
      input.securityResourceNames,
      input.podId,
    );

    const spec = this.toPodSpec(input.spec, token);

    return {
      podId: input.podId,
      storageAccess: { token, expiresAt },
      createdAt: new Date().toISOString(),
      spec,
    };
  }

  public toPodSpec(base: PodSpec, token: string): PodSpec {
    const mount: SecretMountConfig = {
      mountPath: '/run/secrets/s3/token',
      data: token,
    };
    return {
      ...base,
      spec: {
        ...base.spec,
        secretMounts: [...(base.spec.secretMounts ?? []), mount],
      },
    };
  }
}
