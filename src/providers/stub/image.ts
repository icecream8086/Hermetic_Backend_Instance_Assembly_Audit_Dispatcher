/* eslint-disable @typescript-eslint/require-await -- stub/noop implementation */
import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';

export class StubImageProvider implements IImageProvider {
  private images = new Map<string, ImageInfo>();

  public async pull(image: string, _clusterId?: string): Promise<ImageInfo> {
    const id = `sha256:${Array(64).fill(0).map(() => Math.random().toString(16)[2]).join('')}`;
    const info: ImageInfo = { id, tags: [image], created: Date.now(), size: 1024 * 1024 * 100 };
    this.images.set(image, info);
    this.images.set(id, info);
    return info;
  }

  public async list(_options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    return [...this.images.values()];
  }

  public async inspect(id: string): Promise<ImageInfo | null> {
    return this.images.get(id) ?? null;
  }

  public async remove(id: string): Promise<void> {
    this.images.delete(id);
    for (const [k, v] of this.images) {
      if (v.id === id || v.tags.includes(id)) this.images.delete(k);
    }
  }

  public async push(imageOrId: string): Promise<ImageInfo> {
    const info = await this.inspect(imageOrId);
    if (!info) throw new Error(`Image ${imageOrId} not found`);
    return info;
  }

  public async search(term: string): Promise<readonly { name: string; description?: string; isOfficial?: boolean }[]> {
    return [{ name: `library/${term}`, description: `Stub ${term} image`, isOfficial: true }];
  }

  public async tag(id: string, tag: string): Promise<void> {
    const info = await this.inspect(id);
    if (!info) throw new Error(`Image ${id} not found`);
    const tagged = { ...info, tags: [...info.tags, tag] };
    this.images.set(tag, tagged);
    this.images.set(info.id, tagged);
  }

  public async history(id: string): Promise<readonly { id: string; created?: number | undefined; createdBy?: string | undefined; size?: number | undefined }[]> {
    const info = await this.inspect(id);
    if (!info) throw new Error(`Image ${id} not found`);
    return [{ id: info.id, ...(info.created ? { created: info.created } : {}), createdBy: '/bin/sh -c #(nop) CMD', ...(info.size ? { size: info.size } : {}) }];
  }

  public async prune(): Promise<{ reclaimed: number }> {
    return { reclaimed: 0 };
  }

  public async build(_context: unknown, options?: { dockerfile?: string; tag?: string }): Promise<ImageInfo> {
    const tag = options?.tag ?? 'dockerfile:latest';
    return this.pull(tag);
  }
}
