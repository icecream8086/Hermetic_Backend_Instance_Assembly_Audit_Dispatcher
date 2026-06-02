import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';
import { rpcCall } from './eci-signer.ts';

/** Parse an image reference like "registry:5000/repo:tag" into name and tag. */
function parseImageRef(image: string): { name: string; tag: string } {
  const lastColon = image.lastIndexOf(':');
  const lastSlash = image.lastIndexOf('/');
  // If there's a colon after the last slash, it's a tag separator
  if (lastColon > lastSlash) {
    return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  }
  return { name: image, tag: 'latest' };
}

export class AlibabaEciImageProvider implements IImageProvider {
  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
    private readonly region = 'cn-hangzhou',
    private readonly registryCredentials?: Array<{ server: string; userName: string; password: string }>,
  ) {}

  async pull(image: string, registryCredential?: { server: string; userName: string; password: string }): Promise<ImageInfo> {
    const { name } = parseImageRef(image);
    const params: Record<string, string | undefined> = {
      RegionId: this.region,
      Image: image,
      ImageCacheName: `cache-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`,
    };

    // Build registry credentials list
    const creds = registryCredential ? [registryCredential] : (this.registryCredentials ?? []);
    if (creds.length > 0) {
      creds.forEach((c, i) => {
        params[`ImageRegistryCredential.${i + 1}.Server`] = c.server;
        params[`ImageRegistryCredential.${i + 1}.UserName`] = c.userName;
        params[`ImageRegistryCredential.${i + 1}.Password`] = c.password;
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

  async list(options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    try {
      const params: Record<string, string | undefined> = {
        RegionId: this.region,
      };
      if (options?.limit) params['MaxResults'] = String(options.limit);
      // Note: Alibaba uses NextToken for offset-style pagination. For simplicity
      // here we pass limit only. Full next-token iteration would require state.
      const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeImageCaches', params);
      const caches: any[] = resp.ImageCaches ?? [];
      return caches.map((c: any) => ({
        id: c.ImageCacheId ?? '',
        tags: c.Images ?? [],
        created: c.CreationTime ? new Date(c.CreationTime).getTime() : undefined,
        size: c.FlashSize ?? c.Size ?? undefined,
      })) as any;
    } catch (e) {
      return [];
    }
  }

  async inspect(id: string): Promise<ImageInfo | null> {
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

  async remove(id: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteImageCache', {
      RegionId: this.region,
      ImageCacheId: id,
    });
  }
}
