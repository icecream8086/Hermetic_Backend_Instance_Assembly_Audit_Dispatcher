import type { IBlobStore } from '../../core/store/interfaces.ts';
import { formatDmesgLine } from '../../core/utils/dmesg.ts';

const LOG_PREFIX = 'action:logs:';

/**
 * Append a log line to a job run's log stream.
 *
 * Logs are stored as segments in IBlobStore (R2), one per step per job.
 * This keeps the atomic store clean and allows large log volumes.
 *
 * Uses dmesg format for consistency with the rest of the system:
 *   [uptime.usecs] facility: message
 */
export async function appendStepLog(
  blob: IBlobStore,
  jobRunId: string,
  stepName: string,
  line: string,
): Promise<void> {
  const segKey = `${LOG_PREFIX}${jobRunId}/${sanitizeSegment(stepName)}`;
  const ts = formatDmesgLine(line);

  // Append to existing segment
  const existing = await blob.get(segKey);
  const encoder = new TextEncoder();
  const newLine = encoder.encode(ts + '\n');

  if (existing) {
    // Merge: read existing + new line
    const chunks: Uint8Array[] = [];
    const reader = existing.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = new Uint8Array(
      chunks.reduce((s, c) => s + c.byteLength, 0) + newLine.byteLength,
    );
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
    merged.set(newLine, offset);
    await blob.put(segKey, merged.buffer, {
      contentType: 'text/plain; charset=utf-8',
      contentLength: merged.byteLength,
    });
  } else {
    await blob.put(segKey, newLine.buffer, {
      contentType: 'text/plain; charset=utf-8',
      contentLength: newLine.byteLength,
    });
  }
}

/**
 * Read log segments for a job run.
 * Returns concatenated log text with optional offset/limit for pagination.
 */
export async function readStepLogs(
  blob: IBlobStore,
  jobRunId: string,
  stepName: string,
  offset = 0,
  limit?: number,
): Promise<{ text: string; totalBytes: number; offset: number; limit: number }> {
  const segKey = `${LOG_PREFIX}${jobRunId}/${sanitizeSegment(stepName)}`;
  const existing = await blob.get(segKey);

  if (!existing) {
    return { text: '', totalBytes: 0, offset: 0, limit: limit ?? 0 };
  }

  // Read full content
  const chunks: Uint8Array[] = [];
  const reader = existing.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalSize = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(totalSize);
  let pos = 0;
  for (const c of chunks) { merged.set(c, pos); pos += c.byteLength; }

  const decoder = new TextDecoder();
  const full = decoder.decode(merged);

  // Apply offset/limit
  const lines = full.split('\n');
  const actualLimit = limit ?? lines.length;
  const sliced = lines.slice(offset, offset + actualLimit);

  return {
    text: sliced.join('\n'),
    totalBytes: totalSize,
    offset,
    limit: actualLimit,
  };
}

/**
 * List all step log segments for a job run.
 */
/** @internal — enumerate step segments from known step names (used by API). */
export function listJobLogSegments(
  stepNames: readonly string[],
): { stepName: string; sizeBytes: number }[] {
  return stepNames.map(s => ({ stepName: s, sizeBytes: 0 }));
}

function sanitizeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}
