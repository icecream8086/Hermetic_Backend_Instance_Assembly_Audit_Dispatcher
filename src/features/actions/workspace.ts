import type { IBlobStore } from '../../core/store/interfaces.ts';

const { parse: parseJson } = JSON;
const WS_PREFIX = 'action:workspace:';

/**
 * Workspace metadata stored alongside the archive.
 *
 * Extensibility: the ArchiveFormat type allows adding new compression
 * or transfer methods without changing the API.
 */
export type ArchiveFormat = 'tar' | 'tar.gz' | 'raw';

export interface WorkspaceMeta {
  readonly workflowRunId: string;
  readonly jobName: string;
  readonly format: ArchiveFormat;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly createdAt: number;
}

/**
 * Workspace sharing service — transfers working directories between
 * jobs in the same workflow via IBlobStore (R2 / file-blob).
 *
 * Pattern:
 *   Job A: share → snapshot working dir → upload to R2
 *   Job B: restore → download from R2 → extract to working dir
 *
 * Extensibility: the IWorkspaceStore interface allows swapping R2
 * for NFS, S3, or local filesystem without changing consumers.
 */
export interface IWorkspaceStore {
  // eslint-disable-next-line @typescript-eslint/no-restricted-types -- meta is WorkspaceMeta minus auto-populated fields, Omit avoids duplicating the type
  save(workflowRunId: string, jobName: string, data: Uint8Array, meta: Omit<WorkspaceMeta, 'workflowRunId' | 'jobName' | 'sizeBytes' | 'createdAt'>): Promise<WorkspaceMeta>;
  load(workflowRunId: string, jobName: string): Promise<{ data: Uint8Array; meta: WorkspaceMeta } | null>;
  list(workflowRunId: string): Promise<WorkspaceMeta[]>;
}

export class BlobWorkspaceStore implements IWorkspaceStore {
  public constructor(private readonly blob: IBlobStore) {}

  public async save(
    workflowRunId: string,
    jobName: string,
    data: Uint8Array,
    // eslint-disable-next-line @typescript-eslint/no-restricted-types -- meta is WorkspaceMeta minus auto-populated fields
    meta: Omit<WorkspaceMeta, 'workflowRunId' | 'jobName' | 'sizeBytes' | 'createdAt'>,
  ): Promise<WorkspaceMeta> {
    const key = `${WS_PREFIX}${workflowRunId}/${jobName}`;
    const now = Date.now();
    const wsMeta: WorkspaceMeta = {
      workflowRunId, jobName,
      format: meta.format,
      sizeBytes: data.byteLength,
      fileCount: meta.fileCount,
      createdAt: now,
    };

    // Store data + metadata as a JSON envelope
    const envelope = JSON.stringify({ meta: wsMeta, data: Array.from(data) });
    const encoded = new TextEncoder().encode(envelope);

    await this.blob.put(key, encoded.buffer, {
      contentType: 'application/json',
      contentLength: encoded.byteLength,
    });

    return wsMeta;
  }

  public async load(workflowRunId: string, jobName: string): Promise<{ data: Uint8Array; meta: WorkspaceMeta } | null> {
    const key = `${WS_PREFIX}${workflowRunId}/${jobName}`;
    const stream = await this.blob.get(key);
    if (!stream) return null;

    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }

    const text = new TextDecoder().decode(merged);
    const envelope = parseJson(text);
    return {
      data: new Uint8Array(envelope.data as number[]),
      meta: envelope.meta as WorkspaceMeta,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface contract requires Promise<T>
  public async list(_workflowRunId: string): Promise<WorkspaceMeta[]> {
    // IBlobStore has no list — callers track workspace keys via metadata
    return [];
  }
}
