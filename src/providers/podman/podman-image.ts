import type { IImageProvider, ImageInfo } from '../../core/provider/interfaces.ts';

const ENDPOINT = process.env['PODMAN_ENDPOINT'] ?? 'http://127.0.0.1:8080';

interface RawImage {
  Id: string; RepoTags?: string[]; Created?: number; Size?: number;
}
interface RawInspect {
  Id: string; RepoTags?: string[]; Created?: string; Size?: number;
  Architecture?: string; Os?: string; RootFS?: { Layers?: string[] };
}

export class PodmanImageProvider implements IImageProvider {
  private ep: string;
  constructor(endpoint?: string) { this.ep = endpoint ?? ENDPOINT; }

  async pull(image: string): Promise<ImageInfo> {
    const [name, tag] = image.includes(':') ? image.split(':') : [image, 'latest'];
    const resp = await fetch(`${this.ep}/images/create?fromImage=${encodeURIComponent(name!)}&tag=${encodeURIComponent(tag!)}`, { method: 'POST' });
    if (!resp.ok) throw new Error(`Podman pull failed (${resp.status}): ${await resp.text().catch(() => '')}`);
    return this.inspect(image).then(r => r!);
  }

  async list(): Promise<readonly ImageInfo[]> {
    const resp = await fetch(`${this.ep}/images/json`);
    if (!resp.ok) throw new Error(`Podman list failed: ${resp.status}`);
    const list: RawImage[] = await resp.json();
    return list.map(i => ({
      id: i.Id, tags: i.RepoTags ?? [],
      created: i.Created, size: i.Size,
    }));
  }

  async inspect(id: string): Promise<ImageInfo | null> {
    const resp = await fetch(`${this.ep}/images/${encodeURIComponent(id)}/json`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Podman inspect failed: ${resp.status}`);
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
    const resp = await fetch(`${this.ep}/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (resp.status === 404) return;
    if (!resp.ok) throw new Error(`Podman remove failed: ${resp.status}`);
  }
}
