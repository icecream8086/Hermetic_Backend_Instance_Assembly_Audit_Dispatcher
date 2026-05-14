import type { Facility, LogId, SerializedBody } from '../../brand.ts';

/**
 * Storage-layer write interface — only touches serialized data.
 */
export interface ILogStorageWriter {
  append(entry: LogStorageEntry): Promise<void>;
  appendBatch(entries: LogStorageEntry[]): Promise<void>;
}

/**
 * Storage-layer read interface.
 */
export interface ILogStorageReader {
  queryRange(
    facility: Facility,
    startTs: number,
    endTs: number,
    cursor?: string,
  ): Promise<{ items: LogStorageEntry[]; nextCursor?: string }>;
  getById(facility: Facility, id: LogId): Promise<LogStorageEntry | null>;
}

/**
 * Storage-layer admin interface.
 */
export interface ILogStorageAdmin {
  prune(beforeTs: number): Promise<number>;
}

export interface LogStorageEntry {
  facility: Facility;
  id: LogId;
  timestamp: number;
  body: SerializedBody;
}
