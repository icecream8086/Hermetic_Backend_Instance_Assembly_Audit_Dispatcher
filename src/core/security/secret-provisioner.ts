import type { IAtomicStore } from '../store/interfaces.ts';
import type { ContainerSecret, PlatformSecretRefs } from '../../features/container-secret/types.ts';

export type PlatformId = 'eci' | 'k8s' | 'podman' | 'aws';

export interface PlatformSecretBackend {
  readonly platform: PlatformId;
  /** 在平台原生 secret store 中创建/更新 secret。返回平台原生标识符。 */
  upsert(params: PlatformSecretParams): Promise<PlatformUpsertResult>;
  /** 从平台原生 secret store 中删除 secret。 */
  remove(platformRef: string): Promise<void>;
  /** 检查 secret 是否存在于平台原生 store 中。 */
  exists(platformRef: string): Promise<boolean>;
}

export interface PlatformSecretParams {
  readonly name: string;
  readonly data: Record<string, string>;
  readonly labels?: Record<string, string> | undefined;
}

export interface PlatformUpsertResult {
  readonly platformRef: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
}

export class SecretProvisioner {
  constructor(
    private readonly backends: readonly PlatformSecretBackend[],
    private readonly atomic: IAtomicStore,
  ) {}

  /** 同步单个 ContainerSecret 到所有注册的平台 */
  async provision(secret: ContainerSecret): Promise<PlatformSecretRefs> {
    const refs: PlatformSecretRefs = {};
    for (const backend of this.backends) {
      const result = await backend.upsert({
        name: secret.name,
        data: { value: secret.value ?? '' },
      });
      if (result.ok) {
        (refs as Record<string, string | undefined>)[backend.platform] = result.platformRef;
      }
    }
    return refs;
  }

  /** 从所有平台删除 */
  async deprovision(secret: ContainerSecret): Promise<void> {
    const refs = secret.platformRefs ?? {};
    for (const backend of this.backends) {
      const ref = (refs as Record<string, string | undefined>)[backend.platform];
      if (ref) {
        await backend.remove(ref).catch(() => {});
      }
    }
  }

  /** 全量对账 (event-loop tick 调用) */
  async syncAll(): Promise<void> {
    const idx = await this.atomic.get<string[]>('container-secret:ids');
    if (!idx?.value.length) return;
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<ContainerSecret>(`container-secret:${id}`)),
    );
    for (const e of entries) {
      if (e?.value?.type === 'platformRef') {
        await this.provision(e.value).catch(() => {});
      }
    }
  }

  /** 按名字查平台引用 */
  async resolve(secretName: string, platform: PlatformId): Promise<string | undefined> {
    const idx = await this.atomic.get<string[]>('container-secret:ids');
    if (!idx?.value.length) return undefined;
    const entries = await Promise.all(
      idx.value.map(id => this.atomic.get<ContainerSecret>(`container-secret:${id}`)),
    );
    const match = entries.find(e => e?.value?.name === secretName);
    const refs = match?.value?.platformRefs;
    if (!refs) return undefined;
    return (refs as Record<string, string | undefined>)[platform];
  }
}

// ─── ECI Backend（占位 — 始终返回 ok: false） ───

export class EciSecretBackend implements PlatformSecretBackend {
  readonly platform: PlatformId = 'eci';

  async upsert(_params: PlatformSecretParams): Promise<PlatformUpsertResult> {
    return { platformRef: '', ok: false, error: 'ECI standalone does not support native secret references' };
  }

  async remove(_platformRef: string): Promise<void> {
    // no-op
  }

  async exists(_platformRef: string): Promise<boolean> {
    return false;
  }
}
