import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IBlobStore, BlobMetadata } from '../interfaces.ts';
import { z } from 'zod';

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

    // Handle ArrayBuffer
    let arrayBuffer: ArrayBuffer | undefined;
    try { arrayBuffer = z.instanceof(ArrayBuffer).parse(body); } catch (e) { console.debug("not ArrayBuffer", e); }
    if (arrayBuffer !== undefined) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(fp, Buffer.from(arrayBuffer));
      return;
    }

    // Handle Uint8Array / Buffer (Node.js)
    let uint8Array: Uint8Array | undefined;
    try { uint8Array = z.instanceof(Uint8Array).parse(body); } catch (e) { console.debug("not Uint8Array", e); }
    if (uint8Array !== undefined) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(fp, Buffer.from(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength));
      return;
    }

    // Handle ReadableStream
    const stream = z.instanceof(ReadableStream).parse(body);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(z.custom<Uint8Array>().parse(value));
    }
    const buf = Buffer.concat(chunks);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fp, buf);
  }

  public async get(key: string): Promise<ReadableStream | null> {
    await this.#ensureDir();
    let result: ReadableStream | null = null;
    try {
      const fp = this.#filePath(key);
      await stat(fp);
      const nodeStream = createReadStream(fp);
      result = z.custom<ReadableStream>().parse(Readable.toWeb(nodeStream));
    } catch (e) {
      console.debug("file not found", e);
    }
    return result;
  }

  public async delete(key: string): Promise<void> {
    try {
      await unlink(this.#filePath(key));
    } catch {

      console.debug("");

    }
  }
}
