import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';

const ENDPOINT = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';

interface RawImage {
  Id: string; RepoTags?: string[]; Created?: number; Size?: number;
}
interface RawInspect {
  Id: string; RepoTags?: string[]; Created?: string; Size?: number;
  Architecture?: string; Os?: string; RootFS?: { Layers?: string[] };
}

/**
 * Podman image provider. When the Podman daemon is unreachable, list()
 * returns [] and other methods return null / no-op instead of throwing,
 * so the API returns empty results rather than 502 errors.
 */
export class PodmanImageProvider implements IImageProvider {
  readonly #ep: string;

  constructor(endpoint?: string) {
    this.#ep = endpoint ?? ENDPOINT;
  }

  async pull(image: string, _clusterId?: string): Promise<ImageInfo> {
    const [name, tag] = image.includes(':') ? image.split(':') : [image, 'latest'];
    const resp = await this.#fetch(`${this.#ep}/images/create?fromImage=${encodeURIComponent(name!)}&tag=${encodeURIComponent(tag!)}`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman pull failed (${resp.status}): ${await resp.text().catch(() => '')}`);
    return this.inspect(image).then(r => r!);
  }

  async list(options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    let url = `${this.#ep}/images/json`;
    if (options?.limit !== undefined || options?.offset !== undefined) {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      if (options.offset !== undefined) params.set('offset', String(options.offset));
      url += '?' + params.toString();
    }
    const resp = await this.#fetch(url);
    if (!resp) return [];
    if (!resp.ok) return [];
    const list: RawImage[] = await resp.json();
    return list.map(i => ({
      id: i.Id, tags: i.RepoTags ?? [],
      created: i.Created, size: i.Size,
    }));
  }

  async inspect(id: string): Promise<ImageInfo | null> {
    const resp = await this.#fetch(`${this.#ep}/images/${encodeURIComponent(id)}/json`);
    if (!resp) return null;
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const info: RawInspect = await resp.json();
    return {
      id: info.Id, tags: info.RepoTags ?? [],
      created: info.Created ? new Date(info.Created).getTime() : undefined,
      size: info.Size,
      architecture: info.Architecture, os: info.Os,
      layers: info.RootFS?.Layers?.length,
    };
  }

  async remove(id: string): Promise<void> {
    const resp = await this.#fetch(`${this.#ep}/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp) return;
    if (resp.status === 404) return;
    if (!resp.ok) throw new Error(`Podman remove failed: ${resp.status}`);
  }

  /** Fetch with connection error protection. Returns null when Podman is down. */
  async #fetch(url: string, init?: RequestInit): Promise<Response | null> {
    try {
      return await fetch(url, init);
    } catch {
      return null;
    }
  }
}
