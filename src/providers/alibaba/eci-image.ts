import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';
import { rpcCall } from './eci-signer.ts';
import { AppError } from '../../core/types.ts';

/** Parse an image reference like "nginx:latest" or "registry:5000/repo:tag"
 *  or "sha256:abc123..." into name and tag.
 *  sha256 digest format is treated as a complete image ID, not name:tag. */
function parseImageRef(image: string): { name: string; tag: string } {
  // sha256 digest — use whole string as image ID
  if (image.startsWith('sha256:')) {
    return { name: image, tag: '' };
  }
  const lastColon = image.lastIndexOf(':');
  const lastSlash = image.lastIndexOf('/');
  // If there's a colon after the last slash, it's a tag separator
  if (lastColon > lastSlash) {
    return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  }
  return { name: image, tag: 'latest' };
}

export class AlibabaEciImageProvider implements IImageProvider {
  public constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
    private readonly region = 'cn-hangzhou',
    private readonly registryCredentials?: { server: string; userName: string; password: string }[],
  ) {}

  public async pull(image: string, registryCredentialOrClusterId?: { server: string; userName: string; password: string } | string): Promise<ImageInfo> {
    const { name } = parseImageRef(image);
    const params: Record<string, string | undefined> = {
      RegionId: this.region,
      Image: image,
      ImageCacheName: `cache-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(Date.now())}`,
    };

    // Build registry credentials list
    const regCred = registryCredentialOrClusterId && typeof registryCredentialOrClusterId === 'object' ? registryCredentialOrClusterId : undefined;
    const creds = regCred ? [regCred] : (this.registryCredentials ?? []);
    if (creds.length > 0) {
      creds.forEach((c, i) => {
        params[`ImageRegistryCredential.${String(i + 1)}.Server`] = c.server;
        params[`ImageRegistryCredential.${String(i + 1)}.UserName`] = c.userName;
        params[`ImageRegistryCredential.${String(i + 1)}.Password`] = c.password;
      });
    }

    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateImageCache', params);

    // Poll until the image cache is ready (ECI is async)
    const cacheId: string = resp.ImageCacheId ?? '';
    if (!cacheId) throw new Error('CreateImageCache returned no ImageCacheId');

    // Return immediately — the cache will be ready later
    return {
      id: cacheId,
      tags: [image],
      created: Date.now(),
    };
  }

  public async list(options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    try {
      const params: Record<string, string | undefined> = {
        RegionId: this.region,
      };
      if (options?.limit) params.MaxResults = String(options.limit);
      // Note: Alibaba uses NextToken for offset-style pagination. For simplicity
      // here we pass limit only. Full next-token iteration would require state.
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeImageCaches', params);
      const caches: any[] = resp.ImageCaches ?? [];
      return caches.map((c: any) => ({
        id: c.ImageCacheId ?? '',
        tags: c.Images ?? [],
        created: c.CreationTime ? new Date(c.CreationTime).getTime() : undefined,
        size: c.FlashSize ?? c.Size ?? undefined,
      }));
    } catch (_e) {
      return [];
    }
  }

  public async inspect(id: string): Promise<ImageInfo | null> {
    try {
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeImageCaches', {
        RegionId: this.region,
        ImageCacheId: id,
      });
      const caches: any[] = resp.ImageCaches ?? [];
      if (!caches.length) return null;
      const c = caches[0]!;
      return {
        id: c.ImageCacheId ?? '',
        tags: c.Images ?? [],
        created: c.CreationTime ? new Date(c.CreationTime).getTime() : undefined,
        size: c.FlashSize ?? c.Size ?? undefined,
      };
    } catch {
      return null;
    }
  }

  public async remove(id: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteImageCache', {
      RegionId: this.region,
      ImageCacheId: id,
    });
  }

  // ─── ECI-unsupported operations ───

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async push(_imageOrId: string): Promise<ImageInfo> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'push is not supported by Alibaba ECI');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async search(_term: string): Promise<readonly { name: string; description?: string; isOfficial?: boolean }[]> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'search is not supported by Alibaba ECI');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async tag(_id: string, _tag: string): Promise<void> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'tag is not supported by Alibaba ECI');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async history(_id: string): Promise<readonly { id: string; created?: number; createdBy?: string; size?: number }[]> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'history is not supported by Alibaba ECI');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async prune(): Promise<{ reclaimed: number }> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'prune is not supported by Alibaba ECI');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async build(_context: unknown): Promise<ImageInfo> {
    throw new AppError(501, 'NOT_IMPLEMENTED', 'build is not supported by Alibaba ECI');
  }
}
