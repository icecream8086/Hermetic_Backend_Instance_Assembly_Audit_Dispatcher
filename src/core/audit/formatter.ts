import type { StoredAuditEntry } from './types.ts';
import type { SerializedBody } from '../brand.ts';
import { createSerializedBody } from '../brand.ts';

export interface ILogFormatter {
  serialize(entry: StoredAuditEntry): SerializedBody;
  deserialize(body: SerializedBody): StoredAuditEntry;
}

export class JsonLogFormatter implements ILogFormatter {
  serialize(entry: StoredAuditEntry): SerializedBody {
    return createSerializedBody(JSON.stringify(entry));
  }

  deserialize(body: SerializedBody): StoredAuditEntry {
    return JSON.parse(body) as StoredAuditEntry;
  }
}
