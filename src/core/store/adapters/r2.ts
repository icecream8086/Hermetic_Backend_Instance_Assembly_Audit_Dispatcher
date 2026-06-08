/// <reference types="@cloudflare/workers-types" />

import type { IBlobStore, BlobMetadata } from '../interfaces.ts';

export class R2BlobStore implements IBlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, body: ReadableStream | ArrayBuffer, metadata?: BlobMetadata): Promise<void> {
    const options: Record<string, unknown> = {};
    if (metadata?.contentType) {
      options.httpMetadata = { contentType: metadata.contentType };
    }
    if (metadata?.custom) {
      options.customMetadata = metadata.custom;
    }
    await this.bucket.put(key, body, options as R2PutOptions);
  }

  async get(key: string): Promise<ReadableStream | null> {
    const obj = await this.bucket.get(key);
    return obj?.body ?? null;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
