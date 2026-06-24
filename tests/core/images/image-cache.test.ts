import { join } from 'node:path'; import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach } from 'vitest';
import { FileKVAtomicStore } from '../../../src/core/store/adapters/file-kv.ts';
import { ImageCacheTracker, DEFAULT_IMAGE_CACHE_CONFIG } from '../../../src/core/images/image-cache.ts';

function makeStore() { return new FileKVAtomicStore(join(tmpdir(), 'hbi-imgcache-' + crypto.randomUUID().slice(0, 8))); }

describe('ImageCacheTracker (GitHub Cache LRU model)', () => {
  let tracker: ImageCacheTracker;

  beforeEach(() => { tracker = new ImageCacheTracker(makeStore()); });

  it('records an image access', async () => {
    await tracker.recordAccess('sha256:abc', ['alpine:latest'], 5_000_000);
    const entry = await tracker.get('sha256:abc');
    expect(entry).not.toBeNull();
    expect(entry!.tags).toContain('alpine:latest');
    expect(entry!.sizeBytes).toBe(5_000_000);
    expect(entry!.pullCount).toBe(1);
  });

  it('increments pullCount on repeated access', async () => {
    await tracker.recordAccess('sha256:abc', ['alpine:latest'], 5_000_000);
    await tracker.recordAccess('sha256:abc', ['alpine:latest'], 5_000_000);
    const entry = await tracker.get('sha256:abc');
    expect(entry!.pullCount).toBe(2);
  });

  it('tracks total size', async () => {
    await tracker.recordAccess('img1', ['t1'], 1_000_000);
    await tracker.recordAccess('img2', ['t2'], 2_000_000);
    expect(await tracker.totalSize()).toBe(3_000_000);
  });

  it('adjusts total size when image size changes', async () => {
    await tracker.recordAccess('img1', ['t1'], 1_000_000);
    await tracker.recordAccess('img1', ['t1'], 3_000_000);
    expect(await tracker.totalSize()).toBe(3_000_000);
  });

  it('records removal and adjusts total size', async () => {
    await tracker.recordAccess('img1', ['t1'], 5_000_000);
    await tracker.recordAccess('img2', ['t2'], 3_000_000);
    await tracker.recordRemoval('img1');
    expect(await tracker.totalSize()).toBe(3_000_000);
    expect(await tracker.get('img1')).toBeNull();
  });

  it('touch updates lastAccessedAt', async () => {
    await tracker.recordAccess('img1', ['t1'], 1_000_000);
    const before = (await tracker.get('img1'))!.lastAccessedAt;
    await new Promise(r => setTimeout(r, 10));
    await tracker.touch('img1');
    const after = (await tracker.get('img1'))!.lastAccessedAt;
    expect(after).toBeGreaterThan(before);
  });

  it('lists entries sorted by last accessed (oldest first)', async () => {
    await tracker.recordAccess('img-a', ['a'], 1);
    await new Promise(r => setTimeout(r, 5));
    await tracker.recordAccess('img-b', ['b'], 1);
    await new Promise(r => setTimeout(r, 5));
    await tracker.recordAccess('img-c', ['c'], 1);

    const list = await tracker.listByLastAccess();
    expect(list[0]!.imageId).toBe('img-a');
    expect(list[2]!.imageId).toBe('img-c');
  });

  it('computeEvictions evicts when over capacity', async () => {
    const smallConfig = { maxTotalBytes: 100, maxAgeMs: 999_999_999 };
    const t = new ImageCacheTracker(makeStore(), smallConfig);
    await t.recordAccess('img-a', ['a'], 60);
    await t.recordAccess('img-b', ['b'], 60); // total = 120 > 100
    const result = await t.computeEvictions();
    expect(result.evicted.length).toBe(1); // oldest (img-a) evicted
    expect(result.evicted).toContain('img-a');
    expect(result.reclaimedBytes).toBe(60);
  });
});
