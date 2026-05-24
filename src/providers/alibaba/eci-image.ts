import type { IImageProvider, ImageInfo } from '../../core/provider/interfaces.ts';
import { rpcCall } from './eci-signer.ts';

export class AlibabaEciImageProvider implements IImageProvider {
  constructor(
    private readonly accessKeyId: string,
    private readonly accessKeySecret: string,
    private readonly endpoint = 'eci.cn-hangzhou.aliyuncs.com',
    private readonly region = 'cn-hangzhou',
  ) {}

  async pull(image: string): Promise<ImageInfo> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'CreateImageCache', {
      RegionId: this.region,
      Image: image,
      ImageCacheName: `cache-${Date.now()}`,
    });
    return {
      id: resp.ImageCacheId ?? '',
      tags: [image],
    };
  }

  async list(): Promise<readonly ImageInfo[]> {
    const resp = await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DescribeImageCaches', {
      RegionId: this.region,
    });
    const caches: any[] = resp.ImageCaches ?? [];
    return caches.map((c: any) => ({
      id: c.ImageCacheId ?? '',
      tags: c.Images ?? [],
      created: c.CreationTime ? new Date(c.CreationTime).getTime() : undefined,
      size: c.FlashSize ?? c.Size ?? undefined,
    })) as any;
  }

  async inspect(id: string): Promise<ImageInfo | null> {
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
  }

  async remove(id: string): Promise<void> {
    await rpcCall(this.endpoint, this.accessKeyId, this.accessKeySecret, 'DeleteImageCache', {
      RegionId: this.region,
      ImageCacheId: id,
    });
  }
}
