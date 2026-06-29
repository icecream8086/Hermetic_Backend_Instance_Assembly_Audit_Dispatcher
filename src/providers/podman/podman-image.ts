import type { IImageProvider, ImageInfo, ListImagesOptions } from '../../core/provider/interfaces.ts';

const ENDPOINT = process.env.PODMAN_ENDPOINT ?? 'http://127.0.0.1:8080';

interface RawImage {
  Id: string; RepoTags?: string[]; Created?: number; Size?: number;
}
interface RawInspect {
  Id: string; RepoTags?: string[]; Created?: string; Size?: number;
  Architecture?: string; Os?: string; RootFS?: { Layers?: string[] };
}
interface RawHistory {
  Id: string; Created?: number; CreatedBy?: string; Size?: number;
}
interface RawSearchItem {
  Name: string; Description?: string; IsOfficial?: boolean;
}

/**
 * Podman image provider. When the Podman daemon is unreachable, list()
 * returns [] and other methods return null / no-op instead of throwing,
 * so the API returns empty results rather than 502 errors.
 */
export class PodmanImageProvider implements IImageProvider {
  readonly #apiBase: string;

  public constructor(endpoint?: string) {
    const ep = endpoint ?? ENDPOINT;
    this.#apiBase = `${ep}/v1.24`;
  }

  public async pull(image: string, _clusterId?: string): Promise<ImageInfo> {
    // sha256 digest — pull by digest, not name:tag
    let url: string;
    if (image.startsWith('sha256:')) {
      url = `${this.#apiBase}/images/create?fromImage=${encodeURIComponent(image)}`;
    } else {
      const [name, tag] = image.includes(':') ? image.split(':') : [image, 'latest'];
      url = `${this.#apiBase}/images/create?fromImage=${encodeURIComponent(name!)}&tag=${encodeURIComponent(tag!)}`;
    }
    const resp = await this.#fetch(url, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman pull failed (${String(resp.status)}):${await resp.text().catch(() => '')}`);
    return this.inspect(image).then(r => r!);
  }

  public async list(options?: ListImagesOptions): Promise<readonly ImageInfo[]> {
    let url = `${this.#apiBase}/images/json`;
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

  public async inspect(id: string): Promise<ImageInfo | null> {
    const resp = await this.#fetch(`${this.#apiBase}/images/${encodeURIComponent(id)}/json`);
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

  public async remove(id: string): Promise<void> {
    const resp = await this.#fetch(`${this.#apiBase}/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp) return;
    if (resp.status === 404) return;
    if (!resp.ok) throw new Error(`Podman remove failed: ${String(resp.status)}`);
  }

  public async push(imageOrId: string): Promise<ImageInfo> {
    const resp = await this.#fetch(`${this.#apiBase}/images/${encodeURIComponent(imageOrId)}/push`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman push failed (${String(resp.status)}):${await resp.text().catch(() => '')}`);
    return this.inspect(imageOrId).then(r => r!);
  }

  public async search(term: string): Promise<readonly { name: string; description?: string | undefined; isOfficial?: boolean | undefined }[]> {
    const resp = await this.#fetch(`${this.#apiBase}/images/search?term=${encodeURIComponent(term)}`);
    if (!resp) return [];
    if (!resp.ok) return [];
    const list: RawSearchItem[] = await resp.json();
    return list.map(i => ({ name: i.Name, ...(i.Description ? { description: i.Description } : {}), ...(i.IsOfficial !== undefined ? { isOfficial: i.IsOfficial } : {}) }));
  }

  public async tag(id: string, tag: string): Promise<void> {
    const [repo, t] = tag.includes(':') ? tag.split(':') : [tag, 'latest'];
    const resp = await this.#fetch(`${this.#apiBase}/images/${encodeURIComponent(id)}/tag?repo=${encodeURIComponent(repo!)}&tag=${encodeURIComponent(t!)}`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman tag failed (${String(resp.status)})`);
  }

  public async history(id: string): Promise<readonly { id: string; created?: number | undefined; createdBy?: string | undefined; size?: number | undefined }[]> {
    const resp = await this.#fetch(`${this.#apiBase}/images/${encodeURIComponent(id)}/history`);
    if (!resp) return [];
    if (!resp.ok) return [];
    const list: RawHistory[] = await resp.json();
    return list.map(h => ({ id: h.Id, ...(h.Created !== undefined ? { created: h.Created } : {}), ...(h.CreatedBy ? { createdBy: h.CreatedBy } : {}), ...(h.Size !== undefined ? { size: h.Size } : {}) }));
  }

  public async prune(): Promise<{ reclaimed: number }> {
    const resp = await this.#fetch(`${this.#apiBase}/images/prune`, { method: 'POST' });
    if (!resp) return { reclaimed: 0 };
    if (!resp.ok) return { reclaimed: 0 };
    const data = await resp.json();
    return { reclaimed: data.reclaimed ?? 0 };
  }

  public async build(_context: unknown, options?: { dockerfile?: string; tag?: string }): Promise<ImageInfo> {
    const params = new URLSearchParams();
    if (options?.dockerfile) params.set('dockerfile', options.dockerfile);
    if (options?.tag) params.set('t', options.tag);
    const query = params.toString() ? '?' + params.toString() : '';
    const resp = await this.#fetch(`${this.#apiBase}/build${query}`, { method: 'POST' });
    if (!resp) throw new Error('Podman daemon unreachable');
    if (!resp.ok) throw new Error(`Podman build failed (${String(resp.status)}):${await resp.text().catch(() => '')}`);
    // build returns a stream — resolve the image from the tag
    if (options?.tag) {
      return this.inspect(options.tag).then(r => r ?? this.inspect(options.tag!.split(':')[0]!).then(r2 => r2!));
    }
    // No tag provided, find the newest image
    const all = await this.list();
    return all[all.length - 1] ?? { id: 'unknown', tags: [] };
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
