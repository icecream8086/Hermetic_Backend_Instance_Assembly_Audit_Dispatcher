import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileBlobStore } from '../../../../src/core/store/adapters/file-blob.ts';

// ─── White-box helpers ───

function blobDir(dataDir: string): string {
  return join(dataDir, 'blob');
}

function blobFile(dataDir: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(blobDir(dataDir), safe);
}

function listBlobs(dataDir: string): string[] {
  const dir = blobDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

describe('FileBlobStore (white-box)', () => {
  let dataDir: string;
  let store: FileBlobStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'file-blob-test-'));
    store = new FileBlobStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ─── put / get / delete ───

  describe('put / get / delete', () => {
    it('put stores buffer content to disk (white-box: file exists with correct content)', async () => {
      const buf = Buffer.from('hello blob', 'utf-8');
      await store.put('my-blob', buf);

      // White-box: check the file on disk
      const fp = blobFile(dataDir, 'my-blob');
      expect(existsSync(fp)).toBe(true);
      expect(readFileSync(fp, 'utf-8')).toBe('hello blob');
    });

    it('put creates the blob directory on first write', async () => {
      expect(existsSync(blobDir(dataDir))).toBe(false);

      await store.put('first', Buffer.from('data'));

      expect(existsSync(blobDir(dataDir))).toBe(true);
    });

    it('get returns null for non-existent key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('get retrieves a previously stored blob', async () => {
      await store.put('key', Buffer.from('stored content'));

      const stream = await store.get('key');
      expect(stream).not.toBeNull();

      // Read the stream to verify content
      const reader = stream!.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const content = Buffer.concat(chunks).toString('utf-8');
      expect(content).toBe('stored content');
    });

    it('delete removes the file from disk (white-box: file gone)', async () => {
      await store.put('delete-me', Buffer.from('bye'));
      expect(existsSync(blobFile(dataDir, 'delete-me'))).toBe(true);

      await store.delete('delete-me');

      expect(existsSync(blobFile(dataDir, 'delete-me'))).toBe(false);
    });

    it('delete on non-existent key does not throw', async () => {
      await expect(store.delete('never-existed')).resolves.toBeUndefined();
    });

    it('overwriting a key replaces the file content', async () => {
      await store.put('key', Buffer.from('version1'));
      await store.put('key', Buffer.from('version2'));

      const content = readFileSync(blobFile(dataDir, 'key'), 'utf-8');
      expect(content).toBe('version2');

      // White-box: only one file exists for the key
      const files = listBlobs(dataDir).filter(f => f.startsWith('key'));
      expect(files).toHaveLength(1);
    });
  });

  // ─── ReadableStream input ───

  describe('ReadableStream input', () => {
    it('put accepts a ReadableStream', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('stream'));
          controller.enqueue(encoder.encode('ing'));
          controller.close();
        },
      });

      await store.put('stream-blob', stream);

      // White-box: file contains concatenated chunks
      const content = readFileSync(blobFile(dataDir, 'stream-blob'), 'utf-8');
      expect(content).toBe('streaming');
    });
  });

  // ─── Key sanitisation (white-box: file names) ───

  describe('key sanitisation (white-box: file names on disk)', () => {
    it('sanitises special characters to underscores', async () => {
      await store.put('path/to/blob:1', Buffer.from('data'));
      const files = listBlobs(dataDir);
      expect(files.some(f => f.includes('path_to_blob_1'))).toBe(true);
    });

    it('alphanumeric and dot keys pass through', async () => {
      await store.put('archive.tar.gz', Buffer.from('data'));
      const files = listBlobs(dataDir);
      expect(files).toContain('archive.tar.gz');
    });
  });

  // ─── get returns null for non-existent before any write ───

  describe('edge cases', () => {
    it('get returns null before any put call', async () => {
      const result = await store.get('anything');
      expect(result).toBeNull();
    });

    it('round-trips binary content correctly', async () => {
      const binary = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80, 0x7F]);
      await store.put('bin', binary);

      const stream = await store.get('bin');
      const reader = stream!.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      expect(Buffer.concat(chunks)).toEqual(binary);
    });

    it('handles empty buffer', async () => {
      await store.put('empty', Buffer.alloc(0));
      const content = readFileSync(blobFile(dataDir, 'empty'));
      expect(content).toHaveLength(0);
    });

    it('BlobMetadata is accepted but not persisted to the file system', async () => {
      await store.put('meta', Buffer.from('data'), {
        contentType: 'text/plain',
        contentLength: 4,
        custom: { source: 'test' },
      });

      // File content should be just the raw data (no metadata)
      const content = readFileSync(blobFile(dataDir, 'meta'));
      expect(content.toString()).toBe('data');
    });
  });
});
