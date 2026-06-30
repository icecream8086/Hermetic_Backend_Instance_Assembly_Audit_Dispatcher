import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IBlobStore, BlobMetadata } from '../interfaces.ts';

/**
 * Local file-based blob store for Node.js development.
 * Each blob is stored as a file under `basePath/blob/`.
 */
export class FileBlobStore implements IBlobStore {
  #dataDir: string;

  public constructor(basePath: string) {
    this.#dataDir = resolve(basePath, 'blob');
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dataDir, { recursive: true });
  }

  #filePath(key: string): string {
    const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.#dataDir, safe);
  }

  public async put(key: string, body: ReadableStream | ArrayBuffer, _metadata?: BlobMetadata): Promise<void> {
    await this.#ensureDir();
    const fp = this.#filePath(key);

    // Handle ArrayBuffer, Buffer (Uint8Array), and other binary types
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(fp, body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    } else {
      // ReadableStream → write to file
      const chunks: Uint8Array[] = [];
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(fp, buf);
    }
  }

  public async get(key: string): Promise<ReadableStream | null> {
    await this.#ensureDir();
    try {
      const fp = this.#filePath(key);
      await stat(fp);
      // Node.js Readable → Web ReadableStream
      const nodeStream = createReadStream(fp);
      return Readable.toWeb(nodeStream) as ReadableStream;
    } catch {
      return null;
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await unlink(this.#filePath(key));
    } catch {
      // file doesn't exist — ok
    }
  }
}
