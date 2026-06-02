import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';

export class StubImageProvider implements IImageProvider {
  private images = new Map<string, ImageInfo>();

  async pull(image: string): Promise<ImageInfo> {
    const id = `sha256:${Array(64).fill(0).map(() => Math.random().toString(16)[2]).join('')}`;
    const info: ImageInfo = { id, tags: [image], created: Date.now(), size: 1024 * 1024 * 100 };
    this.images.set(image, info);
    this.images.set(id, info);
    return info;
  }

  async list(_options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    return [...this.images.values()];
  }

  async inspect(id: string): Promise<ImageInfo | null> {
    return this.images.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.images.delete(id);
    for (const [k, v] of this.images) {
      if (v.id === id || v.tags.includes(id)) this.images.delete(k);
    }
  }
}
